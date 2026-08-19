const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const FUNCTION_PATH = path.join(
  __dirname,
  "cloudfunctions/adminContentCenter/index.js"
);
const BROKER_ENV_KEY = "ADMIN_UPLOAD_BROKER_URL";
const BROKER_URL = "https://uploads.example.test/v1/admin-staging";

const IDS = Object.freeze({
  primary: "a".repeat(32),
  overwrite: "b".repeat(32),
  pending: "c".repeat(32),
  audio: "d".repeat(32),
  bypass: "e".repeat(32),
  audioCasOne: "f".repeat(32),
  audioCasTwo: "1".repeat(32),
  bookReplace: "2".repeat(32),
  bookPdfOne: "3".repeat(32),
  bookPdfTwo: "4".repeat(32),
  embeddedTopic: "5".repeat(32),
  embeddedManuscript: "6".repeat(32),
  automaticBook: "7".repeat(32),
  automaticBookUpdate: "8".repeat(32),
  emptyAutomaticBook: "9".repeat(32),
  sampleBook: "0".repeat(32)
});

function maskJavaScriptStringsAndComments(source) {
  const masked = Array.from(source, (character) =>
    character === "\n" || character === "\r" ? character : " "
  );
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
        masked[index] = character;
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }

    if (["single-quote", "double-quote", "template"].includes(state)) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      continue;
    }
    if (character === "`") {
      state = "template";
      continue;
    }

    masked[index] = character;
  }

  return masked.join("");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function findTransactionPromiseAllViolations(source) {
  const masked = maskJavaScriptStringsAndComments(source);
  const transactionCallbackPattern =
    /\.runTransaction\s*\(\s*(?:async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|async\s+function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\))\s*\{/g;
  const violations = [];
  let match;

  while ((match = transactionCallbackPattern.exec(masked))) {
    const openingBrace = masked.indexOf("{", match.index);
    let depth = 0;
    let closingBrace = -1;

    for (let index = openingBrace; index < masked.length; index += 1) {
      if (masked[index] === "{") depth += 1;
      if (masked[index] === "}") depth -= 1;
      if (depth === 0) {
        closingBrace = index;
        break;
      }
    }

    assert.notStrictEqual(
      closingBrace,
      -1,
      `Unclosed runTransaction callback at line ${lineNumberAt(source, match.index)}`
    );

    const callbackBody = masked.slice(openingBrace + 1, closingBrace);
    const promiseAllPattern = /\bPromise\s*\.\s*all\s*\(/g;
    let promiseAllMatch;
    while ((promiseAllMatch = promiseAllPattern.exec(callbackBody))) {
      const absoluteIndex = openingBrace + 1 + promiseAllMatch.index;
      violations.push({
        transactionLine: lineNumberAt(source, match.index),
        promiseAllLine: lineNumberAt(source, absoluteIndex)
      });
    }

    transactionCallbackPattern.lastIndex = closingBrace + 1;
  }

  return violations;
}

function testTransactionOperationsRemainSequential() {
  const unsafeFixture = `
    await Promise.all(outsideTransaction);
    await db.runTransaction(async (transaction) => {
      const rows = await Promise.all([
        transaction.collection("one").doc("a").get(),
        transaction.collection("two").doc("b").get()
      ]);
      return rows;
    });
  `;
  assert.strictEqual(
    findTransactionPromiseAllViolations(unsafeFixture).length,
    1,
    "transaction concurrency guard must detect Promise.all inside callbacks"
  );

  const functionRoot = path.join(__dirname, "cloudfunctions");
  const functionFiles = fs
    .readdirSync(functionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(functionRoot, entry.name, "index.js"))
    .filter((filename) => fs.existsSync(filename));

  for (const filename of functionFiles) {
    const source = fs.readFileSync(filename, "utf8");
    const violations = findTransactionPromiseAllViolations(source);
    assert.strictEqual(
      violations.length,
      0,
      `CloudBase transaction operations must stay sequential; Promise.all inside ` +
        `db.runTransaction can fail with TransactionBusy (${path.relative(__dirname, filename)}). ` +
        `Violations: ` +
        violations
          .map(
            ({ transactionLine, promiseAllLine }) =>
              `transaction line ${transactionLine}, Promise.all line ${promiseAllLine}`
          )
          .join("; ")
    );
  }
}

function clone(value) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }
  return value;
}

function matchesValue(actual, expected) {
  if (expected && expected.__memoryCommand === "and") {
    return expected.conditions.every((condition) =>
      matchesValue(actual, condition)
    );
  }
  if (expected && expected.__memoryCommand === "gte") {
    return actual >= expected.value;
  }
  if (expected && expected.__memoryCommand === "lt") {
    return actual < expected.value;
  }
  return actual === expected;
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) =>
    matchesValue(document[key], value)
  );
}

function valueAtPath(document, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce(
      (current, key) =>
        current && typeof current === "object" ? current[key] : undefined,
      document
    );
}

function setValueAtPath(document, path, value) {
  const keys = String(path || "").split(".").filter(Boolean);
  if (keys.length === 0) return;
  let current = document;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      current[key] = clone(value);
      return;
    }
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  });
}

function deleteValueAtPath(document, path) {
  const keys = String(path || "").split(".").filter(Boolean);
  if (keys.length === 0) return;
  let current = document;
  for (let index = 0; index < keys.length - 1; index += 1) {
    current = current && current[keys[index]];
    if (!current || typeof current !== "object") return;
  }
  delete current[keys[keys.length - 1]];
}

function projectDocument(document, projection) {
  if (!document || !projection || typeof projection !== "object") {
    return clone(document);
  }
  const entries = Object.entries(projection);
  const included = entries.filter(([, enabled]) => Boolean(enabled));
  if (included.length > 0) {
    const projected = {};
    if (
      Object.prototype.hasOwnProperty.call(document, "_id") &&
      projection._id !== false &&
      projection._id !== 0
    ) {
      projected._id = clone(document._id);
    }
    included.forEach(([path]) => {
      const value = valueAtPath(document, path);
      if (value !== undefined) setValueAtPath(projected, path, value);
    });
    return projected;
  }
  const projected = clone(document);
  entries.forEach(([path, enabled]) => {
    if (!enabled) deleteValueAtPath(projected, path);
  });
  return projected;
}

class MemoryQuery {
  constructor(database, collectionName, filter = null, transactionId = null) {
    this.database = database;
    this.collectionName = collectionName;
    this.filter = filter;
    this.transactionId = transactionId;
    this.projection = null;
    this.orders = [];
    this.offset = 0;
    this.maximum = Infinity;
  }

  where(filter) {
    this.filter = filter;
    return this;
  }

  orderBy(field, direction) {
    this.orders.push({ field, direction });
    return this;
  }

  skip(offset) {
    this.offset = offset;
    return this;
  }

  limit(maximum) {
    this.maximum = maximum;
    return this;
  }

  field(projection) {
    this.projection = clone(projection);
    return this;
  }

  async get() {
    const rows = this.database
      .documents(this.collectionName)
      .filter((document) => !this.filter || matches(document, this.filter));

    for (let index = this.orders.length - 1; index >= 0; index -= 1) {
      const { field, direction } = this.orders[index];
      const factor = direction === "desc" ? -1 : 1;
      rows.sort((left, right) => {
        if (left[field] === right[field]) return 0;
        return (left[field] < right[field] ? -1 : 1) * factor;
      });
    }

    const data = rows
      .slice(this.offset, this.offset + this.maximum)
      .map((document) => projectDocument(document, this.projection));
    this.database.recordTransactionRead(this.transactionId, {
      collectionName: this.collectionName,
      kind: "query",
      documentId: null,
      projection: clone(this.projection),
      topLevelFields: Array.from(
        new Set(data.flatMap((document) => Object.keys(document || {})))
      ),
      serializedBytes: Buffer.byteLength(JSON.stringify(data), "utf8")
    });
    return { data };
  }
}

class MemoryDatabase {
  constructor(seed = {}) {
    this.stores = new Map();
    this.clock = Date.now();
    this.transactionQueue = Promise.resolve();
    this.transactionSequence = 0;
    this.transactionReadLog = [];
    const comparison = (operator, value) => ({
      __memoryCommand: operator,
      value,
      and(other) {
        return {
          __memoryCommand: "and",
          conditions: [this, other]
        };
      }
    });
    this.command = {
      gte: (value) => comparison("gte", value),
      lt: (value) => comparison("lt", value)
    };

    Object.entries(seed).forEach(([name, documents]) => {
      this.stores.set(
        name,
        new Map(documents.map((document) => [document._id, clone(document)]))
      );
    });
  }

  store(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return this.stores.get(name);
  }

  documents(name) {
    return Array.from(this.store(name).values()).map(clone);
  }

  recordTransactionRead(transactionId, details) {
    if (transactionId === null || transactionId === undefined) return;
    this.transactionReadLog.push({ transactionId, ...details });
  }

  resetTransactionReadLog() {
    this.transactionReadLog = [];
  }

  transactionReadsSinceReset() {
    return this.transactionReadLog.map(clone);
  }

  collection(name, transactionId = null) {
    const database = this;
    const query = new MemoryQuery(database, name, null, transactionId);
    query.doc = (documentId) => {
      const createReference = (projection = null) => {
        const reference = {
          field(fields) {
            return createReference(clone(fields));
          },
          async get() {
            const fullDocument = database.store(name).has(documentId)
              ? clone(database.store(name).get(documentId))
              : null;
            const data = projectDocument(fullDocument, projection);
            database.recordTransactionRead(transactionId, {
              collectionName: name,
              kind: "document",
              documentId,
              projection: clone(projection),
              topLevelFields: Object.keys(data || {}),
              serializedBytes: Buffer.byteLength(JSON.stringify(data), "utf8")
            });
            return { data };
          },
          async set({ data }) {
            database.store(name).set(documentId, {
              _id: documentId,
              ...clone(data)
            });
          },
          async update({ data }) {
            const existing = database.store(name).get(documentId);
            if (!existing) {
              throw new Error(`missing ${name}/${documentId}`);
            }
            database.store(name).set(documentId, {
              ...existing,
              ...clone(data),
              _id: documentId
            });
          }
        };
        return reference;
      };
      return createReference();
    };
    return query;
  }

  serverDate() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  runTransaction(callback) {
    this.transactionSequence += 1;
    const transactionId = this.transactionSequence;
    const execution = this.transactionQueue.then(() =>
      callback({
        collection: (name) => this.collection(name, transactionId)
      })
    );
    this.transactionQueue = execution.catch(() => {});
    return execution;
  }
}

function adminAccount(id, openid, role) {
  return { _id: id, openid, role, status: "active" };
}

