"use strict";

const fs = require("node:fs/promises");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { ASSET_POLICIES } = require("./constants");
const { BrokerError } = require("./errors");

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const MAX_ZIP_ENTRIES = 2048;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_NAME_BYTES = 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_CONTROL_XML_BYTES = 2 * 1024 * 1024;
const MAX_DOCX_CONTROL_XML_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_OPC_XML_ELEMENTS = 10000;
const MAX_OPC_XML_ATTRIBUTES = 128;
const MAX_COMPRESSION_RATIO = 200;
const MAX_PREVIEW_PARAGRAPHS = 40;
const MAX_PREVIEW_CHARACTERS = 8000;
const MAX_PREVIEW_PARAGRAPH_CHARACTERS = 1000;
const STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_PDF_TAIL_BYTES = 1024 * 1024;
const MAX_PDF_XREF_BYTES = 8 * 1024 * 1024;
const MAX_CONTAINER_RECORDS = 100000;

const REQUIRED_DOCX_ENTRIES = Object.freeze([
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml"
]);

const OPC_CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const OPC_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function brokerFailure(code, publicMessage, cause) {
  return new BrokerError(code, 422, publicMessage, {
    cause,
    markUploadFailed: true
  });
}

function fail(code, publicMessage, cause) {
  throw brokerFailure(code, publicMessage, cause);
}

async function readExactly(file, position, length, code) {
  if (!Number.isSafeInteger(position) || position < 0 ||
      !Number.isSafeInteger(length) || length < 0) {
    fail(code, "The uploaded file has invalid internal offsets");
  }

  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await file.read(
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead
    );
    if (result.bytesRead === 0) {
      fail(code, "The uploaded file ended unexpectedly");
    }
    bytesRead += result.bytesRead;
  }
  return buffer;
}

function validateReservationFormat(reservation) {
  const assetType = reservation && typeof reservation.assetType === "string"
    ? reservation.assetType
    : "";
  const extension = reservation && typeof reservation.extension === "string"
    ? reservation.extension.toLowerCase()
    : "";
  const policy = ASSET_POLICIES[assetType];

  if (!policy || !Object.prototype.hasOwnProperty.call(policy.formats, extension)) {
    fail(
      "FILE_SIGNATURE_INVALID",
      "The file type does not match the reserved asset type"
    );
  }

  return { assetType, extension };
}

function baseInspection(assetType, extension, actualBytes, format, options = {}) {
  return {
    schemaVersion: 1,
    assetType,
    extension,
    format,
    actualBytes,
    signatureValid: true,
    needsManualStructure: Boolean(options.needsManualStructure),
    metadata: options.metadata || {}
  };
}

function decodePdfName(name) {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

async function rejectUnsafePdfNames(file, size) {
  const forbidden = new Set([
    "Encrypt",
    "JavaScript",
    "JS",
    "Launch",
    "EmbeddedFile"
  ]);
  let carry = "";
  let offset = 0;
  while (offset < size) {
    const length = Math.min(STREAM_CHUNK_BYTES, size - offset);
    const chunk = await readExactly(file, offset, length, "FILE_SIGNATURE_INVALID");
    const text = carry + chunk.toString("latin1");
    const safeEnd = offset + length === size
      ? text.length
      : Math.max(0, text.length - 128);
    const pattern = /\/([^\x00\x09\x0a\x0c\x0d\x20()<>\[\]{}/%]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null && match.index < safeEnd) {
      if (forbidden.has(decodePdfName(match[1]))) {
        fail("FILE_SIGNATURE_INVALID", "Active, embedded or encrypted PDF content is not accepted");
      }
    }
    carry = text.slice(safeEnd);
    offset += length;
  }
}

function skipPdfWhitespace(text, position) {
  let offset = position;
  while (offset < text.length && /[\x00\x09\x0a\x0c\x0d\x20]/.test(text[offset])) {
    offset += 1;
  }
  return offset;
}

function findPdfDictionaryEnd(text, start) {
  if (!text.startsWith("<<", start)) {
    return -1;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = start; offset < text.length; offset += 1) {
    const character = text[offset];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === ")") {
        inString = false;
      }
      continue;
    }
    if (character === "(") {
      inString = true;
      continue;
    }
    if (text.startsWith("<<", offset)) {
      depth += 1;
      offset += 1;
    } else if (text.startsWith(">>", offset)) {
      depth -= 1;
      offset += 1;
      if (depth === 0) {
        return offset + 1;
      }
    }
  }
  return -1;
}

function validatePdfTrailerDictionary(dictionary) {
  const sizeMatch = dictionary.match(/\/Size\s+([0-9]+)/);
  if (!sizeMatch || !Number.isSafeInteger(Number(sizeMatch[1])) ||
      Number(sizeMatch[1]) < 1 ||
      !/\/Root\s+[0-9]+\s+[0-9]+\s+R\b/.test(dictionary)) {
    fail("FILE_SIGNATURE_INVALID", "The PDF trailer is incomplete");
  }
}

function validateClassicPdfXref(text) {
  let offset = skipPdfWhitespace(text, 0);
  if (!text.startsWith("xref", offset) || /[A-Za-z0-9]/.test(text[offset + 4] || "")) {
    return null;
  }
  offset = skipPdfWhitespace(text, offset + 4);
  let entries = 0;
  const subsectionPattern = /([0-9]+)[ \t]+([0-9]+)[ \t]*(?:\r\n|\r|\n)/y;
  const entryPattern = /([0-9]{10})[ \t]([0-9]{5})[ \t]([nf])[ \t]*(?:\r\n|\r|\n)/y;
  const objectSamples = [];
  while (!text.startsWith("trailer", offset)) {
    subsectionPattern.lastIndex = offset;
    const header = subsectionPattern.exec(text);
    if (!header) {
      fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference table is malformed");
    }
    const firstObject = Number(header[1]);
    const count = Number(header[2]);
    if (!Number.isSafeInteger(firstObject) || firstObject < 0 ||
        !Number.isSafeInteger(count) || count < 1 ||
        entries + count > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference table exceeds safe limits");
    }
    offset = subsectionPattern.lastIndex;
    for (let index = 0; index < count; index += 1) {
      entryPattern.lastIndex = offset;
      const entry = entryPattern.exec(text);
      if (!entry) {
        fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference entries are malformed");
      }
      if (entry[3] === "n" && objectSamples.length < 128) {
        objectSamples.push({
          objectNumber: firstObject + index,
          offset: Number(entry[1]),
          generation: Number(entry[2])
        });
      }
      offset = entryPattern.lastIndex;
    }
    entries += count;
    offset = skipPdfWhitespace(text, offset);
  }
  offset = skipPdfWhitespace(text, offset + "trailer".length);
  const dictionaryEnd = findPdfDictionaryEnd(text, offset);
  if (dictionaryEnd < 0) {
    fail("FILE_SIGNATURE_INVALID", "The PDF trailer dictionary is truncated");
  }
  validatePdfTrailerDictionary(text.slice(offset, dictionaryEnd));
  return { xrefKind: "table", xrefEntries: entries, objectSamples };
}

async function validateClassicPdfObjectSamples(file, startXref, samples) {
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.offset) || sample.offset < 9 ||
        sample.offset >= startXref) {
      fail("FILE_SIGNATURE_INVALID", "A PDF cross-reference offset is out of range");
    }
    const length = Math.min(64, startXref - sample.offset);
    const objectHeader = (await readExactly(
      file,
      sample.offset,
      length,
      "FILE_SIGNATURE_INVALID"
    )).toString("latin1");
    const match = objectHeader.match(/^([0-9]+)[ \t]+([0-9]+)[ \t]+obj\b/);
    if (!match || Number(match[1]) !== sample.objectNumber ||
        Number(match[2]) !== sample.generation) {
      fail("FILE_SIGNATURE_INVALID", "A PDF cross-reference entry does not match its object");
    }
  }
}

