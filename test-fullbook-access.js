const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OPENID = "guardian-openid";
const USER_ID = "member-child-one";
const BOOK_ID = "hospital-ship";
const BOOK_REVISION = "book-revision-1";
const PRIVATE_PDF_FILE_ID =
  "cloud://test-env/protected/books/hospital-ship/book-revision-1/full.pdf";

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

function createDeterministicId(namespace, values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([namespace, ...values]))
    .digest("hex")
    .slice(0, 32);
}

function createDatabase(seed = {}) {
  const stores = new Map();

  Object.entries(seed).forEach(([collectionName, documents]) => {
    stores.set(
      collectionName,
      new Map(documents.map((document) => [document._id, clone(document)]))
    );
  });

  function getStore(collectionName) {
    if (!stores.has(collectionName)) {
      stores.set(collectionName, new Map());
    }

    return stores.get(collectionName);
  }

  function createDocumentReference(collectionName, documentId) {
    return {
      async get() {
        const document = getStore(collectionName).get(documentId);

        if (!document) {
          const error = new Error("document not found");
          error.errCode = -502004;
          throw error;
        }

        return { data: clone(document) };
      }
    };
  }

  function createQuery(collectionName, filter = {}) {
    const state = {
      filter,
      orderings: [],
      offset: 0,
      limit: Infinity
    };
    const query = {
      where(nextFilter) {
        state.filter = nextFilter || {};
        return query;
      },
      orderBy(field, direction) {
        state.orderings.push({ field, direction });
        return query;
      },
      skip(offset) {
        state.offset = Number(offset) || 0;
        return query;
      },
      limit(limit) {
        state.limit = Number(limit);
        return query;
      },
      async get() {
        const rows = [...getStore(collectionName).values()]
          .filter((document) =>
            Object.entries(state.filter).every(
              ([key, expected]) => document[key] === expected
            )
          )
          .sort((left, right) => {
            for (const ordering of state.orderings) {
              if (left[ordering.field] === right[ordering.field]) {
                continue;
              }

              const comparison = left[ordering.field] < right[ordering.field]
                ? -1
                : 1;
              return ordering.direction === "desc" ? -comparison : comparison;
            }

            return 0;
          })
          .slice(state.offset, state.offset + state.limit)
          .map(clone);

        return { data: rows };
      }
    };

    return query;
  }

  return {
    collection(collectionName) {
      const query = createQuery(collectionName);

      return {
        doc(documentId) {
          return createDocumentReference(collectionName, documentId);
        },
        where(filter) {
          return query.where(filter);
        }
      };
    }
  };
}

function loadCloudFunction(database, signedRequests, { signer = true } = {}) {
  const filename = path.join(
    __dirname,
    "cloudfunctions",
    "getFullBookAccess",
    "index.js"
  );
  const source = fs.readFileSync(filename, "utf8");
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test-env",
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { OPENID };
    }
  };

  if (signer) {
    cloud.getTempFileURL = async ({ fileList }) => {
      signedRequests.push([...fileList]);
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          status: 0,
          tempFileURL: "https://signed.example/full-book.pdf?token=short-lived"
        }))
      };
    };
  }

  const module = { exports: {} };
  const sandbox = {
    URL,
    Buffer,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    module,
    exports: module.exports,
    require(request) {
      return request === "wx-server-sdk" ? cloud : require(request);
    }
  };

  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.main;
}