function validatedUpload({
  id,
  ownerAdminId = "uploader-a",
  ownerOpenid = "uploader-a-openid",
  assetType = "manuscript",
  relatedId = "article-one",
  preparedCloudPath,
  preparedFileID
}) {
  const audio = assetType === "audio";
  const fullBook = assetType === "full-book-pdf";
  const extension = audio ? ".mp3" : fullBook ? ".pdf" : ".docx";
  const mimeType = audio
    ? "audio/mpeg"
    : fullBook
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const originalFileName = audio
    ? "narration.mp3"
    : fullBook
      ? "complete-book.pdf"
      : "article.docx";
  const cloudPath = `admin-staging/${"0".repeat(24)}/${id}/source${extension}`;
  const derivedPreparedCloudPath = audio
    ? `published/audio/${relatedId}/assets/${id}/primary${extension}`
    : fullBook
      ? `protected/books/${relatedId}/assets/${id}/${relatedId}.pdf`
      : "";
  const finalPreparedCloudPath = preparedCloudPath === undefined
    ? derivedPreparedCloudPath
    : preparedCloudPath;
  const finalPreparedFileID = preparedFileID === undefined && finalPreparedCloudPath
    ? `cloud://test-environment/${finalPreparedCloudPath}`
    : preparedFileID || "";

  return {
    _id: id,
    ownerAdminId,
    ownerOpenid,
    assetType,
    originalFileName,
    extension,
    mimeType,
    declaredBytes: 4096,
    actualBytes: 4096,
    relationKind: fullBook ? "book" : "content",
    relatedId,
    cloudPath,
    fileID: `cloud://test-environment/${cloudPath}`,
    sha256: id[0].repeat(64),
    ticketStatus: "consumed",
    transportMode: "https-broker",
    transportStatus: "broker_uploaded",
    status: "uploaded",
    reviewStatus: "not_submitted",
    validationStatus: "validated",
    ingestionStatus: "validated",
    inspection: audio
      ? {
          schemaVersion: 1,
          signatureValid: true,
          assetType,
          extension,
          actualBytes: 4096,
          format: "mp3",
          metadata: {
            durationSeconds: 91.5,
            averageBitrateKbps: 128
          },
          paragraphCount: 0,
          embeddedImageCount: 0,
          needsManualStructure: false
        }
      : fullBook
        ? {
            schemaVersion: 1,
            signatureValid: true,
            assetType,
            extension,
            actualBytes: 4096,
            format: "pdf",
            pageCount: 24,
            paragraphCount: 0,
            embeddedImageCount: 0,
            needsManualStructure: true
          }
        : {
          schemaVersion: 1,
          signatureValid: true,
          assetType,
          extension,
          actualBytes: 4096,
          format: "docx",
          previewParagraphs: ["A validated article paragraph."],
          paragraphCount: 1,
          embeddedImageCount: 0,
          needsManualStructure: false
        },
    preparedCloudPath: finalPreparedCloudPath,
    preparedFileID: finalPreparedFileID,
    createdAt: new Date(),
    updateTime: new Date(),
    schemaVersion: 1
  };
}

function directTopicUploadWithEmbeddedImage() {
  const id = IDS.embeddedTopic;
  const relatedId = "topic-embedded";
  const ownerAdminId = "uploader-a";
  const ownerKey = crypto
    .createHash("sha256")
    .update(JSON.stringify(["admin-upload-owner", ownerAdminId]))
    .digest("hex")
    .slice(0, 24);
  const imageCloudPath =
    `protected/special-topics/${relatedId}/assets/${id}/embedded/0001.png`;
  const imageFileID = `cloud://test-environment/${imageCloudPath}`;
  return {
    _id: id,
    ownerAdminId,
    ownerOpenid: "uploader-a-openid",
    ownerKey,
    assetType: "special-topic",
    originalFileName: "embedded-topic.docx",
    extension: ".docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    declaredBytes: 4096,
    relationKind: "topic",
    relatedId,
    cloudPath: "",
    sourceMode: "client-manifest-only",
    originalFileUploadRequired: false,
    ticketStatus: "not_required",
    transportMode: "cloud-storage-direct",
    transportStatus: "direct_manifest_attached",
    status: "uploaded",
    reviewStatus: "not_submitted",
    validationStatus: "client_manifest_validated",
    rawFileValidationStatus: "not_uploaded",
    clientImageEnvironment: "test-environment",
    clientManifestSha256: "9".repeat(64),
    clientManifestHashScope: "client-parsed-docx-manifest",
    clientManifestMeta: {
      schemaVersion: 1,
      canonicalBytes: 512
    },
    clientImportStats: {
      entries: 1,
      blocks: 2,
      characters: 30,
      images: 1
    },
    clientDraftPayload: {
      topicId: relatedId,
      title: "Embedded topic",
      summary: "",
      producer: "",
      unlockCostStars: 0,
      sortOrder: 0,
      previewCoverFileID: "",
      entries: [{
        sortOrder: 10,
        blocks: [{ type: "text", text: "A paragraph before the image." }]
      }],
      structureConfirmed: false
    },
    clientImagePlacements: [{
      imageOrder: 1,
      relationId: "rImage1",
      packagePath: "word/media/image1.png",
      extension: ".png",
      caption: "Embedded caption",
      sourceBlockIndex: 1,
      sequence: 0,
      location: {
        kind: "special-topic-entry",
        entryIndex: 0,
        insertAtBlockIndex: 1
      }
    }],
    clientImageUploadPlan: [{
      imageOrder: 1,
      relationId: "rImage1",
      packagePath: "word/media/image1.png",
      extension: ".png",
      caption: "Embedded caption",
      cloudPath: imageCloudPath,
      maximumBytes: 20 * 1024 * 1024,
      status: "confirmed",
      fileID: imageFileID,
      objectExistsVerified: true,
      actualBytesVerified: false,
      signatureVerified: false,
      confirmedAt: new Date()
    }],
    createdAt: new Date(),
    updateTime: new Date(),
    schemaVersion: 1
  };
}

function directTopicUploadWithManyEmbeddedImages(
  imageCount = 200,
  entryCount = Math.ceil(imageCount / 100)
) {
  const upload = directTopicUploadWithEmbeddedImage();
  assert.ok(entryCount >= 1 && entryCount <= 200);
  assert.ok(imageCount >= entryCount && imageCount <= 200);
  const entries = Array.from(
    { length: entryCount },
    (_, entryIndex) => ({
      sortOrder: (entryIndex + 1) * 10,
      blocks: [{
        type: "text",
        text: `Text before embedded image group ${entryIndex + 1}.`
      }]
    })
  );
  const placements = [];
  const uploadPlan = [];
  const entryImageSequences = Array(entryCount).fill(0);

  for (let imageOrder = 1; imageOrder <= imageCount; imageOrder += 1) {
    const entryIndex = Math.min(
      entryCount - 1,
      Math.floor(((imageOrder - 1) * entryCount) / imageCount)
    );
    const sequence = entryImageSequences[entryIndex];
    entryImageSequences[entryIndex] += 1;
    const paddedOrder = String(imageOrder).padStart(4, "0");
    const cloudPath =
      `protected/special-topics/${upload.relatedId}/assets/` +
      `${upload._id}/embedded/${paddedOrder}.png`;
    const fileID = `cloud://test-environment/${cloudPath}`;

    placements.push({
      imageOrder,
      relationId: `rImage${imageOrder}`,
      packagePath: `word/media/image${imageOrder}.png`,
      extension: ".png",
      caption: `Embedded caption ${imageOrder}`,
      sourceBlockIndex: imageOrder,
      sequence,
      location: {
        kind: "special-topic-entry",
        entryIndex,
        insertAtBlockIndex: 1
      }
    });
    uploadPlan.push({
      imageOrder,
      relationId: `rImage${imageOrder}`,
      packagePath: `word/media/image${imageOrder}.png`,
      extension: ".png",
      caption: `Embedded caption ${imageOrder}`,
      cloudPath,
      maximumBytes: 20 * 1024 * 1024,
      status: "confirmed",
      fileID,
      objectExistsVerified: true,
      actualBytesVerified: false,
      signatureVerified: false,
      confirmedAt: new Date()
    });
  }

  upload.clientDraftPayload = {
    ...upload.clientDraftPayload,
    entries
  };
  upload.clientImagePlacements = placements;
  upload.clientImageUploadPlan = uploadPlan;
  upload.clientImportStats = {
    entries: entries.length,
    blocks: entries.length,
    characters: entries.reduce(
      (total, entry) => total + entry.blocks[0].text.length,
      0
    ),
    images: imageCount
  };
  upload.clientManifestMeta = {
    schemaVersion: 1,
    canonicalBytes: 256 * 1024
  };
  return upload;
}

function directManuscriptUploadWithEmbeddedImage() {
  const id = IDS.embeddedManuscript;
  const relatedId = "article-embedded";
  const ownerAdminId = "uploader-a";
  const ownerKey = crypto
    .createHash("sha256")
    .update(JSON.stringify(["admin-upload-owner", ownerAdminId]))
    .digest("hex")
    .slice(0, 24);
  const imageCloudPath =
    `protected/contents/${relatedId}/assets/${id}/embedded/0001.png`;
  const imageFileID = `cloud://test-environment/${imageCloudPath}`;
  return {
    _id: id,
    ownerAdminId,
    ownerOpenid: "uploader-a-openid",
    ownerKey,
    assetType: "manuscript",
    originalFileName: "embedded-article.docx",
    extension: ".docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    declaredBytes: 4096,
    relationKind: "content",
    relatedId,
    cloudPath: "",
    sourceMode: "client-manifest-only",
    originalFileUploadRequired: false,
    ticketStatus: "not_required",
    transportMode: "cloud-storage-direct",
    transportStatus: "direct_manifest_attached",
    status: "uploaded",
    reviewStatus: "not_submitted",
    validationStatus: "client_manifest_validated",
    rawFileValidationStatus: "not_uploaded",
    clientImageEnvironment: "test-environment",
    clientManifestSha256: "8".repeat(64),
    clientManifestHashScope: "client-parsed-docx-manifest",
    clientManifestMeta: {
      schemaVersion: 1,
      canonicalBytes: 512
    },
    clientImportStats: {
      sections: 1,
      paragraphs: 2,
      characters: 40,
      images: 1
    },
    clientDraftPayload: {
      contentId: relatedId,
      bookId: "china-hospital-ship",
      title: "Embedded article",
      subtitle: "",
      sourceLabel: "Editorial desk",
      department: "",
      catalogViews: ["book"],
      sortOrder: 0,
      coverFileID: "",
      disclaimer: "",
      sections: [{
        kind: "story",
        heading: "",
        paragraphs: [
          "A paragraph before the image.",
          "A paragraph after the image."
        ]
      }],
      structureConfirmed: false
    },
    clientImagePlacements: [{
      imageOrder: 1,
      relationId: "rImage1",
      packagePath: "word/media/image1.png",
      extension: ".png",
      caption: "Article embedded caption",
      sourceBlockIndex: 1,
      sequence: 0,
      location: {
        kind: "manuscript-section",
        sectionIndex: 0,
        afterParagraphIndex: 0
      }
    }],
    clientImageUploadPlan: [{
      imageOrder: 1,
      relationId: "rImage1",
      packagePath: "word/media/image1.png",
      extension: ".png",
      caption: "Article embedded caption",
      cloudPath: imageCloudPath,
      maximumBytes: 20 * 1024 * 1024,
      status: "confirmed",
      fileID: imageFileID,
      objectExistsVerified: true,
      actualBytesVerified: false,
      signatureVerified: false,
      confirmedAt: new Date()
    }],
    createdAt: new Date(),
    updateTime: new Date(),
    schemaVersion: 1
  };
}

function loadAdminContentCenter(
  database,
  openid,
  files = new Set(),
  storageMetrics = null
) {
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {},
    async getTempFileURL({ fileList }) {
      if (storageMetrics) {
        const requestedFileIDs = fileList.map((item) =>
          typeof item === "string" ? item : item.fileID
        );
        storageMetrics.getTempFileURLCalls =
          Number(storageMetrics.getTempFileURLCalls) + 1;
        storageMetrics.requestedFileIDs.push(...requestedFileIDs);
        if (Array.isArray(storageMetrics.requestedBatches)) {
          storageMetrics.requestedBatches.push(requestedFileIDs);
        }
      }
      return {
        fileList: fileList.map((item) => {
          const fileID = typeof item === "string" ? item : item.fileID;
          return files.has(fileID)
            ? { fileID, status: 0, tempFileURL: "https://temporary.invalid/file" }
            : { fileID, status: -1, errMsg: "not found" };
        })
      };
    }
  };
  const originalLoad = Module._load;

  delete require.cache[require.resolve(FUNCTION_PATH)];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(FUNCTION_PATH).main;
  } finally {
    Module._load = originalLoad;
  }
}