async function validatePdfXrefStream(file, size, startXref, text) {
  const object = text.match(/^\s*([0-9]+)\s+([0-9]+)\s+obj\b/);
  if (!object) {
    fail("FILE_SIGNATURE_INVALID", "The PDF startxref offset is inconsistent");
  }
  const dictionaryStart = text.indexOf("<<", object[0].length);
  const dictionaryEnd = dictionaryStart < 0
    ? -1
    : findPdfDictionaryEnd(text, dictionaryStart);
  if (dictionaryEnd < 0) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream dictionary is truncated");
  }
  const dictionary = text.slice(dictionaryStart, dictionaryEnd);
  validatePdfTrailerDictionary(dictionary);
  const widthsMatch = dictionary.match(
    /\/W\s*\[\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*\]/
  );
  if (!/\/Type\s*\/XRef\b/.test(dictionary) || !widthsMatch) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream is invalid");
  }
  const widths = widthsMatch.slice(1).map(Number);
  const entryWidth = widths.reduce((total, width) => total + width, 0);
  if (widths.some((width) => !Number.isSafeInteger(width) || width < 0 || width > 8) ||
      entryWidth < 1) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream field widths are invalid");
  }
  const sizeValue = Number(dictionary.match(/\/Size\s+([0-9]+)/)[1]);
  const indexMatch = dictionary.match(/\/Index\s*\[([^\]]+)\]/);
  let indexedEntries = sizeValue;
  if (indexMatch) {
    const values = indexMatch[1].trim().split(/\s+/).map(Number);
    if (values.length < 2 || values.length % 2 !== 0 ||
        values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream index is invalid");
    }
    indexedEntries = 0;
    for (let offset = 0; offset < values.length; offset += 2) {
      if (values[offset + 1] < 1 || values[offset] + values[offset + 1] > sizeValue) {
        fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream index is out of range");
      }
      indexedEntries += values[offset + 1];
    }
  }
  const lengthMatch = dictionary.match(/\/Length\s+([0-9]+)\b/);
  const streamLength = lengthMatch ? Number(lengthMatch[1]) : NaN;
  if (!Number.isSafeInteger(streamLength) || streamLength < 1) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream length is invalid");
  }
  if (!/\/Filter\b/.test(dictionary) && streamLength !== indexedEntries * entryWidth) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream data length is inconsistent");
  }
  let streamKeyword = skipPdfWhitespace(text, dictionaryEnd);
  if (!text.startsWith("stream", streamKeyword)) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream data is missing");
  }
  streamKeyword += "stream".length;
  if (text.startsWith("\r\n", streamKeyword)) {
    streamKeyword += 2;
  } else if (text[streamKeyword] === "\n" || text[streamKeyword] === "\r") {
    streamKeyword += 1;
  } else {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream delimiter is invalid");
  }
  const dataStart = startXref + streamKeyword;
  if (dataStart + streamLength > size) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream is truncated");
  }
  const endingLength = Math.min(64, size - dataStart - streamLength);
  const ending = await readExactly(
    file,
    dataStart + streamLength,
    endingLength,
    "FILE_SIGNATURE_INVALID"
  );
  if (!/^(?:\r\n|\r|\n)?endstream[\x00\x09\x0a\x0c\x0d\x20]+endobj\b/.test(
    ending.toString("latin1")
  )) {
    fail("FILE_SIGNATURE_INVALID", "The PDF cross-reference stream ending is invalid");
  }
  return { xrefKind: "stream" };
}

async function inspectPdf(file, size, assetType, extension) {
  if (size < 32) {
    fail("FILE_SIGNATURE_INVALID", "The PDF container is incomplete");
  }
  const head = await readExactly(file, 0, Math.min(size, 16), "FILE_SIGNATURE_INVALID");
  if (!head.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")) ||
      head[5] < 0x31 || head[5] > 0x39 || head[6] !== 0x2e ||
      head[7] < 0x30 || head[7] > 0x39) {
    fail("FILE_SIGNATURE_INVALID", "The file is not a valid PDF container");
  }

  await rejectUnsafePdfNames(file, size);
  const tailLength = Math.min(size, MAX_PDF_TAIL_BYTES);
  const tailStart = size - tailLength;
  const tailText = (await readExactly(
    file,
    tailStart,
    tailLength,
    "FILE_SIGNATURE_INVALID"
  )).toString("latin1");
  const finalRecord = tailText.match(
    /startxref[\x00\x09\x0a\x0c\x0d\x20]+([0-9]+)[\x00\x09\x0a\x0c\x0d\x20]+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/
  );
  const startXref = finalRecord ? Number(finalRecord[1]) : NaN;
  if (!Number.isSafeInteger(startXref) || startXref < 9 || startXref >= size) {
    fail("FILE_SIGNATURE_INVALID", "The PDF startxref record is missing or invalid");
  }
  const xrefLength = Math.min(size - startXref, MAX_PDF_XREF_BYTES);
  const xrefText = (await readExactly(
    file,
    startXref,
    xrefLength,
    "FILE_SIGNATURE_INVALID"
  )).toString("latin1");
  const classic = validateClassicPdfXref(xrefText);
  let xrefMetadata;
  if (classic) {
    await validateClassicPdfObjectSamples(file, startXref, classic.objectSamples);
    const { objectSamples: _objectSamples, ...publicMetadata } = classic;
    xrefMetadata = publicMetadata;
  } else {
    xrefMetadata = await validatePdfXrefStream(file, size, startXref, xrefText);
  }

  return baseInspection(assetType, extension, size, "pdf", {
    needsManualStructure: true,
    metadata: {
      pdfVersion: head.subarray(5, 8).toString("ascii"),
      ...xrefMetadata
    }
  });
}

function hasZip64Extra(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) {
      fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP extra field is malformed");
    }
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) {
      fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP extra field is truncated");
    }
    if (id === ZIP64_EXTRA_ID) {
      return true;
    }
    offset += length;
  }
  return false;
}

function decodeZipName(nameBytes, utf8) {
  try {
    return utf8
      ? UTF8_DECODER.decode(nameBytes)
      : nameBytes.toString("latin1");
  } catch (error) {
    fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP entry name is not valid UTF-8", error);
  }
}

function assertSafeZipPath(name) {
  if (!name || name.length > MAX_ENTRY_NAME_BYTES ||
      name.includes("\0") || /[\x01-\x1f\x7f]/.test(name) ||
      name.includes("\\") || name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name)) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains an unsafe entry path");
  }

  const isDirectory = name.endsWith("/");
  const segments = name.split("/");
  if (isDirectory) {
    segments.pop();
  }
  if (segments.length === 0 ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains path traversal");
  }
}

function assertSafeUnixMode(versionMadeBy, externalAttributes) {
  const creatorSystem = versionMadeBy >>> 8;
  if (creatorSystem !== 3) {
    return;
  }
  const mode = (externalAttributes >>> 16) & 0xffff;
  const fileType = mode & 0xf000;
  if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains a non-file ZIP entry");
  }
}

function assertSafeCompression(entry, totals) {
  if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    fail("DOCX_ARCHIVE_UNSAFE", "A DOCX entry is too large after decompression");
  }
  totals.uncompressed += entry.uncompressedSize;
  if (totals.uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX expands beyond the safe size limit");
  }
  if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX declares an impossible compression ratio");
  }
  if (entry.uncompressedSize >= 1024 * 1024 &&
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX has a suspicious compression ratio");
  }
}

async function locateEndOfCentralDirectory(file, size) {
  if (size < 22) {
    fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP end record is missing");
  }
  const tailLength = Math.min(size, 22 + 0xffff + 20);
  const tailStart = size - tailLength;
  const tail = await readExactly(
    file,
    tailStart,
    tailLength,
    "DOCX_ARCHIVE_INVALID"
  );

  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== tail.length) {
      continue;
    }
    const absoluteOffset = tailStart + offset;
    if (offset >= 20 && tail.readUInt32LE(offset - 20) === ZIP64_LOCATOR_SIGNATURE) {
      fail("DOCX_ARCHIVE_UNSAFE", "Zip64 DOCX archives are not accepted");
    }
    return { buffer: tail.subarray(offset, offset + 22), absoluteOffset };
  }

  fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP end record is invalid");
}

async function readCentralDirectory(file, size) {
  const eocd = await locateEndOfCentralDirectory(file, size);
  const record = eocd.buffer;
  const diskNumber = record.readUInt16LE(4);
  const centralDisk = record.readUInt16LE(6);
  const entriesOnDisk = record.readUInt16LE(8);
  const entryCount = record.readUInt16LE(10);
  const centralSize = record.readUInt32LE(12);
  const centralOffset = record.readUInt32LE(16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("DOCX_ARCHIVE_UNSAFE", "Multi-disk DOCX ZIP archives are not accepted");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff ||
      centralOffset === 0xffffffff) {
    fail("DOCX_ARCHIVE_UNSAFE", "Zip64 DOCX archives are not accepted");
  }
  if (entryCount === 0 || entryCount > MAX_ZIP_ENTRIES ||
      centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX ZIP directory exceeds safe limits");
  }
  if (centralOffset + centralSize > eocd.absoluteOffset ||
      centralOffset + centralSize > size) {
    fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP directory points outside the file");
  }

  const directory = await readExactly(
    file,
    centralOffset,
    centralSize,
    "DOCX_ARCHIVE_INVALID"
  );
  const entries = [];
  const names = new Set();
  const foldedNames = new Set();
  const totals = { uncompressed: 0 };
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directory.length ||
        directory.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP directory is malformed");
    }

    const versionMadeBy = directory.readUInt16LE(offset + 4);
    const versionNeeded = directory.readUInt16LE(offset + 6);
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const crc = directory.readUInt32LE(offset + 16);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const diskStart = directory.readUInt16LE(offset + 34);
    const externalAttributes = directory.readUInt32LE(offset + 38);
    const localOffset = directory.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > directory.length || nameLength === 0) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP directory record is truncated");
    }
    if (nameLength > MAX_ENTRY_NAME_BYTES) {
      fail("DOCX_ARCHIVE_UNSAFE", "A DOCX ZIP entry name is too long");
    }

    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
    const extra = directory.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength
    );
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail("DOCX_ARCHIVE_UNSAFE", "Encrypted DOCX ZIP entries are not accepted");
    }
    if (versionNeeded >= 45 || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        diskStart === 0xffff || hasZip64Extra(extra)) {
      fail("DOCX_ARCHIVE_UNSAFE", "Zip64 DOCX entries are not accepted");
    }
    if (diskStart !== 0) {
      fail("DOCX_ARCHIVE_UNSAFE", "Multi-disk DOCX entries are not accepted");
    }
    if (method !== 0 && method !== 8) {
      fail("DOCX_ARCHIVE_INVALID", "The DOCX uses an unsupported ZIP method");
    }

    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    assertSafeZipPath(name);
    assertSafeUnixMode(versionMadeBy, externalAttributes);
    if (names.has(name) || foldedNames.has(name.toLowerCase())) {
      fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains duplicate entry paths");
    }
    names.add(name);
    foldedNames.add(name.toLowerCase());

    const entry = {
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: 0
    };
    if (!name.endsWith("/")) {
      assertSafeCompression(entry, totals);
    }
    entries.push(entry);
    offset += recordLength;
  }

  if (offset !== directory.length) {
    fail("DOCX_ARCHIVE_INVALID", "The DOCX ZIP directory size is inconsistent");
  }

  return {
    entries,
    entryCount,
    totalUncompressedBytes: totals.uncompressed,
    centralOffset
  };
}

