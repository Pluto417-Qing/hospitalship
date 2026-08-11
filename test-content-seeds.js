const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");
const { getContentById } = require("./miniprogram/utils/contents");
const { validateSeeds } = require("./scripts/validate-content-seeds");

const projectRoot = __dirname;
const contentSeedPath = path.join(
  projectRoot,
  "seed-data",
  "content-seeds",
  "esophageal-cancer-story.v1.json"
);
const audioSeedPath = path.join(
  projectRoot,
  "seed-data",
  "audio-seeds",
  "esophageal-cancer-story.v1.json"
);
const bookSeedPath = path.join(
  projectRoot,
  "seed-data",
  "book-seeds",
  "china-hospital-ship.v1.json"
);
const bookChapterSeedPath = path.join(
  projectRoot,
  "seed-data",
  "book-chapter-seeds",
  "china-hospital-ship.esophageal-cancer-story.v1.json"
);
const draftManifestPath = path.join(
  projectRoot,
  "seed-data",
  "draft-content-manifest.json"
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadCloudModule(relativePath, cloud) {
  const filename = path.resolve(projectRoot, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const localRequire = Module.createRequire(filename);
  const sandbox = {
    Buffer,
    clearTimeout,
    console: {
      error: () => {},
      log: console.log,
      warn: () => {}
    },
    __dirname: path.dirname(filename),
    __filename: filename,
    module,
    exports: module.exports,
    require(request) {
      return request === "wx-server-sdk" ? cloud : localRequire(request);
    },
    setTimeout
  };

  vm.runInNewContext(source, sandbox, { filename });
  return module.exports;
}

function createDetailCloud({ content, contentError, openid = "openid-member" }) {
  const userId = "content-seed-member";
  const sessionId = crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
  const database = {
    collection(name) {
      if (name === "memberSessions") {
        return {
          doc(documentId) {
            return {
              async get() {
                return {
                  data:
                    openid && documentId === sessionId
                      ? {
                          _id: sessionId,
                          openid,
                          userId,
                          memberId: "SEEDMEMBER001",
                          status: "active",
                          expiresAt: new Date("2099-01-01T00:00:00.000Z")
                        }
                      : null
                };
              }
            };
          }
        };
      }

      if (name === "users") {
        return {
          doc(documentId) {
            return {
              async get() {
                return {
                  data:
                    openid && documentId === userId
                      ? {
                          _id: userId,
                          openid,
                          registerStatus: "active"
                        }
                      : null
                };
              }
            };
          }
        };
      }

      if (name === "contents") {
        return {
          doc() {
            return {
              async get() {
                if (contentError) {
                  throw contentError;
                }

                return { data: content || null };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    }
  };

  return {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };
}

async function run() {
  const validation = validateSeeds();
  assert.deepStrictEqual(validation, {
    audioCount: 1,
    bookChapterCount: 1,
    bookChapterParagraphCount: 29,
    bookCount: 1,
    contentCount: 1,
    paragraphCount: 29
  });

  const contentSeed = readJson(contentSeedPath);
  const audioSeed = readJson(audioSeedPath);
  const bookSeed = readJson(bookSeedPath);
  const bookChapterSeed = readJson(bookChapterSeedPath);
  const draftManifest = readJson(draftManifestPath);
  const canonicalContent = contentSeed.document;
  const canonicalBook = bookSeed.document;
  const canonicalChapter = bookChapterSeed.document;
  const localContent = getContentById(canonicalContent.contentId);

  assert.strictEqual(canonicalContent.bookId, canonicalBook.bookId);
  assert.strictEqual(canonicalBook._id, canonicalBook.bookId);
  assert.strictEqual(canonicalChapter.bookId, canonicalBook.bookId);
  assert.strictEqual(
    canonicalChapter.bookRevision,
    canonicalBook.currentRevision
  );
  assert.strictEqual(
    canonicalChapter.sourceContentId,
    canonicalContent.contentId
  );
  assert.strictEqual(
    canonicalChapter.sourceContentRevision,
    canonicalContent.currentRevision
  );
  assert.deepStrictEqual(canonicalChapter.sections, canonicalContent.sections);
  assert.strictEqual(canonicalBook.chapterCount, 1);
  assert.deepStrictEqual(canonicalBook.sourceContentIds, [
    canonicalContent.contentId
  ]);
  assert.strictEqual(bookSeed.source.scope, "chapter-source-only");
  assert.ok(bookSeed.source.note.includes("不是《中国医院船》整书 PDF"));
  [canonicalContent, canonicalBook, canonicalChapter].forEach((document) => {
    assert.strictEqual(document.status, "draft");
    assert.strictEqual(document.reviewStatus, "pending");
  });

  const pdf = canonicalBook.pdf;
  const expectedPdfPrefix =
    `protected/books/${canonicalBook.bookId}/${canonicalBook.currentRevision}/`;
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(pdf, "fileID"),
    false,
    "未部署整书种子不得伪造 fileID"
  );
  assert.ok(pdf.cloudPath.startsWith(expectedPdfPrefix));
  assert.ok(pdf.cloudPath.length > expectedPdfPrefix.length);
  assert.ok(!pdf.cloudPath.includes(".."));
  assert.ok(!/[\\\s]/.test(pdf.cloudPath));
  assert.strictEqual(pdf.mimeType, "application/pdf");
  assert.strictEqual(pdf.deploymentStatus, "pending-upload");
  assert.strictEqual(pdf.requiredArtifact, "reviewed-complete-book-pdf");
  assert.strictEqual(
    pdf.fileIDEnvironmentVariable,
    "CHINA_HOSPITAL_SHIP_PDF_FILE_ID"
  );

  assert.deepStrictEqual(draftManifest.seedFiles.books, [
    "seed-data/book-seeds/china-hospital-ship.v1.json"
  ]);
  assert.deepStrictEqual(draftManifest.seedFiles.bookChapters, [
    "seed-data/book-chapter-seeds/china-hospital-ship.esophageal-cancer-story.v1.json"
  ]);
  assert.strictEqual(draftManifest.contents[0].bookId, canonicalBook.bookId);
  assert.strictEqual(draftManifest.books[0].status, "draft");
  assert.strictEqual(draftManifest.books[0].reviewStatus, "pending");
  assert.strictEqual(
    draftManifest.books[0].sourceScope,
    "chapter-source-only"
  );
  assert.strictEqual(
    draftManifest.books[0].pdf.cloudPath,
    canonicalBook.pdf.cloudPath
  );
  assert.strictEqual(
    draftManifest.books[0].pdf.deploymentStatus,
    "pending-upload"
  );
  assert.strictEqual(
    draftManifest.books[0].pdf.requiredArtifact,
    "reviewed-complete-book-pdf"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(draftManifest.books[0].pdf, "fileID"),
    false
  );
  assert.strictEqual(
    draftManifest.bookChapters[0].sourceContentId,
    canonicalContent.contentId
  );

  assert.ok(localContent, "小程序目录元数据缺失");
  ["title", "subtitle", "department", "cover"].forEach((field) => {
    assert.strictEqual(
      localContent[field],
      canonicalContent[field],
      `本地目录字段漂移：${field}`
    );
  });
  assert.strictEqual(localContent.available, false);
  assert.deepStrictEqual(localContent.sections, []);
  assert.strictEqual(localContent.disclaimer, undefined);
  assert.strictEqual(localContent.audio.title, audioSeed.document.title);
  assert.strictEqual(localContent.audio.narrator, audioSeed.document.narrator);
  assert.strictEqual(
    localContent.audio.durationMs,
    audioSeed.document.durationSeconds * 1000
  );
  assert.strictEqual(localContent.audio.sourceAsset, undefined);

  const infrastructureError = new Error("database permission denied");
  infrastructureError.errCode = -502003;
  const failedDetailModule = loadCloudModule(
    "cloudfunctions/getContentDetail/index.js",
    createDetailCloud({ contentError: infrastructureError })
  );
  const failedDetail = await failedDetailModule.main({
    contentId: canonicalContent.contentId,
    mode: "text"
  });

  assert.strictEqual(failedDetail.success, false);
  assert.strictEqual(failedDetail.code, "CONTENT_READ_FAILED");
  assert.strictEqual(failedDetail.content, undefined);

  const publishedContent = {
    ...canonicalContent,
    status: "published"
  };
  const detailModule = loadCloudModule(
    "cloudfunctions/getContentDetail/index.js",
    createDetailCloud({ content: publishedContent })
  );
  const textDetail = await detailModule.main({
    contentId: canonicalContent.contentId,
    mode: "text"
  });

  assert.strictEqual(textDetail.success, true);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(textDetail.content.sections)),
    canonicalContent.sections
  );
  assert.strictEqual(textDetail.content.disclaimer, canonicalContent.disclaimer);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(textDetail.content.accessPolicy)),
    canonicalContent.accessPolicy
  );
  assert.strictEqual(textDetail.content.bookId, canonicalBook.bookId);

  const audioDetail = await detailModule.main({
    contentId: canonicalContent.contentId,
    mode: "audio"
  });
  assert.strictEqual(audioDetail.success, true);
  assert.strictEqual(audioDetail.content.sections, undefined);
  assert.strictEqual(audioDetail.content.accessPolicy.audio, "member");

  console.log(
    "内容种子测试通过：源文件指纹、会员正文、会员配音、整书/章节关联与 PDF 保护路径。"
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