function loadReaderFunction(relativePath, database, openid) {
  const functionPath = path.join(__dirname, relativePath);
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };
  const originalLoad = Module._load;
  delete require.cache[require.resolve(functionPath)];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(functionPath).main;
  } finally {
    Module._load = originalLoad;
  }
}

function seedAccounts() {
  return [
    adminAccount("uploader-a", "uploader-a-openid", "uploader"),
    adminAccount("uploader-b", "uploader-b-openid", "uploader"),
    adminAccount("reviewer-a", "reviewer-a-openid", "content-reviewer"),
    adminAccount("admin-a", "admin-a-openid", "admin")
  ];
}

function mains(database, files = new Set(), storageMetrics = null) {
  return {
    uploaderA: loadAdminContentCenter(
      database,
      "uploader-a-openid",
      files,
      storageMetrics
    ),
    uploaderB: loadAdminContentCenter(
      database,
      "uploader-b-openid",
      files,
      storageMetrics
    ),
    reviewer: loadAdminContentCenter(
      database,
      "reviewer-a-openid",
      files,
      storageMetrics
    ),
    admin: loadAdminContentCenter(
      database,
      "admin-a-openid",
      files,
      storageMetrics
    )
  };
}

function storageFilesFor(database) {
  const files = new Set();
  database.documents("adminUploads").forEach((upload) => {
    if (upload.fileID) files.add(upload.fileID);
    if (upload.preparedFileID) files.add(upload.preparedFileID);
  });
  return files;
}

function assertPublicDraftBases(draft, publishedRevision, assetRevision) {
  assert.strictEqual(draft.basePublishedRevision, publishedRevision);
  assert.strictEqual(draft.baseAssetRevision, assetRevision);
}

async function createApprovedDraft({
  uploader,
  reviewer,
  uploadId,
  requestPrefix,
  draftPatch = null,
  expectedBasePublishedRevision,
  expectedBaseAssetRevision
}) {
  let current = await uploader({
    action: "createDraftFromUpload",
    uploadId,
    requestId: `${requestPrefix}-create-0001`
  });
  assert.strictEqual(
    current.success,
    true,
    `${requestPrefix}: create draft ${JSON.stringify(current)}`
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(current.draft, "basePublishedRevision"),
    true
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(current.draft, "baseAssetRevision"),
    true
  );
  if (expectedBasePublishedRevision !== undefined) {
    assertPublicDraftBases(
      current.draft,
      expectedBasePublishedRevision,
      expectedBaseAssetRevision || ""
    );
  }

  let patch = draftPatch;
  if (current.draft.assetType === "manuscript") {
    patch = { structureConfirmed: true, ...(patch || {}) };
  } else if (
    current.draft.assetType === "full-book-pdf" &&
    current.draft.payload.structureMode === "replace"
  ) {
    patch = {
      title: current.draft.payload.title || "Complete book",
      structureMode: "replace",
      chapters: [{
        chapterId: "chapter-one",
        title: "Chapter one",
        sortOrder: 10,
        sections: [{
          kind: "story",
          heading: "",
          paragraphs: ["A complete first chapter."]
        }]
      }],
      structureConfirmed: true,
      ...(patch || {})
    };
  }
  if (patch) {
    current = await uploader({
      action: "saveDraft",
      draftId: uploadId,
      expectedDraftVersion: current.draft.draftVersion,
      patch,
      requestId: `${requestPrefix}-confirm-0001`
    });
    assert.strictEqual(current.success, true, `${requestPrefix}: save draft`);
  }

  const submitted = await uploader({
    action: "submitDraft",
    draftId: uploadId,
    expectedDraftVersion: current.draft.draftVersion,
    requestId: `${requestPrefix}-submit-0001`
  });
  assert.strictEqual(submitted.success, true, `${requestPrefix}: submit draft`);
  assert.match(submitted.draft.snapshotHash, /^[a-f0-9]{64}$/);

  const unpreviewed = await reviewer({
    action: "reviewDraft",
    draftId: uploadId,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: `${requestPrefix}-review-unpreviewed-0001`
  });
  assert.strictEqual(
    unpreviewed.code,
    "DRAFT_ASSET_PREVIEW_REQUIRED",
    `${requestPrefix}: approval must require preview`
  );

  const preview = await reviewer({
    action: "getDraftAssetPreview",
    draftId: uploadId,
    expectedSnapshotHash: submitted.draft.snapshotHash
  });
  assert.strictEqual(preview.success, true, `${requestPrefix}: preview asset`);
  assert.strictEqual(preview.snapshotHash, submitted.draft.snapshotHash);
  if (preview.previewKind === "structured") {
    assert.strictEqual(preview.previewUrl, undefined);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(preview, "payload"),
      false,
      `${requestPrefix}: structured preview metadata must not echo the draft payload`
    );
  } else {
    assert.match(preview.previewUrl, /^https:\/\/temporary\.invalid\//);
  }

  const approved = await reviewer({
    action: "reviewDraft",
    draftId: uploadId,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: `${requestPrefix}-review-0001`
  });
  assert.strictEqual(approved.success, true, `${requestPrefix}: approve draft`);
  assert.strictEqual(approved.draft.state, "approved");
  return approved.draft;
}

async function publishUntilSettled(
  publish,
  payload,
  maximumAttempts = 50
) {
  const attempts = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const result = await publish({ ...payload });
    attempts.push(result);
    if (!result || result.success !== true || result.pending !== true) {
      return { attempts, result };
    }
  }
  assert.fail(
    `publish remained pending after ${maximumAttempts} attempts: ` +
      JSON.stringify(attempts[attempts.length - 1])
  );
}

async function publishUntilSettledWithTransactionReads(
  database,
  publish,
  payload,
  maximumAttempts = 50,
  observe = null
) {
  const attempts = [];
  const transactionReadsByAttempt = [];
  const observations = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    database.resetTransactionReadLog();
    const result = await publish({ ...payload });
    attempts.push(result);
    transactionReadsByAttempt.push(database.transactionReadsSinceReset());
    observations.push(
      typeof observe === "function"
        ? clone(observe(result, attempt))
        : null
    );
    if (!result || result.success !== true || result.pending !== true) {
      return { attempts, result, transactionReadsByAttempt, observations };
    }
  }
  assert.fail(
    `publish remained pending after ${maximumAttempts} attempts: ` +
      JSON.stringify(attempts[attempts.length - 1])
  );
}

function visibleSpecialTopicEntries(database, topicId) {
  const topic = database.store("specialTopics").get(topicId);
  if (!topic || topic.status !== "published" || !topic.currentRevision) {
    return [];
  }
  return database
    .documents("specialTopicEntries")
    .filter(
      (entry) =>
        entry.topicId === topicId &&
        entry.topicRevision === topic.currentRevision &&
        entry.status === "published"
    );
}

function assertFinalTransactionUsesOnlyLightweightDraftProjection(reads, draftId) {
  const draftReads = reads.filter(
    (read) =>
      read.collectionName === "adminContentDrafts" &&
      (read.documentId === null || read.documentId === draftId)
  );
  assert.ok(
    draftReads.length > 0,
    "final publication transaction must re-read the approved draft guard"
  );
  draftReads.forEach((read) => {
    assert.ok(
      read.projection && typeof read.projection === "object",
      "final commit must project a lightweight draft guard instead of loading the full draft"
    );
    const includedPaths = Object.entries(read.projection)
      .filter(([, included]) => Boolean(included))
      .map(([path]) => path);
    ["payload.entries", "payload.embeddedAssets", "embeddedAssets"].forEach(
      (largePath) => {
        assert.strictEqual(
          includedPaths.some(
            (path) => path === largePath || path.startsWith(`${largePath}.`)
          ),
          false,
          `final transaction must not project the large ${largePath} field`
        );
      }
    );
    assert.strictEqual(
      read.topLevelFields.includes("embeddedAssets"),
      false,
      "final transaction must not read the large embedded-asset manifest"
    );
    assert.ok(
      read.serializedBytes < 32 * 1024,
      `projected publication guard is unexpectedly large: ${read.serializedBytes} bytes`
    );
  });
}