async function validateLocalEntries(file, archive) {
  const ranges = [];
  for (const entry of archive.entries) {
    if (entry.localOffset + 30 > archive.centralOffset) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP local header is out of range");
    }
    const header = await readExactly(
      file,
      entry.localOffset,
      30,
      "DOCX_ARCHIVE_INVALID"
    );
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP local header is missing");
    }
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail("DOCX_ARCHIVE_UNSAFE", "Encrypted DOCX ZIP entries are not accepted");
    }
    if (flags !== entry.flags || method !== entry.method ||
        nameLength !== entry.nameBytes.length) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP local header is inconsistent");
    }
    const variable = await readExactly(
      file,
      entry.localOffset + 30,
      nameLength + extraLength,
      "DOCX_ARCHIVE_INVALID"
    );
    if (!variable.subarray(0, nameLength).equals(entry.nameBytes)) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP entry name is inconsistent");
    }
    if (hasZip64Extra(variable.subarray(nameLength))) {
      fail("DOCX_ARCHIVE_UNSAFE", "Zip64 DOCX entries are not accepted");
    }
    if ((flags & 0x0008) === 0 &&
        (header.readUInt32LE(14) !== entry.crc ||
         header.readUInt32LE(18) !== entry.compressedSize ||
         header.readUInt32LE(22) !== entry.uncompressedSize)) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP entry size is inconsistent");
    }

    entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = entry.dataOffset + entry.compressedSize;
    if (dataEnd > archive.centralOffset || dataEnd < entry.dataOffset) {
      fail("DOCX_ARCHIVE_INVALID", "A DOCX ZIP entry points outside the archive");
    }
    ranges.push({ start: entry.localOffset, end: dataEnd });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      fail("DOCX_ARCHIVE_UNSAFE", "DOCX ZIP entries overlap");
    }
  }
}

let crcTable;
function getCrcTable() {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0
          ? (value >>> 1) ^ 0xedb88320
          : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  return crcTable;
}

function crc32Update(value, buffer) {
  const table = getCrcTable();
  for (const byte of buffer) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function crc32(buffer) {
  return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

async function crc32FileRange(file, position, length) {
  let value = 0xffffffff;
  let offset = position;
  const end = position + length;
  while (offset < end) {
    const chunkLength = Math.min(STREAM_CHUNK_BYTES, end - offset);
    const chunk = await readExactly(file, offset, chunkLength, "FILE_SIGNATURE_INVALID");
    value = crc32Update(value, chunk);
    offset += chunkLength;
  }
  return (value ^ 0xffffffff) >>> 0;
}

class FileWindowReader {
  constructor(file, size) {
    this.file = file;
    this.size = size;
    this.start = -1;
    this.buffer = Buffer.alloc(0);
  }

  async read(position, length) {
    if (!Number.isSafeInteger(position) || position < 0 ||
        !Number.isSafeInteger(length) || length < 0 ||
        position + length > this.size) {
      fail("FILE_SIGNATURE_INVALID", "The uploaded file has invalid internal offsets");
    }
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (position >= this.start &&
        position + length <= this.start + this.buffer.length) {
      return this.buffer.subarray(position - this.start, position - this.start + length);
    }
    const windowLength = Math.min(
      this.size - position,
      Math.max(STREAM_CHUNK_BYTES, length)
    );
    this.buffer = await readExactly(
      this.file,
      position,
      windowLength,
      "FILE_SIGNATURE_INVALID"
    );
    this.start = position;
    return this.buffer.subarray(0, length);
  }
}

async function extractBoundedZipEntry(file, entry, maximumBytes, label) {
  if (entry.uncompressedSize > maximumBytes || entry.compressedSize > maximumBytes) {
    fail("DOCX_ARCHIVE_UNSAFE", `${label} exceeds the safe parsing limit`);
  }
  const compressed = await readExactly(
    file,
    entry.dataOffset,
    entry.compressedSize,
    "DOCX_ARCHIVE_INVALID"
  );
  let output;
  try {
    output = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: maximumBytes });
  } catch (error) {
    fail("DOCX_ARCHIVE_INVALID", `${label} cannot be decompressed`, error);
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) {
    fail("DOCX_ARCHIVE_INVALID", `${label} failed its integrity check`);
  }
  return output;
}

async function extractDocumentXml(file, entry) {
  return extractBoundedZipEntry(
    file,
    entry,
    MAX_DOCUMENT_XML_BYTES,
    "word/document.xml"
  );
}

function opcXmlFailure(entryName, message) {
  fail("DOCUMENT_STRUCTURE_INVALID", `${entryName} ${message}`);
}

function decodeOpcXmlEntities(value, entryName) {
  const entityPattern = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
  if (value.replace(entityPattern, "").includes("&")) {
    opcXmlFailure(entryName, "contains an undeclared XML entity");
  }
  return value.replace(entityPattern, (_entity, body) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return "\"";
    if (body === "apos") return "'";
    const radix = body[1].toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? body.slice(2) : body.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    const validXmlCharacter = codePoint === 0x09 || codePoint === 0x0a ||
      codePoint === 0x0d || (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!Number.isInteger(codePoint) || !validXmlCharacter) {
      opcXmlFailure(entryName, "contains an invalid XML character entity");
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseOpcXmlAttributes(markup, nameEnd, entryName) {
  const attributes = new Map();
  let offset = nameEnd;
  while (offset < markup.length) {
    if (!/\s/.test(markup[offset])) {
      opcXmlFailure(entryName, "has malformed XML attributes");
    }
    while (offset < markup.length && /\s/.test(markup[offset])) {
      offset += 1;
    }
    if (offset >= markup.length) {
      break;
    }
    const nameMatch = markup.slice(offset).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!nameMatch) {
      opcXmlFailure(entryName, "has an invalid XML attribute name");
    }
    const name = nameMatch[1];
    offset += name.length;
    while (offset < markup.length && /\s/.test(markup[offset])) {
      offset += 1;
    }
    if (markup[offset] !== "=") {
      opcXmlFailure(entryName, "has an XML attribute without a value");
    }
    offset += 1;
    while (offset < markup.length && /\s/.test(markup[offset])) {
      offset += 1;
    }
    const quote = markup[offset];
    if (quote !== "\"" && quote !== "'") {
      opcXmlFailure(entryName, "has an unquoted XML attribute");
    }
    const valueStart = offset + 1;
    const valueEnd = markup.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      opcXmlFailure(entryName, "has an unterminated XML attribute");
    }
    const rawValue = markup.slice(valueStart, valueEnd);
    if (rawValue.includes("<") || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawValue) ||
        attributes.has(name)) {
      opcXmlFailure(entryName, "has an invalid or duplicate XML attribute");
    }
    if (attributes.size >= MAX_OPC_XML_ATTRIBUTES) {
      fail("DOCX_ARCHIVE_UNSAFE", `${entryName} has too many XML attributes`);
    }
    attributes.set(
      name,
      decodeOpcXmlEntities(rawValue.replace(/[\t\r\n]/g, " "), entryName)
    );
    offset = valueEnd + 1;
  }
  return attributes;
}

function localXmlName(name) {
  const separator = name.indexOf(":");
  return separator < 0 ? name : name.slice(separator + 1);
}

function parseSafeOpcXml(xmlBytes, entryName, expectedRoot, expectedNamespace) {
  let xml;
  try {
    xml = UTF8_DECODER.decode(xmlBytes);
  } catch (error) {
    opcXmlFailure(entryName, "is not valid UTF-8 XML");
  }
  if (xml.charCodeAt(0) === 0xfeff) {
    xml = xml.slice(1);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(xml)) {
    fail("DOCX_ARCHIVE_UNSAFE", `${entryName} contains unsafe XML declarations`);
  }

  const elements = [];
  const stack = [];
  let root = null;
  let rootClosed = false;
  let declarationSeen = false;
  let offset = 0;
  while (offset < xml.length) {
    const tagStart = xml.indexOf("<", offset);
    const textEnd = tagStart < 0 ? xml.length : tagStart;
    if (/\S/.test(xml.slice(offset, textEnd))) {
      opcXmlFailure(entryName, "contains unexpected XML text");
    }
    if (tagStart < 0) {
      break;
    }
    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart + 4);
      if (end < 0 || xml.slice(tagStart + 4, end).includes("--")) {
        opcXmlFailure(entryName, "contains an invalid XML comment");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart + 2);
      const declaration = end < 0 ? "" : xml.slice(tagStart, end + 2);
      if (end < 0 || declarationSeen || root ||
          !/^<\?xml\s+[\s\S]*\?>$/.test(declaration)) {
        opcXmlFailure(entryName, "contains an invalid processing instruction");
      }
      const encoding = declaration.match(/\bencoding\s*=\s*["']([^"']+)["']/i);
      if (encoding && !/^utf-?8$/i.test(encoding[1])) {
        opcXmlFailure(entryName, "must declare UTF-8 encoding");
      }
      declarationSeen = true;
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      fail("DOCX_ARCHIVE_UNSAFE", `${entryName} contains unsafe XML markup`);
    }
    const tagEnd = findMarkupEnd(xml, tagStart + 1);
    if (tagEnd < 0) {
      opcXmlFailure(entryName, "has an unterminated XML tag");
    }
    let markup = xml.slice(tagStart + 1, tagEnd).trim();
    const closing = markup.startsWith("/");
    if (closing) {
      markup = markup.slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(markup) || stack.pop() !== markup) {
        opcXmlFailure(entryName, "has mismatched XML tags");
      }
      if (stack.length === 0) {
        rootClosed = true;
      }
      offset = tagEnd + 1;
      continue;
    }
    const selfClosing = markup.endsWith("/");
    if (selfClosing) {
      markup = markup.slice(0, -1).trimEnd();
    }
    const nameMatch = markup.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!nameMatch) {
      opcXmlFailure(entryName, "has a malformed XML tag");
    }
    const name = nameMatch[1];
    const attributes = parseOpcXmlAttributes(markup, name.length, entryName);
    const element = {
      name,
      localName: localXmlName(name),
      attributes,
      depth: stack.length,
      selfClosing
    };
    if (elements.length >= MAX_OPC_XML_ELEMENTS) {
      fail("DOCX_ARCHIVE_UNSAFE", `${entryName} contains too many XML elements`);
    }
    elements.push(element);
    if (stack.length === 0) {
      if (root || rootClosed || element.localName !== expectedRoot) {
        opcXmlFailure(entryName, "has an invalid XML root element");
      }
      const separator = name.indexOf(":");
      const namespaceAttribute = separator < 0
        ? "xmlns"
        : `xmlns:${name.slice(0, separator)}`;
      if (attributes.get(namespaceAttribute) !== expectedNamespace) {
        opcXmlFailure(entryName, "uses an unexpected XML namespace");
      }
      root = element;
    }
    if (!selfClosing) {
      stack.push(name);
    } else if (stack.length === 0) {
      rootClosed = true;
    }
    offset = tagEnd + 1;
  }
  if (!root || !rootClosed || stack.length !== 0) {
    opcXmlFailure(entryName, "is not well-formed XML");
  }
  return elements;
}