function createAuthorizedSeed({ includeEntitlement = true, pdfFileID } = {}) {
  const memberSessionId = createDeterministicId("member-session", [OPENID]);
  const entitlementId = createDeterministicId("book-entitlement", [
    USER_ID,
    BOOK_ID
  ]);
  const seed = {
    memberSessions: [
      {
        _id: memberSessionId,
        userId: USER_ID,
        memberId: "BOAT001",
        status: "active",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    ],
    users: [
      {
        _id: USER_ID,
        openid: OPENID,
        memberId: "BOAT001",
        registerStatus: "active"
      }
    ],
    bookEntitlements: includeEntitlement
      ? [
          {
            _id: entitlementId,
            userId: USER_ID,
            bookId: BOOK_ID,
            status: "active"
          }
        ]
      : [],
    books: [
      {
        _id: BOOK_ID,
        bookId: BOOK_ID,
        title: "中国医院船",
        subtitle: "完整书稿测试版",
        currentRevision: BOOK_REVISION,
        status: "published",
        pdf: {
          fileID: pdfFileID || PRIVATE_PDF_FILE_ID,
          fileName: "中国医院船.pdf",
          mimeType: "application/pdf"
        }
      }
    ],
    bookChapters: [
      {
        _id: "chapter-2",
        bookId: BOOK_ID,
        bookRevision: BOOK_REVISION,
        status: "published",
        sortOrder: 2,
        title: "第二章 远航",
        sections: [
          {
            heading: "海上医院",
            paragraphs: ["第二章正文第一段。"]
          }
        ]
      },
      {
        _id: "chapter-1",
        bookId: BOOK_ID,
        bookRevision: BOOK_REVISION,
        status: "published",
        sortOrder: 1,
        title: "第一章 启航",
        sections: [
          {
            heading: "出发",
            paragraphs: ["第一章正文第一段。", "第一章正文第二段。"]
          }
        ]
      }
    ]
  };

  return seed;
}

function assertNoPrivateFileId(result) {
  const serialized = JSON.stringify(result);
  assert.ok(
    !serialized.includes(PRIVATE_PDF_FILE_ID),
    "云函数响应不得泄漏私有 PDF fileID"
  );
  assert.ok(!serialized.includes("sourceFileID"), "响应不得泄漏内部源字段");
  assert.ok(!serialized.includes('"fileID"'), "响应不得包含 fileID 字段");
}

async function testLoginRequired() {
  const signedRequests = [];
  const database = createDatabase({
    memberSessions: [],
    users: [],
    bookEntitlements: [],
    books: [],
    bookChapters: []
  });
  const main = loadCloudFunction(database, signedRequests);
  const result = await main({ bookId: BOOK_ID });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, "MEMBER_LOGIN_REQUIRED");
  assert.strictEqual(signedRequests.length, 0, "未登录时不得签发 PDF 链接");
}

async function testAccessLocked() {
  const signedRequests = [];
  const database = createDatabase(
    createAuthorizedSeed({ includeEntitlement: false })
  );
  const main = loadCloudFunction(database, signedRequests);
  const result = await main({ bookId: BOOK_ID });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, "BOOK_ACCESS_LOCKED");
  assert.strictEqual(signedRequests.length, 0, "无阅读权限时不得签发 PDF 链接");
}

async function testAuthorizedChapterReadingAndPrivatePdf() {
  const signedRequests = [];
  const database = createDatabase(createAuthorizedSeed());
  const main = loadCloudFunction(database, signedRequests);
  const firstPage = await main({ bookId: BOOK_ID, offset: 0, limit: 1 });

  assert.strictEqual(firstPage.success, true);
  assert.strictEqual(firstPage.access, "unlocked");
  assert.strictEqual(firstPage.book.title, "中国医院船");
  assert.strictEqual(firstPage.book.chapters.length, 1);
  assert.strictEqual(firstPage.book.chapters[0].id, "chapter-1");
  assert.strictEqual(firstPage.book.chapters[0].title, "第一章 启航");
  assert.strictEqual(
    firstPage.book.chapters[0].sections[0].paragraphs[1],
    "第一章正文第二段。"
  );
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 1);
  assert.strictEqual(firstPage.book.pdf.available, true);
  assert.strictEqual(firstPage.book.pdf.downloadReady, true);
  assert.strictEqual(
    firstPage.book.pdf.downloadUrl,
    "https://signed.example/full-book.pdf?token=short-lived"
  );
  assert.strictEqual(signedRequests.length, 1);
  assert.strictEqual(signedRequests[0][0], PRIVATE_PDF_FILE_ID);
  assertNoPrivateFileId(firstPage);

  const secondPage = await main({ bookId: BOOK_ID, offset: 1, limit: 1 });
  assert.strictEqual(secondPage.success, true);
  assert.strictEqual(secondPage.book.chapters.length, 1);
  assert.strictEqual(secondPage.book.chapters[0].id, "chapter-2");
  assert.strictEqual(secondPage.hasMore, false);
  assert.strictEqual(secondPage.nextOffset, null);
  assertNoPrivateFileId(secondPage);
}

async function testNonPrivatePdfIsRejected() {
  const signedRequests = [];
  const database = createDatabase(
    createAuthorizedSeed({
      pdfFileID: "cloud://test-env/published/books/hospital-ship.pdf"
    })
  );
  const main = loadCloudFunction(database, signedRequests);
  const result = await main({ bookId: BOOK_ID });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.book.pdf.available, false);
  assert.strictEqual(result.book.pdf.downloadReady, false);
  assert.strictEqual(result.book.pdf.downloadUrl, undefined);
  assert.strictEqual(signedRequests.length, 0, "非私有路径不得进入签名流程");
}

async function run() {
  await testLoginRequired();
  await testAccessLocked();
  await testAuthorizedChapterReadingAndPrivatePdf();
  await testNonPrivatePdfIsRejected();
  console.log("整书访问专项测试通过：会话、权限、章节分页与私有 PDF 交付均符合契约。");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