async function testRolesEditingConflictsIdempotencyAndIsolation() {
  const bypassUpload = validatedUpload({ id: IDS.bypass });
  bypassUpload.status = "pending_upload";
  bypassUpload.ticketStatus = "active";
  bypassUpload.transportStatus = "ticket_issued";
  bypassUpload.validationStatus = "awaiting_upload";
  delete bypassUpload.actualBytes;
  delete bypassUpload.sha256;

  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [
      validatedUpload({ id: IDS.primary }),
      bypassUpload
    ]
  });
  const files = storageFilesFor(database);
  const { uploaderA, uploaderB, reviewer, admin } = mains(database, files);

  const reviewerStatus = await reviewer({ action: "status" });
  assert.strictEqual(reviewerStatus.success, true);
  assert.strictEqual(reviewerStatus.capabilities.upload, false);
  assert.strictEqual(reviewerStatus.capabilities.drafts, false);
  assert.strictEqual(reviewerStatus.capabilities.review, true);
  assert.strictEqual(reviewerStatus.capabilities.publish, false);

  const reviewerUpload = await reviewer({
    action: "createUpload",
    assetType: "manuscript",
    fileName: "article.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    declaredBytes: 100,
    contentId: "article-one"
  });
  assert.strictEqual(reviewerUpload.code, "UPLOAD_FORBIDDEN");

  const pendingConfirm = await uploaderA({
    action: "confirmUpload",
    uploadId: IDS.bypass,
    cloudPath: bypassUpload.cloudPath,
    fileID: bypassUpload.fileID
  });
  assert.strictEqual(pendingConfirm.success, false);
  assert.strictEqual(pendingConfirm.code, "UPLOAD_NOT_BROKER_CONFIRMED");
  assert.strictEqual(database.store("adminUploads").get(IDS.bypass).status, "pending_upload");

  const createEvent = {
    action: "createDraftFromUpload",
    uploadId: IDS.primary,
    requestId: "primary-create-0001"
  };
  const created = await uploaderA(createEvent);
  assert.strictEqual(created.success, true);
  assert.strictEqual(created.alreadyApplied, false);
  assert.strictEqual(created.draft.state, "editing");
  assert.strictEqual(created.draft.draftVersion, 1);
  assertPublicDraftBases(created.draft, "", "");

  const createReplay = await uploaderA(createEvent);
  assert.strictEqual(createReplay.success, true);
  assert.strictEqual(createReplay.alreadyApplied, true);
  assert.strictEqual(createReplay.draft.draftVersion, 1);

  const crossCreate = await uploaderB({
    ...createEvent,
    requestId: "cross-create-0001"
  });
  assert.strictEqual(crossCreate.code, "DRAFT_NOT_FOUND");
  const crossGet = await uploaderB({ action: "getDraft", draftId: IDS.primary });
  assert.strictEqual(crossGet.code, "DRAFT_NOT_FOUND");

  const reviewerSave = await reviewer({
    action: "saveDraft",
    draftId: IDS.primary,
    expectedDraftVersion: 1,
    patch: { title: "Reviewer must not edit" },
    requestId: "reviewer-save-denied-0001"
  });
  assert.strictEqual(reviewerSave.code, "DRAFT_NOT_FOUND");

  const saveEvent = {
    action: "saveDraft",
    draftId: IDS.primary,
    expectedDraftVersion: 1,
    patch: {
      title: "A carefully edited title",
      sourceLabel: "Editorial desk",
      catalogViews: ["book", "summary"],
      sections: [{
        kind: "story",
        heading: "Opening",
        paragraphs: ["The final reviewed manuscript body."]
      }],
      structureConfirmed: true
    },
    requestId: "primary-save-0001"
  };
  const saved = await uploaderA(saveEvent);
  assert.strictEqual(saved.success, true);
  assert.strictEqual(saved.draft.draftVersion, 2);
  assert.strictEqual(saved.draft.payload.title, "A carefully edited title");

  const saveReplay = await uploaderA(saveEvent);
  assert.strictEqual(saveReplay.success, true);
  assert.strictEqual(saveReplay.alreadyApplied, true);
  assert.strictEqual(saveReplay.draft.draftVersion, 2);

  const reusedRequestId = await uploaderA({
    ...saveEvent,
    patch: { ...saveEvent.patch, title: "Different mutation" }
  });
  assert.strictEqual(reusedRequestId.code, "IDEMPOTENCY_KEY_REUSED");

  const staleVersion = await uploaderA({
    ...saveEvent,
    requestId: "primary-save-stale-0001"
  });
  assert.strictEqual(staleVersion.code, "DRAFT_VERSION_CONFLICT");

  const crossSave = await uploaderB({
    ...saveEvent,
    expectedDraftVersion: 2,
    requestId: "cross-save-0001"
  });
  assert.strictEqual(crossSave.code, "DRAFT_NOT_FOUND");

  const submitEvent = {
    action: "submitDraft",
    draftId: IDS.primary,
    expectedDraftVersion: 2,
    requestId: "primary-submit-0001"
  };
  const submitted = await uploaderA(submitEvent);
  assert.strictEqual(submitted.success, true, JSON.stringify(submitted));
  assert.strictEqual(submitted.draft.state, "in_review");
  assert.strictEqual(submitted.draft.draftVersion, 3);
  assert.match(submitted.draft.snapshotHash, /^[a-f0-9]{64}$/);

  const submitReplay = await uploaderA(submitEvent);
  assert.strictEqual(submitReplay.success, true);
  assert.strictEqual(submitReplay.alreadyApplied, true);
  assert.strictEqual(submitReplay.draft.draftVersion, 3);

  const staleSnapshot = await reviewer({
    action: "reviewDraft",
    draftId: IDS.primary,
    expectedSnapshotHash: "0".repeat(64),
    decision: "approve",
    note: "",
    requestId: "primary-review-stale-0001"
  });
  assert.strictEqual(staleSnapshot.code, "DRAFT_SNAPSHOT_CHANGED");

  const reviewEvent = {
    action: "reviewDraft",
    draftId: IDS.primary,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: "primary-review-0001"
  };
  const unpreviewed = await reviewer(reviewEvent);
  assert.strictEqual(unpreviewed.code, "DRAFT_ASSET_PREVIEW_REQUIRED");

  const preview = await reviewer({
    action: "getDraftAssetPreview",
    draftId: IDS.primary,
    expectedSnapshotHash: submitted.draft.snapshotHash
  });
  assert.strictEqual(preview.success, true);
  assert.strictEqual(preview.snapshotHash, submitted.draft.snapshotHash);
  assert.match(preview.previewUrl, /^https:\/\/temporary\.invalid\//);

  const approved = await reviewer(reviewEvent);
  assert.strictEqual(approved.success, true);
  assert.strictEqual(approved.draft.state, "approved");

  const reviewReplay = await reviewer(reviewEvent);
  assert.strictEqual(reviewReplay.success, true);
  assert.strictEqual(reviewReplay.alreadyApplied, true);

  const publishEvent = {
    action: "publishDraft",
    draftId: IDS.primary,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    expectedTargetRevision: "",
    requestId: "primary-publish-0001"
  };
  const reviewerPublish = await reviewer(publishEvent);
  assert.strictEqual(reviewerPublish.code, "CONTENT_PUBLISH_FORBIDDEN");
  assert.strictEqual(database.documents("contents").length, 0);

  const published = await admin(publishEvent);
  assert.strictEqual(published.success, true);
  assert.strictEqual(published.draft.state, "published");
  assert.strictEqual(database.store("contents").get("article-one").contentId, "article-one");

  const publishReplay = await admin(publishEvent);
  assert.strictEqual(publishReplay.success, true);
  assert.strictEqual(publishReplay.alreadyApplied, true);
  assert.strictEqual(database.documents("adminPublishedRevisions").length, 1);
}

async function testStableOverwritePreservesReaderCollectionsAndPendingBlocks() {
  const oldRevision = `r-${"1".repeat(32)}`;
  const oldContent = {
    _id: "article-stable",
    contentId: "article-stable",
    bookId: "china-hospital-ship",
    currentRevision: oldRevision,
    audioRevision: "",
    pendingReviewCount: 0,
    title: "Old title",
    sections: [{ paragraphs: ["Old body"] }],
    status: "published",
    reviewStatus: "approved",
    customFieldToArchive: "previous value"
  };
  const records = [{
    _id: "record-one",
    memberId: "member-one",
    contentId: "article-stable",
    status: "approved",
    reflection: "Reader history must survive."
  }];
  const rewardLedger = [{
    _id: "reward-one",
    memberId: "member-one",
    contentId: "article-stable",
    delta: 50,
    reason: "reflection"
  }];
  const bookEntitlements = [{
    _id: "entitlement-one",
    memberId: "member-one",
    bookId: "china-hospital-ship",
    status: "active"
  }];
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [
      validatedUpload({ id: IDS.overwrite, relatedId: "article-stable" }),
      validatedUpload({ id: IDS.pending, relatedId: "article-stable" })
    ],
    contents: [oldContent],
    records,
    rewardLedger,
    bookEntitlements
  });
  const files = storageFilesFor(database);
  const { uploaderA, reviewer, admin } = mains(database, files);
  const recordsBefore = database.documents("records");
  const rewardsBefore = database.documents("rewardLedger");
  const entitlementsBefore = database.documents("bookEntitlements");

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.overwrite,
    requestPrefix: "overwrite",
    expectedBasePublishedRevision: oldRevision,
    expectedBaseAssetRevision: ""
  });
  const staleTarget = await admin({
    action: "publishDraft",
    draftId: IDS.overwrite,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: `r-${"2".repeat(32)}`,
    requestId: "overwrite-publish-stale-0001"
  });
  assert.strictEqual(staleTarget.code, "TARGET_REVISION_CONFLICT");
  assert.deepStrictEqual(database.store("contents").get("article-stable"), oldContent);

  const published = await admin({
    action: "publishDraft",
    draftId: IDS.overwrite,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: oldRevision,
    requestId: "overwrite-publish-0001"
  });
  assert.strictEqual(published.success, true);

  const stableRows = database
    .documents("contents")
    .filter((document) => document._id === "article-stable");
  assert.strictEqual(stableRows.length, 1);
  assert.strictEqual(stableRows[0].contentId, "article-stable");
  assert.strictEqual(stableRows[0].currentRevision, `r-${IDS.overwrite}`);
  assert.notStrictEqual(stableRows[0].title, oldContent.title);
  assert.deepStrictEqual(database.documents("records"), recordsBefore);
  assert.deepStrictEqual(database.documents("rewardLedger"), rewardsBefore);
  assert.deepStrictEqual(database.documents("bookEntitlements"), entitlementsBefore);

  const revision = database.store("adminPublishedRevisions").get(IDS.overwrite);
  assert.strictEqual(revision.previousRevision, oldRevision);
  assert.strictEqual(revision.previousDocument.customFieldToArchive, "previous value");

  const blockedDraft = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.pending,
    requestPrefix: "pending",
    expectedBasePublishedRevision: `r-${IDS.overwrite}`,
    expectedBaseAssetRevision: ""
  });
  database.store("contents").get("article-stable").pendingReviewCount = 1;
  const contentBeforeBlockedPublish = clone(
    database.store("contents").get("article-stable")
  );
  const blocked = await admin({
    action: "publishDraft",
    draftId: IDS.pending,
    expectedSnapshotHash: blockedDraft.snapshotHash,
    expectedTargetRevision: contentBeforeBlockedPublish.currentRevision,
    requestId: "pending-publish-0001"
  });
  assert.strictEqual(blocked.success, false);
  assert.strictEqual(blocked.code, "PENDING_READER_REVIEWS");
  assert.deepStrictEqual(
    database.store("contents").get("article-stable"),
    contentBeforeBlockedPublish
  );
  assert.strictEqual(database.store("adminContentDrafts").get(IDS.pending).state, "approved");
}

async function testAudioRequiresExactPreparedPath() {
  const contentRevision = `r-${"9".repeat(32)}`;
  const exactPath = `published/audio/audio-article/assets/${IDS.audio}/primary.mp3`;
  const wrongFilePath = `published/audio/audio-article/assets/${"f".repeat(32)}/primary.mp3`;
  const upload = validatedUpload({
    id: IDS.audio,
    assetType: "audio",
    relatedId: "audio-article"
  });
  assert.strictEqual(upload.preparedCloudPath, exactPath);
  assert.strictEqual(upload.preparedFileID, `cloud://test-environment/${exactPath}`);
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload],
    contents: [{
      _id: "audio-article",
      contentId: "audio-article",
      currentRevision: contentRevision,
      audioRevision: "",
      pendingReviewCount: 0,
      title: "Published text",
      status: "published",
      reviewStatus: "approved"
    }]
  });
  const files = storageFilesFor(database);
  assert.strictEqual(files.has(upload.fileID), true);
  assert.strictEqual(files.has(upload.preparedFileID), true);
  const { uploaderA, reviewer, admin } = mains(database, files);
  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.audio,
    requestPrefix: "audio",
    expectedBasePublishedRevision: contentRevision,
    expectedBaseAssetRevision: ""
  });
  assert.strictEqual(approved.payload.durationSeconds, 91.5);
  assert.strictEqual(approved.payload.bitrate, 128000);

  database.store("adminContentDrafts").get(IDS.audio).preparedFileID =
    `cloud://test-environment/${wrongFilePath}`;
  const changedAfterApproval = await admin({
    action: "publishDraft",
    draftId: IDS.audio,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: contentRevision,
    requestId: "audio-publish-tampered-0001"
  });
  assert.strictEqual(changedAfterApproval.success, false);
  assert.strictEqual(changedAfterApproval.code, "DRAFT_SNAPSHOT_CHANGED");
  assert.strictEqual(database.documents("audioTracks").length, 0);

  database.store("adminContentDrafts").get(IDS.audio).preparedFileID =
    `cloud://test-environment/${exactPath}`;
  files.delete(`cloud://test-environment/${exactPath}`);
  const missingPreparedAsset = await admin({
    action: "publishDraft",
    draftId: IDS.audio,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: contentRevision,
    requestId: "audio-publish-missing-0001"
  });
  assert.strictEqual(missingPreparedAsset.success, false);
  assert.strictEqual(missingPreparedAsset.code, "PUBLISH_ASSET_NOT_FOUND");
  assert.strictEqual(database.documents("audioTracks").length, 0);

  files.add(`cloud://test-environment/${exactPath}`);
  const published = await admin({
    action: "publishDraft",
    draftId: IDS.audio,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: contentRevision,
    requestId: "audio-publish-exact-0001"
  });
  assert.strictEqual(published.success, true);
  const track = database.store("audioTracks").get("audio-article-primary");
  assert.strictEqual(track.fileID, `cloud://test-environment/${exactPath}`);
  assert.strictEqual(track.contentRevision, contentRevision);
  assert.strictEqual(track.audioRevision, `r-${IDS.audio}`);
  assert.strictEqual(
    database.store("contents").get("audio-article").currentRevision,
    contentRevision
  );
}