function repeatedlyDecodeUriComponent(value, entryName) {
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch (error) {
      opcXmlFailure(entryName, "contains an invalid percent-encoded URI");
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function assertNoDangerousDocxPartName(value, entryName) {
  const decoded = repeatedlyDecodeUriComponent(value, entryName)
    .replace(/^\/+/, "")
    .toLowerCase();
  const segments = decoded.split("/").filter(Boolean);
  const dangerousDirectory = segments.some((segment) =>
    ["embeddings", "activex", "customui", "macros"].includes(segment)
  );
  const dangerousFile = segments.some((segment) =>
    /^(?:vbaproject(?:signature)?|vbadata|oleobject|attachedtemplate|altchunk|afchunk)(?:[0-9]+)?(?:[._-]|$)/.test(
      segment
    )
  );
  if (dangerousDirectory || dangerousFile) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains active or embedded Office content");
  }
}

function validateContentTypesXml(xmlBytes, entryName) {
  const elements = parseSafeOpcXml(
    xmlBytes,
    entryName,
    "Types",
    OPC_CONTENT_TYPES_NAMESPACE
  );
  for (const element of elements.slice(1)) {
    if (element.depth !== 1 || !["Default", "Override"].includes(element.localName)) {
      opcXmlFailure(entryName, "contains an invalid content-type element");
    }
    const contentType = element.attributes.get("ContentType");
    const partName = element.attributes.get("PartName");
    const extension = element.attributes.get("Extension");
    if (!contentType ||
        (element.localName === "Override" && !partName) ||
        (element.localName === "Default" && !extension)) {
      opcXmlFailure(entryName, "contains an incomplete content-type declaration");
    }
    const foldedType = contentType.toLowerCase();
    if (/(?:macroenabled|vbaproject|vbadata|activex|oleobject|customui)/.test(foldedType)) {
      fail("DOCX_ARCHIVE_UNSAFE", "The DOCX declares an active Office content type");
    }
    if (partName) {
      assertNoDangerousDocxPartName(partName, entryName);
    }
  }
}

function relationshipSourceDirectory(entryName) {
  if (entryName.toLowerCase() === "_rels/.rels") {
    return "";
  }
  const match = entryName.match(/^(.*\/)?_rels\/([^/]+)\.rels$/i);
  if (!match) {
    opcXmlFailure(entryName, "is not stored in an OPC relationship directory");
  }
  return (match[1] || "").replace(/\/$/, "");
}

function resolveInternalRelationshipTarget(target, sourceDirectory, entryName) {
  if (!target || target.includes("\\") || target.startsWith("//") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    fail("DOCX_ARCHIVE_UNSAFE", `${entryName} contains a non-package relationship target`);
  }
  const withoutFragment = target.split("#", 1)[0];
  if (!withoutFragment || withoutFragment.includes("?")) {
    opcXmlFailure(entryName, "contains an invalid internal relationship target");
  }
  const decoded = repeatedlyDecodeUriComponent(withoutFragment, entryName);
  if (decoded.includes("\\") || decoded.startsWith("//") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
    fail("DOCX_ARCHIVE_UNSAFE", `${entryName} contains an encoded external target`);
  }
  const segments = decoded.startsWith("/")
    ? []
    : sourceDirectory.split("/").filter(Boolean);
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        fail("DOCX_ARCHIVE_UNSAFE", `${entryName} escapes the DOCX package root`);
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    opcXmlFailure(entryName, "contains an empty internal relationship target");
  }
  const resolved = segments.join("/");
  assertNoDangerousDocxPartName(resolved, entryName);
  return resolved;
}

function validateRelationshipsXml(xmlBytes, entryName, packageParts) {
  const elements = parseSafeOpcXml(
    xmlBytes,
    entryName,
    "Relationships",
    OPC_RELATIONSHIPS_NAMESPACE
  );
  const sourceDirectory = relationshipSourceDirectory(entryName);
  const seenIds = new Set();
  for (const element of elements.slice(1)) {
    if (element.depth !== 1 || element.localName !== "Relationship") {
      opcXmlFailure(entryName, "contains an invalid relationship element");
    }
    const id = element.attributes.get("Id");
    const type = element.attributes.get("Type");
    const target = element.attributes.get("Target");
    const targetMode = element.attributes.get("TargetMode");
    if (!id || !type || !target || seenIds.has(id)) {
      opcXmlFailure(entryName, "contains an incomplete or duplicate relationship");
    }
    seenIds.add(id);
    if (targetMode && !/^(?:Internal|External)$/i.test(targetMode)) {
      opcXmlFailure(entryName, "contains an invalid relationship target mode");
    }
    if (/^External$/i.test(targetMode || "")) {
      fail("DOCX_ARCHIVE_UNSAFE", "External DOCX relationships are not accepted");
    }
    const normalizedType = repeatedlyDecodeUriComponent(type, entryName);
    const relationshipKind = normalizedType.split(/[\/#]/).pop().toLowerCase();
    if (/^(?:vbaproject(?:signature)?|vbadata|oleobject|package|control|activex|attachedtemplate|afchunk|altchunk|customui)$/.test(
      relationshipKind
    )) {
      fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains an active Office relationship");
    }
    const resolvedTarget = resolveInternalRelationshipTarget(
      target,
      sourceDirectory,
      entryName
    );
    if (!packageParts.has(resolvedTarget.toLowerCase())) {
      opcXmlFailure(entryName, "points to a missing internal package part");
    }
  }
  return elements.length - 1;
}

async function validateDocxPackageSecurity(file, archive, byName) {
  for (const entry of archive.entries) {
    assertNoDangerousDocxPartName(entry.name, entry.name);
  }
  const relationshipEntries = archive.entries.filter((entry) =>
    !entry.name.endsWith("/") && entry.name.toLowerCase().endsWith(".rels")
  );
  const controlEntries = [byName.get("[Content_Types].xml"), ...relationshipEntries];
  const totalControlBytes = controlEntries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0
  );
  if (totalControlBytes > MAX_DOCX_CONTROL_XML_TOTAL_BYTES) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX relationship metadata exceeds safe limits");
  }
  const contentTypes = await extractBoundedZipEntry(
    file,
    byName.get("[Content_Types].xml"),
    MAX_DOCX_CONTROL_XML_BYTES,
    "[Content_Types].xml"
  );
  validateContentTypesXml(contentTypes, "[Content_Types].xml");

  const packageParts = new Set(
    archive.entries
      .filter((entry) => !entry.name.endsWith("/"))
      .map((entry) => repeatedlyDecodeUriComponent(entry.name, entry.name).toLowerCase())
  );
  let relationshipCount = 0;
  for (const entry of relationshipEntries) {
    const xml = await extractBoundedZipEntry(
      file,
      entry,
      MAX_DOCX_CONTROL_XML_BYTES,
      entry.name
    );
    relationshipCount += validateRelationshipsXml(xml, entry.name, packageParts);
  }
  return { relationshipFileCount: relationshipEntries.length, relationshipCount };
}

function decodeXmlEntities(value) {
  const entityPattern = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
  if (value.replace(entityPattern, "").includes("&")) {
    fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an invalid entity");
  }
  return value.replace(
    entityPattern,
    (entity, body) => {
      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return "\"";
      if (body === "apos") return "'";
      const radix = body[1].toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      if (!Number.isInteger(codePoint) || codePoint < 0 ||
          codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an invalid entity");
      }
      return String.fromCodePoint(codePoint);
    }
  );
}

