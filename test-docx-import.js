const assert = require("assert");
const vm = require("vm");
const {
  analyzeDocx,
  containsUnsafeOfficeContent,
  decodeXmlEntities,
  normalizePackageTarget,
  parseDocumentXml,
  parseRelationships,
  readDocxImage
} = require("./miniprogram/pages/adminUploads/docxImport");

const CONTENT_TYPES = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const ROOT_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImage1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
    Target="media/cover.png"/>
  <Relationship Id="rLink1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
    Target="https://example.com/" TargetMode="External"/>
</Relationships>`;
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>太阳系&amp;医院船</w:t></w:r></w:p>
    <w:p><w:r><w:t>第一段</w:t><w:tab/><w:t>文字</w:t><w:br/><w:t>换行</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><a:blip r:embed="rImage1"/></w:drawing></w:r></w:p>
  </w:body>
</w:document>`;

function fakeFileSystem(entries) {
  return {
    readZipEntry(options) {
      const output = {};
      options.entries.forEach((entry) => {
        if (Object.prototype.hasOwnProperty.call(entries, entry.path)) {
          output[entry.path] = {
            data: entries[entry.path],
            errMsg: "readZipEntry:ok"
          };
        } else {
          output[entry.path] = {
            errMsg: "readZipEntry:fail no such entry"
          };
        }
      });
      options.success({ entries: output });
    }
  };
}