async function testAudioRevisionCompareAndSwap() {
  const contentRevision = `r-${"5".repeat(32)}`;
  const audioRevision = `r-${"6".repeat(32)}`;
  const uploads = [
    validatedUpload({
      id: IDS.audioCasOne,
      assetType: "audio",
      relatedId: "audio-cas-article"
    }),
    validatedUpload({
      id: IDS.audioCasTwo,
      assetType: "audio",
      relatedId: "audio-cas-article"
    })
  ];
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: uploads,
    contents: [{
      _id: "audio-cas-article",
      contentId: "audio-cas-article",
      currentRevision: contentRevision,
      audioRevision,
      pendingReviewCount: 0,
      title: "Published article",
      status: "published",
      reviewStatus: "approved"
    }]
  });
  const files = storageFilesFor(database);
  uploads.forEach((upload) => {
    assert.strictEqual(files.has(upload.fileID), true);
    assert.strictEqual(files.has(upload.preparedFileID), true);
  });
  const { uploaderA, reviewer, admin } = mains(database, files);
  const first = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.audioCasOne,
    requestPrefix: "audio-cas-one",
    expectedBasePublishedRevision: contentRevision,
    expectedBaseAssetRevision: audioRevision
  });
  const second = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.audioCasTwo,
    requestPrefix: "audio-cas-two",
    expectedBasePublishedRevision: contentRevision,
    expectedBaseAssetRevision: audioRevision
  });

  const firstPublished = await admin({
    action: "publishDraft",
    draftId: IDS.audioCasOne,
    expectedSnapshotHash: first.snapshotHash,
    expectedTargetRevision: contentRevision,
    requestId: "audio-cas-one-publish-0001"
  });
  assert.strictEqual(firstPublished.success, true);
  assert.strictEqual(
    database.store("contents").get("audio-cas-article").audioRevision,
    `r-${IDS.audioCasOne}`
  );

  const secondConflict = await admin({
    action: "publishDraft",
    draftId: IDS.audioCasTwo,
    expectedSnapshotHash: second.snapshotHash,
    expectedTargetRevision: contentRevision,
    requestId: "audio-cas-two-publish-0001"
  });
  assert.strictEqual(secondConflict.success, false);
  assert.strictEqual(secondConflict.code, "ASSET_REVISION_CONFLICT");
  assert.strictEqual(
    database.store("audioTracks").get("audio-cas-article-primary").sourceDraftId,
    IDS.audioCasOne
  );
  assert.strictEqual(
    database.store("adminContentDrafts").get(IDS.audioCasTwo).state,
    "approved"
  );
}

async function testFullBookReplaceAndPdfRevisionCompareAndSwap() {
  const bookId = "book-cas";
  const uploads = [
    validatedUpload({
      id: IDS.bookReplace,
      assetType: "full-book-pdf",
      relatedId: bookId
    }),
    validatedUpload({
      id: IDS.bookPdfOne,
      assetType: "full-book-pdf",
      relatedId: bookId
    }),
    validatedUpload({
      id: IDS.bookPdfTwo,
      assetType: "full-book-pdf",
      relatedId: bookId
    })
  ];
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: uploads,
    contents: [{
      _id: "book-cas-source",
      contentId: "book-cas-source",
      bookId,
      title: "已发布正文",
      currentRevision: `r-${"d".repeat(32)}`,
      sortOrder: 10,
      sections: [{
        kind: "story",
        heading: "",
        paragraphs: ["兼容旧的人工章节替换流程。"]
      }],
      status: "published"
    }]
  });
  const files = storageFilesFor(database);
  uploads.forEach((upload) => {
    assert.strictEqual(files.has(upload.fileID), true);
    assert.strictEqual(files.has(upload.preparedFileID), true);
  });
  const { uploaderA, reviewer, admin } = mains(database, files);

  const replacement = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.bookReplace,
    requestPrefix: "book-replace",
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: "",
    draftPatch: {
      title: "Complete book",
      structureMode: "replace",
      chapters: [{
        chapterId: "chapter-one",
        title: "Chapter one",
        sortOrder: 10,
        sections: [{
          kind: "story",
          heading: "",
          paragraphs: ["A complete first chapter."]
        }]
      }],
      structureConfirmed: true
    }
  });
  assert.strictEqual(replacement.payload.structureMode, "replace");
  assert.strictEqual(replacement.payload.chapters.length, 1);
  const replacementPublished = await admin({
    action: "publishDraft",
    draftId: IDS.bookReplace,
    expectedSnapshotHash: replacement.snapshotHash,
    expectedTargetRevision: "",
    requestId: "book-replace-publish-0001"
  });
  assert.strictEqual(replacementPublished.success, true);

  const structureRevision = `r-${IDS.bookReplace}`;
  const book = database.store("books").get(bookId);
  assert.strictEqual(book.currentRevision, structureRevision);
  assert.strictEqual(book.pdfRevision, structureRevision);
  assert.strictEqual(book.chapterCount, 1);
  assert.strictEqual(book.pdf.fileID, uploads[0].preparedFileID);
  const chapter = database.store("bookChapters").get(
    `${bookId}-chapter-one-${IDS.bookReplace.slice(0, 12)}`
  );
  assert.ok(chapter);
  assert.strictEqual(chapter.chapterId, `${bookId}-chapter-one`);
  assert.strictEqual(chapter.bookId, bookId);
  assert.strictEqual(chapter.bookRevision, structureRevision);
  assert.strictEqual(chapter.status, "published");

  const firstPdf = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.bookPdfOne,
    requestPrefix: "book-pdf-one",
    expectedBasePublishedRevision: structureRevision,
    expectedBaseAssetRevision: structureRevision
  });
  const secondPdf = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.bookPdfTwo,
    requestPrefix: "book-pdf-two",
    expectedBasePublishedRevision: structureRevision,
    expectedBaseAssetRevision: structureRevision
  });
  assert.strictEqual(firstPdf.payload.structureMode, "reuse-current");
  assert.strictEqual(secondPdf.payload.structureMode, "reuse-current");

  const firstPdfPublished = await admin({
    action: "publishDraft",
    draftId: IDS.bookPdfOne,
    expectedSnapshotHash: firstPdf.snapshotHash,
    expectedTargetRevision: structureRevision,
    requestId: "book-pdf-one-publish-0001"
  });
  assert.strictEqual(firstPdfPublished.success, true);
  const afterFirstPdf = database.store("books").get(bookId);
  assert.strictEqual(afterFirstPdf.currentRevision, structureRevision);
  assert.strictEqual(afterFirstPdf.pdfRevision, `r-${IDS.bookPdfOne}`);
  assert.strictEqual(afterFirstPdf.pdf.fileID, uploads[1].preparedFileID);
  assert.ok(database.store("bookChapters").get(
    `${bookId}-chapter-one-${IDS.bookReplace.slice(0, 12)}`
  ));

  const secondPdfConflict = await admin({
    action: "publishDraft",
    draftId: IDS.bookPdfTwo,
    expectedSnapshotHash: secondPdf.snapshotHash,
    expectedTargetRevision: structureRevision,
    requestId: "book-pdf-two-publish-0001"
  });
  assert.strictEqual(secondPdfConflict.success, false);
  assert.strictEqual(secondPdfConflict.code, "ASSET_REVISION_CONFLICT");
  assert.strictEqual(
    database.store("books").get(bookId).pdfRevision,
    `r-${IDS.bookPdfOne}`
  );
  assert.strictEqual(
    database.store("adminContentDrafts").get(IDS.bookPdfTwo).state,
    "approved"
  );
}

async function testFirstFullBookBuildsChaptersFromPublishedContents() {
  const bookId = "china-hospital-ship";
  const firstUpload = validatedUpload({
    id: IDS.automaticBook,
    assetType: "full-book-pdf",
    relatedId: bookId
  });
  const updateUpload = validatedUpload({
    id: IDS.automaticBookUpdate,
    assetType: "full-book-pdf",
    relatedId: bookId
  });
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [firstUpload, updateUpload],
    contents: [{
      _id: "chapter-b",
      contentId: "chapter-b",
      bookId,
      title: "第二篇",
      currentRevision: `r-${"b".repeat(32)}`,
      sortOrder: 20,
      sections: [{
        kind: "story",
        heading: "第二篇正文",
        paragraphs: ["第二篇已发布正文。"]
      }],
      status: "published"
    }, {
      _id: "chapter-a",
      contentId: "chapter-a",
      bookId,
      title: "第一篇",
      currentRevision: `r-${"a".repeat(32)}`,
      sortOrder: 10,
      sections: [{
        kind: "story",
        heading: "第一篇正文",
        paragraphs: ["第一篇已发布正文。"]
      }],
      status: "published"
    }, {
      _id: "chapter-draft",
      contentId: "chapter-draft",
      bookId,
      title: "未发布篇章",
      currentRevision: `r-${"c".repeat(32)}`,
      sortOrder: 0,
      sections: [{
        kind: "story",
        heading: "",
        paragraphs: ["不能进入整书。"]
      }],
      status: "draft"
    }]
  });
  const files = storageFilesFor(database);
  const { uploaderA, reviewer, admin } = mains(database, files);

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.automaticBook,
    requestPrefix: "automatic-book",
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: ""
  });
  assert.strictEqual(approved.payload.title, "中国医院船");
  assert.strictEqual(
    approved.payload.structureMode,
    "from-published-contents"
  );
  assert.deepStrictEqual(approved.payload.chapters, []);

  const published = await admin({
    action: "publishDraft",
    draftId: IDS.automaticBook,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: "",
    requestId: "automatic-book-publish-0001"
  });
  assert.strictEqual(published.success, true);
  const revision = `r-${IDS.automaticBook}`;
  const book = database.store("books").get(bookId);
  assert.strictEqual(book.currentRevision, revision);
  assert.strictEqual(book.pdfRevision, revision);
  assert.strictEqual(book.title, "中国医院船");
  assert.strictEqual(book.chapterCount, 2);
  assert.deepStrictEqual(book.sourceContentIds, ["chapter-a", "chapter-b"]);

  const chapters = database.documents("bookChapters")
    .filter((chapter) => chapter.bookRevision === revision)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  assert.deepStrictEqual(
    chapters.map((chapter) => chapter.sourceContentId),
    ["chapter-a", "chapter-b"]
  );
  assert.deepStrictEqual(
    chapters.map((chapter) => chapter.sourceContentRevision),
    [`r-${"a".repeat(32)}`, `r-${"b".repeat(32)}`]
  );
  assert.deepStrictEqual(
    chapters.map((chapter) => chapter.title),
    ["第一篇", "第二篇"]
  );
  assert.deepStrictEqual(
    chapters[0].sections,
    database.store("contents").get("chapter-a").sections
  );

  const update = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: IDS.automaticBookUpdate,
    requestPrefix: "automatic-book-update",
    expectedBasePublishedRevision: revision,
    expectedBaseAssetRevision: revision
  });
  assert.strictEqual(update.payload.structureMode, "reuse-current");
  const updatePublished = await admin({
    action: "publishDraft",
    draftId: IDS.automaticBookUpdate,
    expectedSnapshotHash: update.snapshotHash,
    expectedTargetRevision: revision,
    requestId: "automatic-book-update-publish-0001"
  });
  assert.strictEqual(updatePublished.success, true);
  assert.strictEqual(
    database.store("books").get(bookId).currentRevision,
    revision
  );
  assert.strictEqual(
    database.store("books").get(bookId).pdfRevision,
    `r-${IDS.automaticBookUpdate}`
  );
  assert.strictEqual(
    database.documents("bookChapters")
      .filter((chapter) => chapter.bookRevision === revision).length,
    2
  );

  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "cloud-security/database-indexes.manifest.json"),
    "utf8"
  ));
  assert.strictEqual(
    manifest.indexes.some((index) =>
      index.collection === "contents" &&
      JSON.stringify(index.fields) === JSON.stringify([
        { field: "bookId", mode: "asc" },
        { field: "status", mode: "asc" },
        { field: "sortOrder", mode: "asc" },
        { field: "_id", mode: "asc" }
      ])
    ),
    true,
    "自动整书章节查询必须登记对应复合索引"
  );
}