function findMarkupEnd(xml, start) {
  let quote = "";
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function validateXmlShape(xml) {
  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  let offset = 0;

  while (offset < xml.length) {
    const tagStart = xml.indexOf("<", offset);
    const textEnd = tagStart === -1 ? xml.length : tagStart;
    if (stack.length === 0 && /\S/.test(xml.slice(offset, textEnd))) {
      fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has text outside its root");
    }
    if (tagStart === -1) {
      break;
    }
    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart + 4);
      if (end === -1 || xml.slice(tagStart + 4, end).includes("--")) {
        fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an invalid comment");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart + 2);
      if (end === -1 || rootSeen) {
        fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an invalid processing instruction");
      }
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      const end = xml.indexOf("]]>", tagStart + 9);
      if (end === -1 || stack.length === 0) {
        fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has invalid CDATA");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has unsafe declarations");
    }

    const tagEnd = findMarkupEnd(xml, tagStart + 1);
    if (tagEnd === -1) {
      fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an unterminated tag");
    }
    let markup = xml.slice(tagStart + 1, tagEnd).trim();
    const closing = markup.startsWith("/");
    if (closing) {
      markup = markup.slice(1).trim();
    }
    const selfClosing = !closing && markup.endsWith("/");
    if (selfClosing) {
      markup = markup.slice(0, -1).trimEnd();
    }
    const match = markup.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[\s\S]*)?$/);
    if (!match || (closing && markup !== match[1])) {
      fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has a malformed tag");
    }
    const name = match[1];
    if (closing) {
      if (stack.pop() !== name) {
        fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has mismatched tags");
      }
      if (stack.length === 0) {
        rootClosed = true;
      }
    } else {
      if (stack.length === 0) {
        if (rootSeen || rootClosed || name !== "w:document") {
          fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml has an invalid root");
        }
        rootSeen = true;
      }
      if (!selfClosing) {
        stack.push(name);
      } else if (stack.length === 0) {
        rootClosed = true;
      }
    }
    offset = tagEnd + 1;
  }

  if (!rootSeen || !rootClosed || stack.length !== 0) {
    fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml is not well formed");
  }
}

function parseDocumentPreview(xmlBytes) {
  let xml;
  try {
    xml = UTF8_DECODER.decode(xmlBytes);
  } catch (error) {
    fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml is not valid UTF-8", error);
  }
  if (xml.charCodeAt(0) === 0xfeff) {
    xml = xml.slice(1);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) ||
      !/<w:document(?:\s|>)/.test(xml) || !/<\/w:document\s*>/.test(xml)) {
    fail("DOCUMENT_STRUCTURE_INVALID", "The DOCX Word document structure is invalid");
  }
  validateXmlShape(xml);
  if (/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?altChunk(?:\s|\/?>)/.test(xml)) {
    fail("DOCX_ARCHIVE_UNSAFE", "The DOCX contains an altChunk import");
  }
  const declaration = xml.match(/^\s*<\?xml\s+([^?]+)\?>/i);
  if (declaration) {
    const encoding = declaration[1].match(/encoding\s*=\s*["']([^"']+)["']/i);
    if (encoding && !/^utf-?8$/i.test(encoding[1])) {
      fail("DOCUMENT_STRUCTURE_INVALID", "word/document.xml must use UTF-8");
    }
  }

  const previewParagraphs = [];
  let previewCharacters = 0;
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p\s*>/g;
  let paragraph;
  while ((paragraph = paragraphPattern.exec(xml)) !== null &&
         previewParagraphs.length < MAX_PREVIEW_PARAGRAPHS &&
         previewCharacters < MAX_PREVIEW_CHARACTERS) {
    let text = "";
    const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t\s*>|<w:(tab|br|cr)(?:\s[^>]*)?\s*\/\s*>/g;
    let token;
    while ((token = tokenPattern.exec(paragraph[1])) !== null) {
      if (token[1] !== undefined) {
        if (/<[^>]+>/.test(token[1])) {
          fail("DOCUMENT_STRUCTURE_INVALID", "A DOCX text node contains invalid markup");
        }
        text += decodeXmlEntities(token[1]);
      } else {
        text += token[2] === "tab" ? "\t" : "\n";
      }
    }
    text = text
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim();
    if (!text) {
      continue;
    }
    const available = Math.min(
      MAX_PREVIEW_PARAGRAPH_CHARACTERS,
      MAX_PREVIEW_CHARACTERS - previewCharacters
    );
    const clipped = Array.from(text).slice(0, available).join("");
    if (clipped) {
      previewParagraphs.push(clipped);
      previewCharacters += Array.from(clipped).length;
    }
  }

  return { previewParagraphs, previewCharacters };
}

async function inspectDocx(file, size, assetType, extension) {
  const archive = await readCentralDirectory(file, size);
  await validateLocalEntries(file, archive);
  const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  for (const requiredName of REQUIRED_DOCX_ENTRIES) {
    const entry = byName.get(requiredName);
    if (!entry || entry.name.endsWith("/")) {
      fail(
        "DOCUMENT_STRUCTURE_INVALID",
        `The DOCX is missing required entry ${requiredName}`
      );
    }
  }

  const packageSecurity = await validateDocxPackageSecurity(file, archive, byName);

  const documentBytes = await extractDocumentXml(
    file,
    byName.get("word/document.xml")
  );
  const preview = parseDocumentPreview(documentBytes);
  return {
    ...baseInspection(assetType, extension, size, "docx", {
      // Only a bounded text preview is extracted here. Embedded media, styles
      // and paragraphs beyond the preview limit still require an editor or a
      // dedicated asynchronous conversion worker before publication.
      needsManualStructure: true,
      metadata: {
        zipEntryCount: archive.entryCount,
        totalUncompressedBytes: archive.totalUncompressedBytes,
        documentCharacters: preview.previewCharacters,
        previewParagraphCount: preview.previewParagraphs.length,
        relationshipFileCount: packageSecurity.relationshipFileCount,
        relationshipCount: packageSecurity.relationshipCount
      }
    }),
    previewParagraphs: preview.previewParagraphs
  };
}

const MPEG1_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]),
  2: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]),
  3: Object.freeze([0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])
});
const MPEG2_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]),
  2: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]),
  3: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])
});

function parseMpegAudioFrameHeader(header) {
  if (header.length < 4 || header[0] !== 0xff || (header[1] & 0xe0) !== 0xe0) {
    return null;
  }
  const versionBits = (header[1] >>> 3) & 0x03;
  const layerBits = (header[1] >>> 1) & 0x03;
  const bitrateIndex = (header[2] >>> 4) & 0x0f;
  const sampleRateIndex = (header[2] >>> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 ||
      bitrateIndex === 15 || sampleRateIndex === 3 || (header[3] & 0x03) === 2) {
    return null;
  }
  const version = versionBits === 3 ? 1 : (versionBits === 2 ? 2 : 2.5);
  const layer = 4 - layerBits;
  const bitrate = (version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES)[layer][bitrateIndex];
  const sampleRate = [44100, 48000, 32000][sampleRateIndex] /
    (version === 1 ? 1 : (version === 2 ? 2 : 4));
  const padding = (header[2] >>> 1) & 0x01;
  const frameLength = layer === 1
    ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
    : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) /
      sampleRate + padding);
  const samplesPerFrame = layer === 1
    ? 384
    : (layer === 2 || version === 1 ? 1152 : 576);
  if (!Number.isSafeInteger(frameLength) || frameLength < 4) {
    return null;
  }
  return {
    version,
    layer,
    bitrate,
    sampleRate,
    frameLength,
    samplesPerFrame,
    channels: ((header[3] >>> 6) & 0x03) === 3 ? 1 : 2
  };
}

async function inspectMp3(file, size, assetType, extension) {
  if (size < 4) {
    fail("FILE_SIGNATURE_INVALID", "The MP3 stream is incomplete");
  }
  const reader = new FileWindowReader(file, size);
  let audioStart = 0;
  const metadata = { signature: "mpeg-audio-frame" };
  if (size >= 10) {
    const id3 = await reader.read(0, 10);
    if (id3.subarray(0, 3).toString("ascii") === "ID3") {
      const version = id3[3];
      const flags = id3[5];
      const allowedFlags = version === 2 ? 0xc0 : (version === 3 ? 0xe0 : 0xf0);
      if (version < 2 || version > 4 || id3[4] === 0xff ||
          (flags & ~allowedFlags) !== 0 ||
          !id3.subarray(6, 10).every((byte) => byte < 0x80)) {
        fail("FILE_SIGNATURE_INVALID", "The MP3 ID3 header is invalid");
      }
      const tagSize = (id3[6] << 21) | (id3[7] << 14) | (id3[8] << 7) | id3[9];
      const hasFooter = version === 4 && (flags & 0x10) !== 0;
      audioStart = 10 + tagSize + (hasFooter ? 10 : 0);
      if (audioStart > size) {
        fail("FILE_SIGNATURE_INVALID", "The MP3 ID3 tag is truncated");
      }
      if (hasFooter) {
        const footer = await reader.read(audioStart - 10, 10);
        if (footer.subarray(0, 3).toString("ascii") !== "3DI") {
          fail("FILE_SIGNATURE_INVALID", "The MP3 ID3 footer is invalid");
        }
      }
      metadata.id3Version = `2.${version}.${id3[4]}`;
    }
  }

  let audioEnd = size;
  if (audioEnd - audioStart >= 128) {
    const id3v1 = await reader.read(audioEnd - 128, 3);
    if (id3v1.toString("ascii") === "TAG") {
      audioEnd -= 128;
      metadata.hasId3v1 = true;
    }
  }
  let offset = audioStart;
  let frameCount = 0;
  let audioBytes = 0;
  let durationSeconds = 0;
  let reference = null;
  while (offset < audioEnd) {
    if (audioEnd - offset < 4) {
      fail("FILE_SIGNATURE_INVALID", "The final MP3 frame is truncated");
    }
    const frame = parseMpegAudioFrameHeader(await reader.read(offset, 4));
    if (!frame || offset + frame.frameLength > audioEnd) {
      fail("FILE_SIGNATURE_INVALID", "The MP3 frame sequence is invalid or truncated");
    }
    if (reference && (frame.version !== reference.version ||
        frame.layer !== reference.layer || frame.sampleRate !== reference.sampleRate)) {
      fail("FILE_SIGNATURE_INVALID", "The MP3 frame stream changes format unexpectedly");
    }
    reference ||= frame;
    frameCount += 1;
    if (frameCount > MAX_CONTAINER_RECORDS * 20) {
      fail("FILE_SIGNATURE_INVALID", "The MP3 contains too many frames to inspect safely");
    }
    audioBytes += frame.frameLength;
    durationSeconds += frame.samplesPerFrame / frame.sampleRate;
    offset += frame.frameLength;
  }
  if (!reference || frameCount < 1 || audioBytes < 4) {
    fail("FILE_SIGNATURE_INVALID", "The MP3 does not contain a complete audio frame");
  }

  return baseInspection(assetType, extension, size, "mp3", {
    needsManualStructure: true,
    metadata: {
      ...metadata,
      mpegVersion: reference.version,
      layer: reference.layer,
      sampleRateHz: reference.sampleRate,
      channels: reference.channels,
      frameCount,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      averageBitrateKbps: Number(((audioBytes * 8) / durationSeconds / 1000).toFixed(1))
    }
  });
}