async function main() {
  assert.strictEqual(decodeXmlEntities("A&amp;B&#33;&#x21;"), "A&B!!");
  assert.strictEqual(
    normalizePackageTarget("word", "media/../media/cover.png"),
    "word/media/cover.png"
  );
  assert.strictEqual(normalizePackageTarget("", "../../escape"), "");

  const relationships = parseRelationships(DOCUMENT_RELS, "word");
  assert.strictEqual(
    relationships.byId.rImage1.path,
    "word/media/cover.png"
  );
  assert.strictEqual(relationships.external.length, 1);

  const parsed = parseDocumentXml(DOCUMENT_XML, relationships);
  assert.strictEqual(parsed.title, "太阳系&医院船");
  assert.deepStrictEqual(parsed.blocks[0], {
    type: "heading",
    text: "太阳系&医院船",
    level: 1
  });
  assert.strictEqual(parsed.blocks[1].text, "第一段\t文字\n换行");
  assert.deepStrictEqual(parsed.blocks[2].images, [1]);
  assert.strictEqual(parsed.images[0].packagePath, "word/media/cover.png");
  assert.strictEqual(parsed.stats.imageReferenceCount, 1);
  assert.strictEqual(parsed.stats.inferredHeadingCount, 0);
  assert.strictEqual(parsed.stats.omittedImageReferences, 0);
  assert.strictEqual(parsed.stats.skippedTableOfContentsParagraphs, 0);
  assert.strictEqual(parsed.stats.unsupportedImageReferences, 0);
  assert.strictEqual(parsed.stats.truncated, false);

  const reusedImageDocument = `
    <w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body>
      <w:p><w:r><w:drawing><a:blip r:embed="rImage1"/></w:drawing></w:r></w:p>
      <w:p><w:r><w:drawing><a:blip r:embed="rImage1"/></w:drawing></w:r></w:p>
    </w:body></w:document>`;
  const reusedImage = parseDocumentXml(reusedImageDocument, relationships);
  assert.strictEqual(reusedImage.images.length, 1);
  assert.strictEqual(reusedImage.stats.imageReferenceCount, 2);
  assert.deepStrictEqual(reusedImage.blocks[0].images, [1]);
  assert.deepStrictEqual(reusedImage.blocks[1].images, [1]);

  const tableOfContentsDocument = `
    <w:document xmlns:w="w"><w:body>
      <w:p><w:r><w:t>目 录</w:t></w:r></w:p>
      <w:p><w:r><w:instrText>PAGEREF _Toc123</w:instrText><w:t>1. 第一章</w:t><w:tab/><w:t>3</w:t></w:r></w:p>
      <w:p><w:r><w:instrText>PAGEREF _Toc456</w:instrText><w:t>2. 第二章</w:t><w:tab/><w:t>8</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading7"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>
      <w:p><w:r><w:t>第二章</w:t></w:r></w:p>
    </w:body></w:document>`;
  const withoutTableOfContents = parseDocumentXml(
    tableOfContentsDocument,
    { byId: {} }
  );
  assert.strictEqual(withoutTableOfContents.blocks.length, 2);
  assert.strictEqual(withoutTableOfContents.blocks[0].text, "第一章");
  assert.strictEqual(withoutTableOfContents.blocks[0].level, 7);
  assert.strictEqual(withoutTableOfContents.blocks[1].text, "第二章");
  assert.strictEqual(withoutTableOfContents.blocks[1].level, 7);
  assert.strictEqual(withoutTableOfContents.stats.inferredHeadingCount, 1);
  assert.strictEqual(
    withoutTableOfContents.stats.skippedTableOfContentsParagraphs,
    3
  );

  assert.strictEqual(
    containsUnsafeOfficeContent(
      CONTENT_TYPES,
      '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package"/>'
    ),
    true
  );

  const fileSystem = fakeFileSystem({
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": ROOT_RELS,
    "word/document.xml": DOCUMENT_XML,
    "word/_rels/document.xml.rels": DOCUMENT_RELS,
    "word/media/cover.png": new Uint8Array([137, 80, 78, 71]).buffer
  });
  const manifest = await analyzeDocx("wxfile://example.docx", { fileSystem });
  assert.strictEqual(manifest.sourceType, "docx");
  assert.strictEqual(manifest.blocks.length, 3);
  assert.strictEqual(manifest.images.length, 1);
  assert.strictEqual(manifest.warnings.length, 1);

  const image = await readDocxImage(
    "wxfile://example.docx",
    "word/media/cover.png",
    { fileSystem }
  );
  assert.ok(image instanceof ArrayBuffer);

  const crossRealmImage = vm.runInNewContext(
    "new Uint8Array([255, 216, 255, 224]).buffer"
  );
  assert.strictEqual(crossRealmImage instanceof ArrayBuffer, false);
  const bridgedImage = await readDocxImage(
    "wxfile://bridged.docx",
    "word/media/cover.png",
    {
      fileSystem: fakeFileSystem({
        "word/media/cover.png": crossRealmImage
      })
    }
  );
  assert.strictEqual(
    Object.prototype.toString.call(bridgedImage),
    "[object ArrayBuffer]"
  );

  const typedArrayImage = await readDocxImage(
    "wxfile://typed-array.docx",
    "word/media/cover.png",
    {
      fileSystem: fakeFileSystem({
        "word/media/cover.png": new Uint8Array([137, 80, 78, 71])
      })
    }
  );
  assert.ok(ArrayBuffer.isView(typedArrayImage));

  await assert.rejects(
    () =>
      readDocxImage(
        "wxfile://missing-image.docx",
        "word/media/missing.png",
        { fileSystem: fakeFileSystem({}) }
      ),
    (error) =>
      error &&
      error.code === "DOCX_ENTRY_READ_FAILED" &&
      error.entryPath === "word/media/missing.png" &&
      error.nativeErrorMessage === "readZipEntry:fail no such entry"
  );

  const unsafeFileSystem = fakeFileSystem({
    "[Content_Types].xml": CONTENT_TYPES.replace(
      "</Types>",
      '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'
    ),
    "_rels/.rels": ROOT_RELS,
    "word/document.xml": DOCUMENT_XML
  });
  await assert.rejects(
    () => analyzeDocx("wxfile://unsafe.docx", { fileSystem: unsafeFileSystem }),
    (error) => error && error.code === "DOCX_ACTIVE_CONTENT"
  );

  console.log("Word 本地导入测试通过：标题、段落、分级标题、图片关系、外链提示和宏拦截。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