async function testFirstFullBookFailsClearlyWithoutPublishedContents() {
  const upload = validatedUpload({
    id: IDS.emptyAutomaticBook,
    assetType: "full-book-pdf",
    relatedId: "empty-book"
  });
  const sampleUpload = validatedUpload({
    id: IDS.sampleBook,
    assetType: "full-book-pdf",
    relatedId: "empty-book"
  });
  sampleUpload.sha256 =
    "d443f7dcbbecedd15e4e12fd6dba8bd37d3568401fdb24597a2d7ffabeebc07f";
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload, sampleUpload]
  });
  const files = storageFilesFor(database);
  const { uploaderA } = mains(database, files);

  const sampleRejected = await uploaderA({
    action: "createDraftFromUpload",
    uploadId: sampleUpload._id,
    requestId: "sample-book-create-0001"
  });
  assert.strictEqual(
    sampleRejected.code,
    "BOOK_CHAPTER_SOURCE_NOT_COMPLETE"
  );

  const rejected = await uploaderA({
    action: "createDraftFromUpload",
    uploadId: upload._id,
    requestId: "empty-automatic-book-create-0001"
  });
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.code, "BOOK_PUBLISHED_CONTENT_REQUIRED");
  assert.match(rejected.message, /至少一篇/);
  assert.strictEqual(database.documents("books").length, 0);
  assert.strictEqual(database.documents("bookChapters").length, 0);
}

async function testDirectTopicEmbeddedImagesSurviveDraftAndPublish() {
  const upload = directTopicUploadWithEmbeddedImage();
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload]
  });
  const files = storageFilesFor(database);
  upload.clientImageUploadPlan.forEach((item) => files.add(item.fileID));
  const { uploaderA, reviewer, admin } = mains(database, files);

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: upload._id,
    requestPrefix: "embedded-topic",
    draftPatch: {
      unlockCostStars: 5,
      structureConfirmed: true
    },
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: ""
  });
  const storedDraft = database
    .store("adminContentDrafts")
    .get(upload._id);
  assert.strictEqual(storedDraft.sourceFileID, "");
  assert.strictEqual(storedDraft.sourceMode, "client-manifest-only");
  assert.strictEqual(storedDraft.rawFileValidationStatus, "not_uploaded");
  assert.strictEqual(storedDraft.embeddedAssets.length, 1);
  const topicPreviewAudits = database.documents("adminDraftPreviewAudits")
    .filter((audit) => audit.draftId === upload._id);
  assert.strictEqual(topicPreviewAudits.length, 1);
  assert.strictEqual(topicPreviewAudits[0].previewKind, "structured");
  assert.strictEqual(topicPreviewAudits[0].rawFileVerified, false);
  assert.strictEqual(
    topicPreviewAudits[0].sourceHashScope,
    "client-parsed-docx-manifest"
  );
  assert.strictEqual(
    database.store("adminUploads").get(upload._id).reviewStatus,
    "approved"
  );
  assert.strictEqual(
    storedDraft.embeddedAssets[0].fileID,
    upload.clientImageUploadPlan[0].fileID
  );
  assert.deepStrictEqual(
    storedDraft.payload.entries[0].blocks[1],
    {
      type: "image",
      embeddedAssetId: "embedded-0001",
      caption: "Embedded caption"
    }
  );

  const published = await admin({
    action: "publishDraft",
    draftId: upload._id,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: "",
    requestId: "embedded-topic-publish-0001"
  });
  assert.strictEqual(published.success, true);
  assert.strictEqual(published.draft.state, "published");

  const topic = database.store("specialTopics").get(upload.relatedId);
  assert.strictEqual(topic.status, "published");
  assert.strictEqual(topic.embeddedAssets.length, 1);
  assert.strictEqual(
    topic.embeddedAssets[0].cloudPath,
    upload.clientImageUploadPlan[0].cloudPath
  );
  assert.match(
    topic.embeddedAssets[0].cloudPath,
    /^protected\/special-topics\/topic-embedded\/assets\/[a-f0-9]{32}\/embedded\/0001\.png$/
  );
  const entries = database.documents("specialTopicEntries");
  assert.strictEqual(entries.length, 1);
  const publishedImageBlocks = entries[0].blocks.filter(
    (block) => block.type === "image"
  );
  assert.deepStrictEqual(publishedImageBlocks, [{
    type: "image",
    fileID: upload.clientImageUploadPlan[0].fileID,
    caption: "Embedded caption"
  }]);
  const revision = database
    .store("adminPublishedRevisions")
    .get(upload._id);
  assert.strictEqual(revision.payload.embeddedAssets.length, 1);
}

async function testLargeStructuredPreviewSkipsRemoteStorageValidation() {
  const upload = directTopicUploadWithManyEmbeddedImages(200);
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload]
  });
  const files = storageFilesFor(database);
  upload.clientImageUploadPlan.forEach((item) => files.add(item.fileID));
  const storageMetrics = {
    getTempFileURLCalls: 0,
    requestedFileIDs: [],
    requestedBatches: []
  };
  const { uploaderA, reviewer, admin } = mains(
    database,
    files,
    storageMetrics
  );

  let current = await uploaderA({
    action: "createDraftFromUpload",
    uploadId: upload._id,
    requestId: "large-preview-create-0001"
  });
  assert.strictEqual(current.success, true, JSON.stringify(current));
  assert.strictEqual(
    database.store("adminContentDrafts").get(upload._id).embeddedAssets.length,
    200
  );

  current = await uploaderA({
    action: "saveDraft",
    draftId: upload._id,
    expectedDraftVersion: current.draft.draftVersion,
    patch: {
      unlockCostStars: 1,
      structureConfirmed: true
    },
    requestId: "large-preview-save-0001"
  });
  assert.strictEqual(current.success, true, JSON.stringify(current));

  const submitted = await uploaderA({
    action: "submitDraft",
    draftId: upload._id,
    expectedDraftVersion: current.draft.draftVersion,
    requestId: "large-preview-submit-0001"
  });
  assert.strictEqual(submitted.success, true, JSON.stringify(submitted));

  storageMetrics.getTempFileURLCalls = 0;
  storageMetrics.requestedFileIDs = [];
  storageMetrics.requestedBatches = [];
  let previewTransactionCalls = 0;
  const originalRunTransaction = database.runTransaction;
  database.runTransaction = function instrumentedRunTransaction(callback) {
    previewTransactionCalls += 1;
    return originalRunTransaction.call(this, callback);
  };
  const preview = await reviewer({
    action: "getDraftAssetPreview",
    draftId: upload._id,
    expectedSnapshotHash: submitted.draft.snapshotHash
  });
  database.runTransaction = originalRunTransaction;
  assert.strictEqual(preview.success, true, JSON.stringify(preview));
  assert.strictEqual(preview.previewKind, "structured");
  assert.strictEqual(preview.sourceMode, "client-manifest-only");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(preview, "payload"),
    false,
    "large structured preview must not echo its 200-image draft payload"
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(preview), "utf8") < 32 * 1024,
    "structured preview metadata response should remain below 32 KiB"
  );
  assert.strictEqual(previewTransactionCalls, 0);
  assert.strictEqual(storageMetrics.getTempFileURLCalls, 0);
  assert.deepStrictEqual(storageMetrics.requestedFileIDs, []);
  assert.deepStrictEqual(storageMetrics.requestedBatches, []);

  const approved = await reviewer({
    action: "reviewDraft",
    draftId: upload._id,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: "large-preview-review-0001"
  });
  assert.strictEqual(approved.success, true, JSON.stringify(approved));

  const missingFileID = upload.clientImageUploadPlan[199].fileID;
  files.delete(missingFileID);
  storageMetrics.getTempFileURLCalls = 0;
  storageMetrics.requestedFileIDs = [];
  storageMetrics.requestedBatches = [];
  const publication = await publishUntilSettled(admin, {
    action: "publishDraft",
    draftId: upload._id,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    expectedTargetRevision: "",
    requestId: "large-preview-publish-0001"
  });
  const { attempts, result: published } = publication;
  assert.strictEqual(attempts.length, 4);
  assert.deepStrictEqual(
    attempts.slice(0, 3).map((attempt) => ({
      success: attempt.success,
      pending: attempt.pending,
      phase: attempt.phase,
      processed: attempt.processed,
      total: attempt.total
    })),
    [50, 100, 150].map((processed) => ({
      success: true,
      pending: true,
      phase: "verifying-assets",
      processed,
      total: 200
    }))
  );
  assert.strictEqual(published.success, false);
  assert.strictEqual(published.code, "PUBLISH_ASSET_NOT_FOUND");
  assert.strictEqual(storageMetrics.getTempFileURLCalls, 4);
  assert.strictEqual(storageMetrics.requestedFileIDs.length, 200);
  assert.strictEqual(storageMetrics.requestedFileIDs.includes(missingFileID), true);
  assert.deepStrictEqual(
    storageMetrics.requestedBatches.map((batch) => batch.length),
    [50, 50, 50, 50]
  );
  assert.strictEqual(database.documents("specialTopicEntries").length, 0);
}