async function readIsoBoxHeader(file, offset, limit) {
  if (limit - offset < 8) {
    fail("FILE_SIGNATURE_INVALID", "The M4A box header is truncated");
  }
  const header = await readExactly(file, offset, 8, "FILE_SIGNATURE_INVALID");
  const type = header.subarray(4, 8).toString("latin1");
  let boxSize = header.readUInt32BE(0);
  const extendsToEnd = boxSize === 0;
  let headerSize = 8;
  if (boxSize === 1) {
    if (limit - offset < 16) {
      fail("FILE_SIGNATURE_INVALID", "The M4A extended box header is truncated");
    }
    const extended = (await readExactly(
      file,
      offset + 8,
      8,
      "FILE_SIGNATURE_INVALID"
    )).readBigUInt64BE(0);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("FILE_SIGNATURE_INVALID", "An M4A box exceeds safe integer limits");
    }
    boxSize = Number(extended);
    headerSize = 16;
  } else if (boxSize === 0) {
    boxSize = limit - offset;
  }
  if (type === "uuid") {
    headerSize += 16;
  }
  if (boxSize < headerSize || offset + boxSize > limit || offset + boxSize < offset) {
    fail("FILE_SIGNATURE_INVALID", "An M4A box has invalid boundaries");
  }
  return {
    type,
    offset,
    size: boxSize,
    headerSize,
    extendsToEnd,
    dataStart: offset + headerSize,
    end: offset + boxSize
  };
}

async function listIsoBoxes(file, start, end, budget, allowToEnd = false) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    budget.count += 1;
    if (budget.count > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The M4A contains too many boxes");
    }
    const box = await readIsoBoxHeader(file, offset, end);
    if (box.extendsToEnd && !allowToEnd) {
      fail("FILE_SIGNATURE_INVALID", "A nested M4A box uses an invalid zero size");
    }
    boxes.push(box);
    offset = box.end;
  }
  if (offset !== end) {
    fail("FILE_SIGNATURE_INVALID", "The M4A box sequence is inconsistent");
  }
  return boxes;
}

const ISO_CONTAINER_BOXES = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta",
  "mvex", "moof", "traf", "mfra", "meta"
]);

async function validateIsoContainerTree(file, boxes, budget, depth = 0) {
  if (depth > 16) {
    fail("FILE_SIGNATURE_INVALID", "The M4A box hierarchy is too deep");
  }
  for (const box of boxes) {
    if (!ISO_CONTAINER_BOXES.has(box.type)) {
      continue;
    }
    let childrenStart = box.dataStart;
    if (box.type === "meta") {
      if (box.end - childrenStart < 4) {
        fail("FILE_SIGNATURE_INVALID", "The M4A meta box is truncated");
      }
      childrenStart += 4;
    }
    const children = await listIsoBoxes(file, childrenStart, box.end, budget);
    await validateIsoContainerTree(file, children, budget, depth + 1);
  }
}

async function m4aTrackHasAudioHandler(file, track, budget) {
  const trackChildren = await listIsoBoxes(file, track.dataStart, track.end, budget);
  for (const mdia of trackChildren.filter((box) => box.type === "mdia")) {
    const mediaChildren = await listIsoBoxes(file, mdia.dataStart, mdia.end, budget);
    for (const handler of mediaChildren.filter((box) => box.type === "hdlr")) {
      if (handler.end - handler.dataStart < 12) {
        fail("FILE_SIGNATURE_INVALID", "The M4A media handler is truncated");
      }
      const fields = await readExactly(
        file,
        handler.dataStart,
        12,
        "FILE_SIGNATURE_INVALID"
      );
      if (fields.subarray(8, 12).toString("ascii") === "soun") {
        return true;
      }
    }
  }
  return false;
}

async function inspectM4a(file, size, assetType, extension) {
  if (size < 24) {
    fail("FILE_SIGNATURE_INVALID", "The M4A container is incomplete");
  }
  const budget = { count: 0 };
  const topLevel = await listIsoBoxes(file, 0, size, budget, true);
  if (topLevel.length < 3 || topLevel[0].type !== "ftyp") {
    fail("FILE_SIGNATURE_INVALID", "The M4A ftyp box is missing");
  }
  const ftyp = topLevel[0];
  const ftypLength = ftyp.end - ftyp.dataStart;
  if (ftypLength < 8 || ftypLength > 4096 || (ftypLength - 8) % 4 !== 0) {
    fail("FILE_SIGNATURE_INVALID", "The M4A ftyp box is invalid");
  }
  const brands = await readExactly(file, ftyp.dataStart, ftypLength, "FILE_SIGNATURE_INVALID");
  const majorBrand = brands.subarray(0, 4).toString("ascii");
  const acceptedBrands = new Set([
    "M4A ", "M4B ", "mp41", "mp42", "isom", "iso2", "iso5", "iso6"
  ]);
  let acceptedBrand = acceptedBrands.has(majorBrand);
  for (let offset = 8; !acceptedBrand && offset + 4 <= brands.length; offset += 4) {
    acceptedBrand = acceptedBrands.has(brands.subarray(offset, offset + 4).toString("ascii"));
  }
  if (!acceptedBrand) {
    fail("FILE_SIGNATURE_INVALID", "The MP4 container is not M4A-compatible");
  }

  const movieBoxes = topLevel.filter((box) => box.type === "moov");
  const mediaDataBytes = topLevel
    .filter((box) => box.type === "mdat")
    .reduce((total, box) => total + box.end - box.dataStart, 0);
  if (movieBoxes.length !== 1 || mediaDataBytes < 1) {
    fail("FILE_SIGNATURE_INVALID", "The M4A movie or media-data box is missing");
  }
  const movieChildren = await listIsoBoxes(
    file,
    movieBoxes[0].dataStart,
    movieBoxes[0].end,
    budget
  );
  let hasAudioTrack = false;
  for (const track of movieChildren.filter((box) => box.type === "trak")) {
    if (await m4aTrackHasAudioHandler(file, track, budget)) {
      hasAudioTrack = true;
      break;
    }
  }
  if (!hasAudioTrack) {
    fail("FILE_SIGNATURE_INVALID", "The M4A does not contain an audio track");
  }
  await validateIsoContainerTree(file, movieBoxes, { count: 0 });

  return baseInspection(assetType, extension, size, "m4a", {
    needsManualStructure: true,
    metadata: {
      container: "iso-bmff",
      majorBrand,
      topLevelBoxCount: topLevel.length,
      mediaDataBytes
    }
  });
}

async function inspectWav(file, size, assetType, extension) {
  if (size < 44) {
    fail("FILE_SIGNATURE_INVALID", "The WAV container is incomplete");
  }
  const head = await readExactly(file, 0, 12, "FILE_SIGNATURE_INVALID");
  if (head.subarray(0, 4).toString("ascii") !== "RIFF" ||
      head.subarray(8, 12).toString("ascii") !== "WAVE") {
    fail("FILE_SIGNATURE_INVALID", "The file is not a RIFF/WAVE container");
  }
  const riffSize = head.readUInt32LE(4);
  if (riffSize < 36 || riffSize + 8 !== size) {
    fail("FILE_SIGNATURE_INVALID", "The WAV RIFF length does not match the file");
  }
  let offset = 12;
  let chunkCount = 0;
  let format = null;
  let dataBytes = 0;
  while (offset < size) {
    if (size - offset < 8) {
      fail("FILE_SIGNATURE_INVALID", "A WAV chunk header is truncated");
    }
    const chunk = await readExactly(file, offset, 8, "FILE_SIGNATURE_INVALID");
    const chunkType = chunk.subarray(0, 4).toString("latin1");
    const chunkLength = chunk.readUInt32LE(4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (dataEnd < dataStart || paddedEnd > size) {
      fail("FILE_SIGNATURE_INVALID", "A WAV chunk points outside the RIFF container");
    }
    chunkCount += 1;
    if (chunkCount > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The WAV contains too many chunks");
    }
    if (chunkType === "fmt ") {
      if (format || chunkLength < 16 || chunkLength > 65536) {
        fail("FILE_SIGNATURE_INVALID", "The WAV fmt chunk is missing or invalid");
      }
      const fields = await readExactly(
        file,
        dataStart,
        Math.min(chunkLength, 40),
        "FILE_SIGNATURE_INVALID"
      );
      const audioFormat = fields.readUInt16LE(0);
      const channels = fields.readUInt16LE(2);
      const sampleRate = fields.readUInt32LE(4);
      const byteRate = fields.readUInt32LE(8);
      const blockAlign = fields.readUInt16LE(12);
      const bitsPerSample = fields.readUInt16LE(14);
      const linearFormat = audioFormat === 1 || audioFormat === 3 ||
        audioFormat === 0xfffe;
      if (audioFormat < 1 || audioFormat === 0xffff ||
          channels < 1 || channels > 32 || sampleRate < 1 ||
          byteRate < 1 || blockAlign < 1 || bitsPerSample > 64 ||
          (linearFormat && (bitsPerSample < 1 ||
            blockAlign !== channels * Math.ceil(bitsPerSample / 8) ||
            byteRate !== sampleRate * blockAlign)) ||
          (audioFormat === 3 && ![32, 64].includes(bitsPerSample)) ||
          (audioFormat === 0xfffe && chunkLength < 40)) {
        fail("FILE_SIGNATURE_INVALID", "The WAV audio format fields are inconsistent");
      }
      if (audioFormat === 0xfffe) {
        const extensionSize = fields.readUInt16LE(16);
        const validBits = fields.readUInt16LE(18);
        const subformat = fields.subarray(24, 40);
        const pcmGuid = Buffer.from("0100000000001000800000aa00389b71", "hex");
        const floatGuid = Buffer.from("0300000000001000800000aa00389b71", "hex");
        if (extensionSize < 22 || validBits < 1 || validBits > bitsPerSample ||
            (!subformat.equals(pcmGuid) && !subformat.equals(floatGuid))) {
          fail("FILE_SIGNATURE_INVALID", "The WAV extensible format is invalid");
        }
      }
      format = {
        audioFormat,
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample
      };
    } else if (chunkType === "data") {
      dataBytes += chunkLength;
      if (!Number.isSafeInteger(dataBytes)) {
        fail("FILE_SIGNATURE_INVALID", "The WAV audio data length is invalid");
      }
    }
    offset = paddedEnd;
  }
  if (offset !== size || !format || dataBytes < 1 || dataBytes % format.blockAlign !== 0) {
    fail("FILE_SIGNATURE_INVALID", "The WAV must contain fmt and non-empty aligned data chunks");
  }
  return baseInspection(assetType, extension, size, "wav", {
    needsManualStructure: true,
    metadata: {
      container: "riff-wave",
      channels: format.channels,
      sampleRateHz: format.sampleRate,
      bitsPerSample: format.bitsPerSample,
      dataBytes,
      durationSeconds: Number((dataBytes / format.byteRate).toFixed(3))
    }
  });
}

async function readJpegMarker(reader, position, size) {
  if (position >= size || (await reader.read(position, 1))[0] !== 0xff) {
    fail("FILE_SIGNATURE_INVALID", "The JPEG marker boundary is invalid");
  }
  const start = position;
  while (position < size && (await reader.read(position, 1))[0] === 0xff) {
    position += 1;
  }
  if (position >= size) {
    fail("FILE_SIGNATURE_INVALID", "The JPEG ends inside a marker");
  }
  const code = (await reader.read(position, 1))[0];
  if (code === 0x00) {
    fail("FILE_SIGNATURE_INVALID", "A stuffed JPEG byte appears outside scan data");
  }
  return { start, code, afterCode: position + 1 };
}

async function findJpegScanMarker(reader, position, size) {
  let offset = position;
  let hasEntropyData = false;
  while (offset < size) {
    const available = Math.min(STREAM_CHUNK_BYTES, size - offset);
    const chunk = await reader.read(offset, available);
    const relative = chunk.indexOf(0xff);
    if (relative < 0) {
      hasEntropyData = hasEntropyData || available > 0;
      offset += available;
      continue;
    }
    hasEntropyData = hasEntropyData || relative > 0;
    const markerStart = offset + relative;
    let codeOffset = markerStart + 1;
    while (codeOffset < size && (await reader.read(codeOffset, 1))[0] === 0xff) {
      codeOffset += 1;
    }
    if (codeOffset >= size) {
      fail("FILE_SIGNATURE_INVALID", "The JPEG scan ends inside a marker");
    }
    const code = (await reader.read(codeOffset, 1))[0];
    if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
      hasEntropyData = hasEntropyData || code === 0x00;
      offset = codeOffset + 1;
      continue;
    }
    if (!hasEntropyData) {
      fail("FILE_SIGNATURE_INVALID", "The JPEG scan has no entropy-coded data");
    }
    return markerStart;
  }
  fail("FILE_SIGNATURE_INVALID", "The JPEG scan has no end marker");
}

function isJpegSofMarker(code) {
  return (code >= 0xc0 && code <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(code));
}

async function inspectJpeg(file, size, assetType, extension) {
  if (size < 23) {
    fail("FILE_SIGNATURE_INVALID", "The JPEG image is incomplete");
  }
  const reader = new FileWindowReader(file, size);
  const soi = await reader.read(0, 2);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) {
    fail("FILE_SIGNATURE_INVALID", "The JPEG SOI marker is missing");
  }
  let offset = 2;
  let frame = null;
  let scanCount = 0;
  let markerCount = 1;
  while (offset < size) {
    const marker = await readJpegMarker(reader, offset, size);
    markerCount += 1;
    if (markerCount > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The JPEG contains too many markers");
    }
    if (marker.code === 0xd9) {
      if (!frame || scanCount < 1 || marker.afterCode !== size) {
        fail("FILE_SIGNATURE_INVALID", "The JPEG EOI marker is misplaced");
      }
      return baseInspection(assetType, extension, size, "jpeg", {
        needsManualStructure: false,
        metadata: {
          container: "jpeg",
          width: frame.width,
          height: frame.height,
          components: frame.components,
          progressive: frame.marker === 0xc2,
          scanCount
        }
      });
    }
    if (marker.code === 0xd8 || marker.code === 0x01 ||
        (marker.code >= 0xd0 && marker.code <= 0xd7)) {
      fail("FILE_SIGNATURE_INVALID", "A standalone JPEG marker is misplaced");
    }
    if (size - marker.afterCode < 2) {
      fail("FILE_SIGNATURE_INVALID", "A JPEG segment length is truncated");
    }
    const segmentLength = (await reader.read(marker.afterCode, 2)).readUInt16BE(0);
    const segmentEnd = marker.afterCode + segmentLength;
    if (segmentLength < 2 || segmentEnd > size) {
      fail("FILE_SIGNATURE_INVALID", "A JPEG segment points outside the file");
    }
    if (isJpegSofMarker(marker.code)) {
      if (frame || segmentLength < 11) {
        fail("FILE_SIGNATURE_INVALID", "The JPEG frame header is invalid");
      }
      const fields = await reader.read(marker.afterCode + 2, 6);
      const height = fields.readUInt16BE(1);
      const width = fields.readUInt16BE(3);
      const components = fields[5];
      if (![8, 12, 16].includes(fields[0]) || width < 1 || height < 1 ||
          components < 1 || components > 4 || segmentLength !== 8 + 3 * components) {
        fail("FILE_SIGNATURE_INVALID", "The JPEG dimensions or components are invalid");
      }
      frame = { marker: marker.code, width, height, components };
    } else if (marker.code === 0xda) {
      if (!frame || segmentLength < 8) {
        fail("FILE_SIGNATURE_INVALID", "The JPEG scan header is invalid");
      }
      const scanComponents = (await reader.read(marker.afterCode + 2, 1))[0];
      if (scanComponents < 1 || scanComponents > frame.components ||
          segmentLength !== 6 + 2 * scanComponents) {
        fail("FILE_SIGNATURE_INVALID", "The JPEG scan component list is invalid");
      }
      scanCount += 1;
      offset = await findJpegScanMarker(reader, segmentEnd, size);
      continue;
    }
    offset = segmentEnd;
  }
  fail("FILE_SIGNATURE_INVALID", "The JPEG EOI marker is missing");
}