async function testResumableHeavyTopicPublishConvergesIdempotently() {
  const upload = directTopicUploadWithManyEmbeddedImages(200, 101);
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload]
  });
  const files = storageFilesFor(database);
  upload.clientImageUploadPlan.forEach((item) => files.add(item.fileID));
  const storageMetrics = {
    getTempFileURLCalls: 0,
    requestedFileIDs: [],
    requestedBatches: []
  };
  const { uploaderA, reviewer, admin } = mains(
    database,
    files,
    storageMetrics
  );

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: upload._id,
    requestPrefix: "heavy-topic",
    draftPatch: {
      unlockCostStars: 5,
      structureConfirmed: true
    },
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: ""
  });
  storageMetrics.getTempFileURLCalls = 0;
  storageMetrics.requestedFileIDs = [];
  storageMetrics.requestedBatches = [];

  const publishEvent = {
    action: "publishDraft",
    draftId: upload._id,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: "",
    requestId: "heavy-topic-publish-0001"
  };
  const publication = await publishUntilSettledWithTransactionReads(
    database,
    admin,
    publishEvent,
    50,
    () => {
      const stagedEntries = database
        .documents("specialTopicEntries")
        .filter((entry) => entry.topicId === upload.relatedId);
      const topic = database.store("specialTopics").get(upload.relatedId);
      return {
        stagedEntryIds: stagedEntries.map((entry) => entry._id),
        currentRevision: topic ? topic.currentRevision : "",
        visibleEntryCount: visibleSpecialTopicEntries(
          database,
          upload.relatedId
        ).length
      };
    }
  );
  const {
    attempts,
    result: published,
    transactionReadsByAttempt,
    observations
  } = publication;

  assert.strictEqual(attempts.length, 16);
  assert.deepStrictEqual(
    attempts.slice(0, 4).map((attempt) => ({
      success: attempt.success,
      pending: attempt.pending,
      phase: attempt.phase,
      processed: attempt.processed,
      total: attempt.total
    })),
    [50, 100, 150, 200].map((processed) => ({
      success: true,
      pending: true,
      phase: "verifying-assets",
      processed,
      total: 200
    }))
  );
  assert.deepStrictEqual(
    attempts.slice(4, 15).map((attempt) => ({
      success: attempt.success,
      pending: attempt.pending,
      phase: attempt.phase,
      processed: attempt.processed,
      total: attempt.total
    })),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101].map(
      (processed) => ({
        success: true,
        pending: true,
        phase: "preparing-entries",
        processed,
        total: 101
      })
    )
  );
  assert.deepStrictEqual(
    observations.slice(0, 4).map((observation) => observation.stagedEntryIds.length),
    [0, 0, 0, 0],
    "asset-verification retries must not create candidate entries early"
  );
  assert.deepStrictEqual(
    observations.slice(4, 15).map((observation) => observation.stagedEntryIds.length),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101],
    "lost pending responses retried with the same mutation tuple must resume without duplicates"
  );
  attempts.slice(0, -1).forEach((attempt, index) => {
    assert.strictEqual(attempt.pending, true);
    const observation = observations[index];
    assert.strictEqual(
      new Set(observation.stagedEntryIds).size,
      observation.stagedEntryIds.length,
      `staged entry ids must remain deterministic after pending attempt ${index + 1}`
    );
    assert.strictEqual(
      observation.currentRevision,
      "",
      "pending publication must not switch the public topic revision"
    );
    assert.strictEqual(
      observation.visibleEntryCount,
      0,
      "staged revision entries must remain invisible until final commit"
    );
  });
  assertFinalTransactionUsesOnlyLightweightDraftProjection(
    transactionReadsByAttempt[transactionReadsByAttempt.length - 1],
    upload._id
  );
  assert.strictEqual(published.success, true, JSON.stringify(published));
  assert.strictEqual(published.pending, undefined);
  assert.strictEqual(published.alreadyApplied, false);
  assert.strictEqual(published.draft.state, "published");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(published.draft, "payload"),
    false,
    "final heavy publish response must remain slim"
  );
  assert.strictEqual(storageMetrics.getTempFileURLCalls, 4);
  assert.strictEqual(storageMetrics.requestedFileIDs.length, 200);
  assert.deepStrictEqual(
    storageMetrics.requestedBatches.map((batch) => batch.length),
    [50, 50, 50, 50]
  );

  const storedDraft = database.store("adminContentDrafts").get(upload._id);
  assert.strictEqual(storedDraft.state, "published");
  assert.strictEqual(storedDraft.publicationPreparation, null);
  const topic = database.store("specialTopics").get(upload.relatedId);
  assert.strictEqual(topic.status, "published");
  assert.strictEqual(topic.currentRevision, approved.revision);
  assert.strictEqual(topic.sourceDraftId, upload._id);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(topic, "embeddedAssets"),
    false,
    "the stable topic pointer must not duplicate the 200-image draft manifest"
  );

  const entries = database
    .documents("specialTopicEntries")
    .sort((left, right) => left.sortOrder - right.sortOrder);
  assert.strictEqual(entries.length, 101);
  assert.strictEqual(new Set(entries.map((entry) => entry._id)).size, 101);
  assert.deepStrictEqual(
    entries.map((entry) => entry.sortOrder),
    Array.from({ length: 101 }, (_, index) => (index + 1) * 10)
  );
  entries.forEach((entry) => {
    assert.strictEqual(entry.topicId, upload.relatedId);
    assert.strictEqual(entry.topicRevision, approved.revision);
    assert.strictEqual(entry.status, "published");
    assert.strictEqual(entry.reviewStatus, "approved");
    assert.strictEqual(entry.sourceDraftId, upload._id);
  });
  assert.strictEqual(
    entries.reduce(
      (total, entry) => total + entry.blocks.filter(
        (block) => block.type === "image"
      ).length,
      0
    ),
    200
  );
  assert.strictEqual(database.documents("adminPublishedRevisions").length, 1);
  const revisionRecord = database
    .store("adminPublishedRevisions")
    .get(upload._id);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(revisionRecord, "payload"),
    false,
    "revision history must reference the immutable approved draft instead of copying its payload"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(revisionRecord, "embeddedAssets"),
    false,
    "revision history must not copy the embedded-asset manifest"
  );
  assert.deepStrictEqual(revisionRecord.payloadSource, {
    collection: "adminContentDrafts",
    documentId: upload._id,
    snapshotHash: approved.snapshotHash
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(revisionRecord), "utf8") < 32 * 1024,
    "special-topic revision guard must remain lightweight"
  );
  assert.strictEqual(
    database.store("adminUploads").get(upload._id).reviewStatus,
    "published"
  );

  const storageCallsBeforeReplay = storageMetrics.getTempFileURLCalls;
  const entriesBeforeReplay = clone(entries);
  const revisionsBeforeReplay = clone(
    database.documents("adminPublishedRevisions")
  );
  // Treat the successful response above as lost in transit. The client knows
  // only its original mutation tuple and retries it unchanged.
  const replay = await admin({ ...publishEvent });
  assert.strictEqual(replay.success, true, JSON.stringify(replay));
  assert.strictEqual(replay.alreadyApplied, true);
  assert.strictEqual(replay.pending, undefined);
  assert.strictEqual(replay.draft.state, "published");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(replay.draft, "payload"),
    false
  );
  assert.strictEqual(
    storageMetrics.getTempFileURLCalls,
    storageCallsBeforeReplay,
    "idempotent replay must not revalidate the 200 images"
  );
  assert.deepStrictEqual(
    database
      .documents("specialTopicEntries")
      .sort((left, right) => left.sortOrder - right.sortOrder),
    entriesBeforeReplay
  );
  assert.deepStrictEqual(
    database.documents("adminPublishedRevisions"),
    revisionsBeforeReplay,
    "response-loss replay must not duplicate or rewrite the staged revision"
  );
  assert.strictEqual(database.documents("adminPublishedRevisions").length, 1);
}

async function testStagedTopicConflictRemainsInvisibleAndIdempotent() {
  const upload = directTopicUploadWithManyEmbeddedImages(200, 101);
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload]
  });
  const files = storageFilesFor(database);
  upload.clientImageUploadPlan.forEach((item) => files.add(item.fileID));
  const { uploaderA, reviewer, admin } = mains(database, files);

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: upload._id,
    requestPrefix: "heavy-topic-conflict",
    draftPatch: {
      unlockCostStars: 5,
      structureConfirmed: true
    },
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: ""
  });
  const publishEvent = {
    action: "publishDraft",
    draftId: upload._id,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: "",
    requestId: "heavy-topic-conflict-publish-0001"
  };

  const pendingResults = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await admin({ ...publishEvent });
    pendingResults.push(result);
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(result.pending, true, JSON.stringify(result));
    assert.strictEqual(
      visibleSpecialTopicEntries(database, upload.relatedId).length,
      0,
      "candidate entries must not become readable while publication is pending"
    );
    if (
      database
        .documents("specialTopicEntries")
        .filter((entry) => entry.topicId === upload.relatedId).length === 101
    ) {
      break;
    }
  }
  assert.ok(pendingResults.length < 30, "candidate staging did not converge");

  const stagedEntries = database
    .documents("specialTopicEntries")
    .filter((entry) => entry.topicId === upload.relatedId)
    .sort((left, right) => left._id.localeCompare(right._id));
  assert.strictEqual(stagedEntries.length, 101);
  assert.strictEqual(new Set(stagedEntries.map((entry) => entry._id)).size, 101);
  assert.strictEqual(database.documents("adminPublishedRevisions").length, 0);

  const competingRevision = `r-${"c".repeat(32)}`;
  const competingTopic = {
    _id: upload.relatedId,
    topicId: upload.relatedId,
    currentRevision: competingRevision,
    title: "Competing published topic",
    summary: "",
    producer: "another administrator",
    unlockCostStars: 1,
    sortOrder: 1,
    previewCover: "",
    status: "published",
    reviewStatus: "approved",
    sourceDraftId: "competing-draft",
    publishedAt: new Date(),
    updateTime: new Date(),
    schemaVersion: 1
  };
  database
    .store("specialTopics")
    .set(upload.relatedId, clone(competingTopic));

  const revisionsBeforeConflict = clone(
    database.documents("adminPublishedRevisions")
  );
  const firstConflict = await admin({ ...publishEvent });
  assert.strictEqual(firstConflict.success, false);
  assert.strictEqual(firstConflict.code, "TARGET_REVISION_CONFLICT");
  assert.deepStrictEqual(
    database.store("specialTopics").get(upload.relatedId),
    competingTopic,
    "conflicting final commit must not overwrite the winning public pointer"
  );
  assert.strictEqual(
    visibleSpecialTopicEntries(database, upload.relatedId).length,
    0,
    "candidate entries for the losing revision must remain logically invisible"
  );
  assert.deepStrictEqual(
    database
      .documents("specialTopicEntries")
      .filter((entry) => entry.topicId === upload.relatedId)
      .sort((left, right) => left._id.localeCompare(right._id)),
    stagedEntries,
    "target conflict must leave deterministic staged entries unchanged"
  );
  assert.deepStrictEqual(
    database.documents("adminPublishedRevisions"),
    revisionsBeforeConflict,
    "target conflict must not expose a staged revision through revision history"
  );

  // Treat the conflict response as lost and retry the exact mutation tuple.
  const conflictReplay = await admin({ ...publishEvent });
  assert.strictEqual(conflictReplay.success, false);
  assert.strictEqual(conflictReplay.code, "TARGET_REVISION_CONFLICT");
  assert.deepStrictEqual(
    database.store("specialTopics").get(upload.relatedId),
    competingTopic
  );
  assert.deepStrictEqual(
    database
      .documents("specialTopicEntries")
      .filter((entry) => entry.topicId === upload.relatedId)
      .sort((left, right) => left._id.localeCompare(right._id)),
    stagedEntries,
    "conflict retry must not duplicate or rewrite candidate entries"
  );
  assert.deepStrictEqual(
    database.documents("adminPublishedRevisions"),
    revisionsBeforeConflict
  );
  assert.strictEqual(
    database.store("adminContentDrafts").get(upload._id).state,
    "approved",
    "a conflicted candidate remains approved for an explicit operator decision"
  );
}