async function inspectPng(file, size, assetType, extension) {
  if (size < 57) {
    fail("FILE_SIGNATURE_INVALID", "The PNG image is incomplete");
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!(await readExactly(file, 0, 8, "FILE_SIGNATURE_INVALID")).equals(signature)) {
    fail("FILE_SIGNATURE_INVALID", "The PNG signature is invalid");
  }
  let offset = 8;
  let chunkCount = 0;
  let dimensions = null;
  let paletteSeen = false;
  let idatBytes = 0;
  let seenIdat = false;
  let idatEnded = false;
  while (offset < size) {
    if (size - offset < 12) {
      fail("FILE_SIGNATURE_INVALID", "A PNG chunk is truncated");
    }
    const header = await readExactly(file, offset, 8, "FILE_SIGNATURE_INVALID");
    const chunkLength = header.readUInt32BE(0);
    const chunkType = header.subarray(4, 8).toString("ascii");
    const dataStart = offset + 8;
    const crcOffset = dataStart + chunkLength;
    const chunkEnd = crcOffset + 4;
    if (!/^[A-Za-z]{4}$/.test(chunkType) || !/[A-Z]/.test(chunkType[2]) ||
        chunkLength > 0x7fffffff ||
        crcOffset < dataStart || chunkEnd > size) {
      fail("FILE_SIGNATURE_INVALID", "A PNG chunk has invalid boundaries");
    }
    chunkCount += 1;
    if (chunkCount > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The PNG contains too many chunks");
    }
    const declaredCrc = (await readExactly(
      file,
      crcOffset,
      4,
      "FILE_SIGNATURE_INVALID"
    )).readUInt32BE(0);
    const actualCrc = await crc32FileRange(file, offset + 4, 4 + chunkLength);
    if (declaredCrc !== actualCrc) {
      fail("FILE_SIGNATURE_INVALID", "A PNG chunk failed its CRC check");
    }
    if (chunkType === "IHDR") {
      if (dimensions || chunkCount !== 1 || chunkLength !== 13) {
        fail("FILE_SIGNATURE_INVALID", "The PNG IHDR chunk is misplaced");
      }
      const ihdr = await readExactly(file, dataStart, 13, "FILE_SIGNATURE_INVALID");
      const width = ihdr.readUInt32BE(0);
      const height = ihdr.readUInt32BE(4);
      const bitDepth = ihdr[8];
      const colorType = ihdr[9];
      const validDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      };
      if (width < 1 || height < 1 || !validDepths[colorType] ||
          !validDepths[colorType].includes(bitDepth) ||
          ihdr[10] !== 0 || ihdr[11] !== 0 || ![0, 1].includes(ihdr[12])) {
        fail("FILE_SIGNATURE_INVALID", "The PNG IHDR fields are invalid");
      }
      dimensions = { width, height, bitDepth, colorType };
    } else if (!dimensions) {
      fail("FILE_SIGNATURE_INVALID", "The PNG IHDR chunk must be first");
    } else if (chunkType === "PLTE") {
      const paletteEntries = chunkLength / 3;
      if (paletteSeen || seenIdat || chunkLength < 3 || chunkLength > 768 ||
          chunkLength % 3 !== 0 || [0, 4].includes(dimensions.colorType) ||
          (dimensions.colorType === 3 &&
            paletteEntries > 2 ** dimensions.bitDepth)) {
        fail("FILE_SIGNATURE_INVALID", "The PNG palette chunk is invalid or misplaced");
      }
      paletteSeen = true;
    } else if (chunkType === "IDAT") {
      if (idatEnded) {
        fail("FILE_SIGNATURE_INVALID", "The PNG IDAT chunks are not consecutive");
      }
      if (dimensions.colorType === 3 && !paletteSeen) {
        fail("FILE_SIGNATURE_INVALID", "An indexed PNG is missing its palette");
      }
      seenIdat = true;
      idatBytes += chunkLength;
    } else if (chunkType !== "IEND") {
      if (/[A-Z]/.test(chunkType[0])) {
        fail("FILE_SIGNATURE_INVALID", "The PNG contains an unknown critical chunk");
      }
      if (seenIdat) {
        idatEnded = true;
      }
    }
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || !seenIdat || idatBytes < 1 || chunkEnd !== size) {
        fail("FILE_SIGNATURE_INVALID", "The PNG IEND or IDAT structure is invalid");
      }
      return baseInspection(assetType, extension, size, "png", {
        needsManualStructure: false,
        metadata: {
          ...dimensions,
          idatBytes,
          chunkCount
        }
      });
    }
    offset = chunkEnd;
  }
  fail("FILE_SIGNATURE_INVALID", "The PNG IEND chunk is missing");
}

async function validateWebpImageChunk(file, type, dataStart, length) {
  if (type === "VP8 ") {
    if (length < 11) {
      fail("FILE_SIGNATURE_INVALID", "The WebP VP8 frame is truncated");
    }
    const frame = await readExactly(file, dataStart, 10, "FILE_SIGNATURE_INVALID");
    const frameTag = frame[0] | (frame[1] << 8) | (frame[2] << 16);
    const firstPartitionLength = frameTag >>> 5;
    const width = frame.readUInt16LE(6) & 0x3fff;
    const height = frame.readUInt16LE(8) & 0x3fff;
    if ((frameTag & 1) !== 0 || firstPartitionLength < 7 ||
        3 + firstPartitionLength > length ||
        !frame.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a])) ||
        width < 1 || height < 1) {
      fail("FILE_SIGNATURE_INVALID", "The WebP VP8 key-frame header is invalid");
    }
    return { width, height, codec: "VP8" };
  }
  if (type === "VP8L") {
    if (length < 6) {
      fail("FILE_SIGNATURE_INVALID", "The WebP lossless frame is truncated");
    }
    const frame = await readExactly(file, dataStart, 5, "FILE_SIGNATURE_INVALID");
    const bits = frame.readUInt32LE(1);
    if (frame[0] !== 0x2f || (bits >>> 29) !== 0) {
      fail("FILE_SIGNATURE_INVALID", "The WebP lossless frame header is invalid");
    }
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      codec: "VP8L"
    };
  }
  return null;
}

async function inspectWebp(file, size, assetType, extension) {
  if (size < 26) {
    fail("FILE_SIGNATURE_INVALID", "The WebP container is incomplete");
  }
  const head = await readExactly(file, 0, 12, "FILE_SIGNATURE_INVALID");
  if (head.subarray(0, 4).toString("ascii") !== "RIFF" ||
      head.subarray(8, 12).toString("ascii") !== "WEBP" ||
      head.readUInt32LE(4) + 8 !== size) {
    fail("FILE_SIGNATURE_INVALID", "The WebP RIFF length or signature is invalid");
  }
  let offset = 12;
  let chunkCount = 0;
  let canvas = null;
  let image = null;
  while (offset < size) {
    if (size - offset < 8) {
      fail("FILE_SIGNATURE_INVALID", "A WebP chunk header is truncated");
    }
    const chunk = await readExactly(file, offset, 8, "FILE_SIGNATURE_INVALID");
    const type = chunk.subarray(0, 4).toString("ascii");
    const length = chunk.readUInt32LE(4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (!/^[\x20-\x7e]{4}$/.test(type) || dataEnd < dataStart || paddedEnd > size) {
      fail("FILE_SIGNATURE_INVALID", "A WebP chunk has invalid boundaries");
    }
    if ((length & 1) !== 0 && (await readExactly(
      file,
      dataEnd,
      1,
      "FILE_SIGNATURE_INVALID"
    ))[0] !== 0) {
      fail("FILE_SIGNATURE_INVALID", "A WebP chunk has invalid padding");
    }
    chunkCount += 1;
    if (chunkCount > MAX_CONTAINER_RECORDS) {
      fail("FILE_SIGNATURE_INVALID", "The WebP contains too many chunks");
    }
    if (type === "VP8X") {
      if (canvas || length !== 10) {
        fail("FILE_SIGNATURE_INVALID", "The WebP extended header is invalid");
      }
      const extended = await readExactly(file, dataStart, 10, "FILE_SIGNATURE_INVALID");
      if ((extended[0] & 0xc1) !== 0 || extended[1] !== 0 ||
          extended[2] !== 0 || extended[3] !== 0) {
        fail("FILE_SIGNATURE_INVALID", "The WebP extended header has reserved flags");
      }
      canvas = {
        width: extended.readUIntLE(4, 3) + 1,
        height: extended.readUIntLE(7, 3) + 1
      };
    } else if (type === "VP8 " || type === "VP8L") {
      if (image) {
        fail("FILE_SIGNATURE_INVALID", "The WebP contains multiple primary images");
      }
      image = await validateWebpImageChunk(file, type, dataStart, length);
    }
    offset = paddedEnd;
  }
  if (offset !== size || !image ||
      (canvas && (image.width > canvas.width || image.height > canvas.height))) {
    fail("FILE_SIGNATURE_INVALID", "The WebP has no valid image chunk");
  }
  return baseInspection(assetType, extension, size, "webp", {
    needsManualStructure: false,
    metadata: {
      container: "riff-webp",
      width: canvas ? canvas.width : image.width,
      height: canvas ? canvas.height : image.height,
      codec: image.codec,
      chunkCount
    }
  });
}

async function inspectByExtension(file, size, assetType, extension) {
  switch (extension) {
    case ".pdf": return inspectPdf(file, size, assetType, extension);
    case ".docx": return inspectDocx(file, size, assetType, extension);
    case ".mp3": return inspectMp3(file, size, assetType, extension);
    case ".m4a": return inspectM4a(file, size, assetType, extension);
    case ".wav": return inspectWav(file, size, assetType, extension);
    case ".jpg":
    case ".jpeg": return inspectJpeg(file, size, assetType, extension);
    case ".png": return inspectPng(file, size, assetType, extension);
    case ".webp": return inspectWebp(file, size, assetType, extension);
    default:
      fail("FILE_SIGNATURE_INVALID", "The reserved file extension is unsupported");
  }
}

async function inspectArtifact({ path: filePath, reservation } = {}) {
  const { assetType, extension } = validateReservationFormat(reservation);
  if (typeof filePath !== "string" || !filePath) {
    fail("FILE_SIGNATURE_INVALID", "The uploaded file path is invalid");
  }

  let file;
  try {
    file = await fs.open(filePath, "r");
    const stats = await file.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) {
      fail("FILE_SIGNATURE_INVALID", "The uploaded artifact is not a regular file");
    }
    return await inspectByExtension(file, stats.size, assetType, extension);
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error;
    }
    throw brokerFailure(
      extension === ".docx" ? "DOCX_ARCHIVE_INVALID" : "FILE_SIGNATURE_INVALID",
      "The uploaded artifact could not be inspected",
      error
    );
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

module.exports = { inspectArtifact };