async function testDirectManuscriptEmbeddedImagesSurviveDraftAndPublish() {
  const upload = directManuscriptUploadWithEmbeddedImage();
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts(),
    adminUploads: [upload]
  });
  const files = storageFilesFor(database);
  upload.clientImageUploadPlan.forEach((item) => files.add(item.fileID));
  const { uploaderA, reviewer, admin } = mains(database, files);

  const approved = await createApprovedDraft({
    uploader: uploaderA,
    reviewer,
    uploadId: upload._id,
    requestPrefix: "embedded-article",
    draftPatch: { structureConfirmed: true },
    expectedBasePublishedRevision: "",
    expectedBaseAssetRevision: ""
  });
  const storedDraft = database
    .store("adminContentDrafts")
    .get(upload._id);
  assert.strictEqual(storedDraft.sourceFileID, "");
  assert.strictEqual(storedDraft.sourceMode, "client-manifest-only");
  assert.strictEqual(storedDraft.rawFileValidationStatus, "not_uploaded");
  assert.strictEqual(storedDraft.embeddedAssets.length, 1);
  const manuscriptPreviewAudits = database.documents(
    "adminDraftPreviewAudits"
  ).filter((audit) => audit.draftId === upload._id);
  assert.strictEqual(manuscriptPreviewAudits.length, 1);
  assert.strictEqual(manuscriptPreviewAudits[0].previewKind, "structured");
  assert.strictEqual(manuscriptPreviewAudits[0].rawFileVerified, false);
  assert.strictEqual(
    manuscriptPreviewAudits[0].sourceHashScope,
    "client-parsed-docx-manifest"
  );
  assert.strictEqual(
    database.store("adminUploads").get(upload._id).reviewStatus,
    "approved"
  );
  assert.deepStrictEqual(storedDraft.payload.sections[0].blocks, [
    { type: "text", text: "A paragraph before the image." },
    {
      type: "image",
      embeddedAssetId: "embedded-0001",
      caption: "Article embedded caption"
    },
    { type: "text", text: "A paragraph after the image." }
  ]);

  const published = await admin({
    action: "publishDraft",
    draftId: upload._id,
    expectedSnapshotHash: approved.snapshotHash,
    expectedTargetRevision: "",
    requestId: "embedded-article-publish-0001"
  });
  assert.strictEqual(published.success, true);
  const content = database.store("contents").get(upload.relatedId);
  assert.strictEqual(content.status, "published");
  assert.deepStrictEqual(
    content.sections[0].blocks,
    storedDraft.payload.sections[0].blocks
  );
  assert.strictEqual(content.embeddedAssets.length, 1);
  assert.strictEqual(
    content.embeddedAssets[0].fileID,
    upload.clientImageUploadPlan[0].fileID
  );
  assert.match(
    content.embeddedAssets[0].cloudPath,
    /^protected\/contents\/article-embedded\/assets\/[a-f0-9]{32}\/embedded\/0001\.png$/
  );
  const revision = database
    .store("adminPublishedRevisions")
    .get(upload._id);
  assert.strictEqual(revision.payload.embeddedAssets.length, 1);
  assert.deepStrictEqual(
    revision.payload.sections[0].blocks,
    content.sections[0].blocks
  );
}

function validEditorialPayload(assetType) {
  if (assetType === "zhi-entry") {
    return {
      eventAt: "2026-07-30",
      source: "中国医院船科普栏目",
      label: "医院船消息",
      content: "一条面向少年会员的正式消息。"
    };
  }
  return {
    topic: "食管癌的故事",
    department: "胸外科",
    source: "书稿第一章",
    question: "哪一项属于典型症状？",
    options: [
      { key: "one", label: "选择一", text: "进行性吞咽梗阻感" },
      { key: "two", label: "选择二", text: "长期高温饮食" }
    ],
    correctKey: "one",
    correctFeedback: "回答正确。",
    wrongFeedback: "再想一想。",
    explanation: "进行性吞咽梗阻感是典型症状。",
    sortOrder: 10
  };
}

async function completeEditorialLifecycle({
  assetType,
  requestPrefix,
  uploader,
  reviewer,
  admin
}) {
  const payload = validEditorialPayload(assetType);
  const createEvent = {
    action: "createEditorialDraft",
    assetType,
    payload,
    requestId: `${requestPrefix}-create-0001`
  };
  const created = await uploader(createEvent);
  assert.strictEqual(
    created.success,
    true,
    `${requestPrefix}: create ${JSON.stringify(created)}`
  );
  assert.strictEqual(created.draft.assetType, assetType);
  assert.strictEqual(created.draft.state, "editing");
  assert.match(created.draft.id, /^[a-f0-9]{32}$/);
  assert.match(created.draft.targetId, /^(?:zhi|quiz)-[a-f0-9]{28}$/);

  const replay = await uploader(createEvent);
  assert.strictEqual(replay.success, true);
  assert.strictEqual(replay.alreadyApplied, true);
  assert.strictEqual(replay.draft.id, created.draft.id);

  const reused = await uploader({
    ...createEvent,
    payload: {
      ...payload,
      ...(assetType === "zhi-entry"
        ? { content: "不同的内容。" }
        : { question: "不同的问题？" })
    }
  });
  assert.strictEqual(reused.success, false);
  assert.strictEqual(reused.code, "IDEMPOTENCY_KEY_REUSED");

  const patch = assetType === "zhi-entry"
    ? { content: "保存后的少年志正式消息。" }
    : { explanation: "保存后的完整题目解析。" };
  const saved = await uploader({
    action: "saveDraft",
    draftId: created.draft.id,
    expectedDraftVersion: created.draft.draftVersion,
    patch,
    requestId: `${requestPrefix}-save-0001`
  });
  assert.strictEqual(saved.success, true, `${requestPrefix}: save`);
  assert.strictEqual(
    saved.draft.payload[
      assetType === "zhi-entry" ? "content" : "explanation"
    ],
    assetType === "zhi-entry"
      ? patch.content
      : patch.explanation
  );

  const submitted = await uploader({
    action: "submitDraft",
    draftId: created.draft.id,
    expectedDraftVersion: saved.draft.draftVersion,
    requestId: `${requestPrefix}-submit-0001`
  });
  assert.strictEqual(submitted.success, true, `${requestPrefix}: submit`);
  assert.strictEqual(submitted.draft.state, "in_review");
  assert.match(submitted.draft.snapshotHash, /^[a-f0-9]{64}$/);

  const unpreviewed = await reviewer({
    action: "reviewDraft",
    draftId: created.draft.id,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: `${requestPrefix}-approve-before-preview-0001`
  });
  assert.strictEqual(unpreviewed.success, false);
  assert.strictEqual(unpreviewed.code, "DRAFT_ASSET_PREVIEW_REQUIRED");

  const preview = await reviewer({
    action: "getDraftAssetPreview",
    draftId: created.draft.id,
    expectedSnapshotHash: submitted.draft.snapshotHash
  });
  assert.strictEqual(preview.success, true, `${requestPrefix}: preview`);
  assert.strictEqual(preview.previewKind, "structured");
  assert.strictEqual(preview.assetType, assetType);
  assert.strictEqual(preview.snapshotHash, submitted.draft.snapshotHash);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(preview, "payload"),
    false,
    `${requestPrefix}: structured preview metadata must not echo the draft payload`
  );
  assert.strictEqual(preview.previewUrl, undefined);

  const approved = await reviewer({
    action: "reviewDraft",
    draftId: created.draft.id,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    decision: "approve",
    note: "",
    requestId: `${requestPrefix}-approve-0001`
  });
  assert.strictEqual(approved.success, true, `${requestPrefix}: approve`);
  assert.strictEqual(approved.draft.state, "approved");

  const published = await admin({
    action: "publishDraft",
    draftId: created.draft.id,
    expectedSnapshotHash: submitted.draft.snapshotHash,
    expectedTargetRevision: approved.draft.basePublishedRevision,
    requestId: `${requestPrefix}-publish-0001`
  });
  assert.strictEqual(published.success, true, `${requestPrefix}: publish`);
  assert.strictEqual(published.draft.state, "published");
  return published.draft;
}

async function testStructuredEditorialLifecycleAndReaderCompatibility() {
  const database = new MemoryDatabase({
    adminAccounts: seedAccounts()
  });
  const { uploaderA, reviewer, admin } = mains(database);
  const zhiDraft = await completeEditorialLifecycle({
    assetType: "zhi-entry",
    requestPrefix: "structured-zhi",
    uploader: uploaderA,
    reviewer,
    admin
  });
  const quizDraft = await completeEditorialLifecycle({
    assetType: "quiz-question",
    requestPrefix: "structured-quiz",
    uploader: uploaderA,
    reviewer,
    admin
  });

  assert.strictEqual(database.documents("adminUploads").length, 0);
  const zhi = database.store("zhiEntries").get(zhiDraft.targetId);
  assert.strictEqual(zhi.status, "published");
  assert.strictEqual(zhi.entryId, zhiDraft.targetId);
  assert.strictEqual(zhi.revision, zhiDraft.revision);
  assert(zhi.eventAt instanceof Date);
  assert(zhi.publishedAt instanceof Date);
  assert.strictEqual(zhi.content, "保存后的少年志正式消息。");

  const quiz = database.store("quizQuestions").get(quizDraft.targetId);
  assert.strictEqual(quiz.status, "published");
  assert.strictEqual(quiz.questionId, quizDraft.targetId);
  assert.strictEqual(quiz.revision, quizDraft.revision);
  assert.strictEqual(quiz.correctKey, "one");
  assert.strictEqual(quiz.explanation, "保存后的完整题目解析。");
  assert(quiz.publishedAt instanceof Date);

  const revisions = database.documents("adminPublishedRevisions");
  assert.strictEqual(revisions.length, 2);
  assert.deepStrictEqual(
    new Set(revisions.map((item) => item.assetType)),
    new Set(["zhi-entry", "quiz-question"])
  );
  assert.strictEqual(database.documents("adminDraftPreviewAudits").length, 2);

  const youthTimeline = loadReaderFunction(
    "cloudfunctions/getYouthTimeline/index.js",
    database,
    "reader-openid"
  );
  const timelineResult = await youthTimeline({
    year: "2026",
    month: "07",
    limit: 10
  });
  assert.strictEqual(timelineResult.success, true);
  assert.strictEqual(timelineResult.source, "cloud");
  assert.strictEqual(timelineResult.entries.length, 1);
  assert.strictEqual(timelineResult.entries[0].id, zhiDraft.targetId);
  assert.strictEqual(
    timelineResult.entries[0].content,
    "保存后的少年志正式消息。"
  );

  const quizCenter = loadReaderFunction(
    "cloudfunctions/quizCenter/index.js",
    database,
    "reader-openid"
  );
  const quizResult = await quizCenter({ action: "list", limit: 10 });
  assert.strictEqual(quizResult.success, true);
  assert.strictEqual(quizResult.source, "cloud");
  assert.strictEqual(quizResult.questions.length, 1);
  assert.strictEqual(quizResult.questions[0].id, quizDraft.targetId);
  assert.strictEqual(quizResult.questions[0].correctKey, undefined);
  assert.strictEqual(
    quizResult.questions[0].explanation,
    "保存后的完整题目解析。"
  );
}

async function main() {
  const originalBrokerUrl = process.env[BROKER_ENV_KEY];
  process.env[BROKER_ENV_KEY] = BROKER_URL;
  try {
    testTransactionOperationsRemainSequential();
    await testRolesEditingConflictsIdempotencyAndIsolation();
    await testStableOverwritePreservesReaderCollectionsAndPendingBlocks();
    await testAudioRequiresExactPreparedPath();
    await testAudioRevisionCompareAndSwap();
    await testFullBookReplaceAndPdfRevisionCompareAndSwap();
    await testFirstFullBookBuildsChaptersFromPublishedContents();
    await testFirstFullBookFailsClearlyWithoutPublishedContents();
    await testDirectTopicEmbeddedImagesSurviveDraftAndPublish();
    await testLargeStructuredPreviewSkipsRemoteStorageValidation();
    await testResumableHeavyTopicPublishConvergesIdempotently();
    await testStagedTopicConflictRemainsInvisibleAndIdempotent();
    await testDirectManuscriptEmbeddedImagesSurviveDraftAndPublish();
    await testStructuredEditorialLifecycleAndReaderCompatibility();
    console.log(
      "Admin content workflow tests passed: roles, draft lifecycle, conflicts, " +
      "idempotency, isolation, broker confirmation, stable overwrite, reader " +
      "history preservation, preview-gated approval, pending-review counters, " +
      "exact prepared assets, audio/PDF revision CAS, full-book replacement, " +
      "direct Word embedded-topic/manuscript image preservation, 200-image " +
      "structured preview without remote lookups, resumable publish-time " +
      "image/entry batches with idempotent convergence and conflict-safe " +
      "logical invisibility, " +
      "structured " +
      "zhi/quiz editorial publication, and reader-service compatibility."
    );
  } finally {
    if (originalBrokerUrl === undefined) {
      delete process.env[BROKER_ENV_KEY];
    } else {
      process.env[BROKER_ENV_KEY] = originalBrokerUrl;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
