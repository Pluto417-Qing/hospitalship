const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const BROKER_ENV_KEY = "ADMIN_UPLOAD_BROKER_URL";
const VALID_BROKER_URL = "https://uploads.example.test/v1/admin-staging";
const NORMALIZED_VALID_BROKER_URL = new URL(VALID_BROKER_URL).toString();

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

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => document[key] === value);
}

function getNestedValue(source, pathValue) {
  return String(pathValue)
    .split(".")
    .reduce(
      (value, key) =>
        value && Object.prototype.hasOwnProperty.call(value, key)
          ? value[key]
          : undefined,
      source
    );
}

function setNestedValue(target, pathValue, value) {
  const parts = String(pathValue).split(".");
  let cursor = target;

  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = clone(value);
      return;
    }

    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
  });
}

function projectFields(document, fields) {
  if (!fields) return clone(document);

  const projected = {};
  Object.entries(fields).forEach(([pathValue, included]) => {
    if (!included) return;
    const value = getNestedValue(document, pathValue);
    if (value !== undefined) {
      setNestedValue(projected, pathValue, value);
    }
  });
  return projected;
}

class MemoryDatabase {
  constructor(seed = {}) {
    this.stores = new Map();
    this.clock = Date.now();
    this.transactionQueue = Promise.resolve();
    this.transactionTraces = [];
    this.beforeTransactionHooks = [];
    this.fieldProjections = [];

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

  collection(name) {
    const database = this;

    return {
      doc(documentId) {
        return {
          async get() {
            return {
              data: database.store(name).has(documentId)
                ? clone(database.store(name).get(documentId))
                : null
            };
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
      },
      where(filter) {
        const query = {
          filter,
          orders: [],
          offset: 0,
          limit: Infinity,
          fields: null
        };
        const chain = {
          field(fields) {
            query.fields = clone(fields);
            database.fieldProjections.push(clone(fields));
            return chain;
          },
          orderBy(field, direction) {
            query.orders.push({ field, direction });
            return chain;
          },
          skip(offset) {
            query.offset = offset;
            return chain;
          },
          limit(limit) {
            query.limit = limit;
            return chain;
          },
          async get() {
            const rows = database
              .documents(name)
              .filter((document) => matches(document, query.filter));

            for (let index = query.orders.length - 1; index >= 0; index -= 1) {
              const order = query.orders[index];
              const factor = order.direction === "desc" ? -1 : 1;
              rows.sort((left, right) => {
                const leftValue = left[order.field];
                const rightValue = right[order.field];

                if (leftValue === rightValue) {
                  return 0;
                }

                return (leftValue < rightValue ? -1 : 1) * factor;
              });
            }

            return {
              data: rows
                .slice(query.offset, query.offset + query.limit)
                .map((document) => projectFields(document, query.fields))
            };
          }
        };

        return chain;
      },
      orderBy(field, direction) {
        return this.where({}).orderBy(field, direction);
      },
      field(fields) {
        return this.where({}).field(fields);
      },
      skip(offset) {
        return this.where({}).skip(offset);
      },
      limit(limit) {
        return this.where({}).limit(limit);
      },
      get() {
        return this.where({}).get();
      }
    };
  }

  serverDate() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  beforeNextTransaction(callback) {
    this.beforeTransactionHooks.push(callback);
  }

  runTransaction(callback) {
    const execution = this.transactionQueue.then(async () => {
      const trace = {
        operations: [],
        startedAt: Date.now(),
        elapsedMs: 0,
        success: false
      };
      const hook = this.beforeTransactionHooks.shift();
      if (hook) await hook();
      const transaction = {
        collection: (name) => {
          const collection = this.collection(name);
          return {
            ...collection,
            doc: (documentId) => {
              const reference = collection.doc(documentId);
              return {
                async get() {
                  trace.operations.push({
                    operation: "get",
                    collection: name,
                    documentId
                  });
                  return reference.get();
                },
                async set(options) {
                  trace.operations.push({
                    operation: "set",
                    collection: name,
                    documentId
                  });
                  return reference.set(options);
                },
                async update(options) {
                  trace.operations.push({
                    operation: "update",
                    collection: name,
                    documentId
                  });
                  return reference.update(options);
                }
              };
            }
          };
        }
      };

      try {
        const result = await callback(transaction);
        trace.success = true;
        return result;
      } finally {
        trace.elapsedMs = Date.now() - trace.startedAt;
        this.transactionTraces.push(trace);
      }
    });
    this.transactionQueue = execution.catch(() => {});
    return execution;
  }
}

function loadAdminContentCenter(database, openid, storageState) {
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {},
    async getTempFileURL({ fileList }) {
      storageState.verifyCalls += 1;
      return {
        fileList: fileList.map((item) => {
          const fileID = typeof item === "string" ? item : item.fileID;
          return storageState.files.has(fileID)
            ? {
                fileID,
                status: 0,
                tempFileURL: `https://temporary.invalid/${encodeURIComponent(fileID)}`
              }
            : { fileID, status: -1, errMsg: "not found" };
        })
      };
    },
    async deleteFile({ fileList }) {
      storageState.deleteCalls += 1;
      return {
        fileList: fileList.map((fileID) => {
          storageState.files.delete(fileID);
          return { fileID, status: 0 };
        })
      };
    }
  };
  const functionPath = path.join(
    __dirname,
    "cloudfunctions/adminContentCenter/index.js"
  );
  const originalLoad = Module._load;

  delete require.cache[require.resolve(functionPath)];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return cloud;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(functionPath).main;
  } finally {
    Module._load = originalLoad;
  }
}

function adminAccount(id, openid, role) {
  return {
    _id: id,
    openid,
    role,
    status: "active"
  };
}

function storageState() {
  return {
    files: new Set(),
    verifyCalls: 0,
    deleteCalls: 0
  };
}

function declaration(assetType, overrides = {}) {
  const fixtures = {
    manuscript: {
      fileName: "正文书稿.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentId: "content-one"
    },
    audio: {
      fileName: "配音.mp3",
      mimeType: "audio/mpeg",
      contentId: "content-one"
    },
    "special-topic": {
      fileName: "小专题.pdf",
      mimeType: "application/pdf",
      topicId: "topic-one"
    },
    "full-book-pdf": {
      fileName: "全本.pdf",
      mimeType: "application/pdf",
      bookId: "hospital-ship"
    },
    "topic-image": {
      fileName: "专题插图.png",
      mimeType: "image/png",
      topicId: "topic-one"
    }
  };

  return {
    action: "createUpload",
    assetType,
    declaredBytes: 1024,
    ...fixtures[assetType],
    ...(assetType === "special-topic"
      ? {
          fileName: "special-topic.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
      : {}),
    ...overrides
  };
}

function clientManifest({
  title = "测试文稿",
  body = "这是从 Word 中读取的正文。",
  withImage = false,
  imageCount = 0
} = {}) {
  const totalImages = Math.max(
    0,
    Math.min(200, Number(imageCount) || (withImage ? 1 : 0))
  );
  const blocks = [
    { type: "heading", text: title, level: 1 },
    {
      type: "paragraph",
      text: body,
      ...(totalImages > 0
        ? { images: Array.from({ length: totalImages }, (_, index) => index + 1) }
        : {})
    }
  ];
  const images = Array.from({ length: totalImages }, (_, index) => {
    const order = index + 1;
    return {
        relationId: `rImage${order}`,
        packagePath: `word/media/image${order}.png`,
        extension: ".png",
        order,
        caption: `示例图片${totalImages === 1 ? "" : order}`
      };
  });

  return {
    schemaVersion: 1,
    sourceType: "docx",
    title,
    blocks,
    images,
    warnings: [],
    stats: {
      extractedBlocks: blocks.length,
      extractedCharacters: title.length + body.length,
      imageCount: images.length,
      imageReferenceCount: images.length,
      omittedImageReferences: 0,
      unsupportedImageReferences: 0,
      totalParagraphs: blocks.length,
      truncated: false
    }
  };
}

function splitSpecialTopicManifest(imageCount = 200) {
  const manifest = clientManifest({ imageCount });
  const midpoint = Math.ceil(manifest.images.length / 2);
  const firstImageOrders = manifest.images
    .slice(0, midpoint)
    .map((image) => image.order);
  const secondImageOrders = manifest.images
    .slice(midpoint)
    .map((image) => image.order);
  const blocks = [
    { type: "heading", text: manifest.title, level: 1 },
    { type: "heading", text: "第一部分", level: 1 },
    {
      type: "paragraph",
      text: "这是从 Word 中读取的第一部分正文。",
      images: firstImageOrders
    },
    { type: "heading", text: "第二部分", level: 1 },
    {
      type: "paragraph",
      text: "这是从 Word 中读取的第二部分正文。",
      images: secondImageOrders
    }
  ];
  return {
    ...manifest,
    blocks,
    stats: {
      ...manifest.stats,
      extractedBlocks: blocks.length,
      extractedCharacters: blocks.reduce(
        (sum, block) => sum + block.text.length,
        0
      ),
      imageReferenceCount: manifest.images.length,
      totalParagraphs: blocks.length
    }
  };
}

function realScaleSpecialTopicManifest() {
  const title = "太阳系的物体";
  const targetCharacters = 62238;
  const blocks = [{ type: "heading", text: title, level: 1 }];
  const paragraphBlocks = [];
  const images = [];
  let imageOrder = 1;

  for (let entryIndex = 0; entryIndex < 101; entryIndex += 1) {
    blocks.push({
      type: "heading",
      text: `第${String(entryIndex + 1).padStart(3, "0")}节`,
      level: 1
    });
    const paragraphCount = entryIndex < 82 ? 10 : 9;
    for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
      const paragraph = {
        type: "paragraph",
        text:
          `第${String(entryIndex + 1).padStart(3, "0")}节` +
          `第${String(paragraphIndex + 1).padStart(2, "0")}段。`
      };
      if (paragraphIndex === 0) {
        const entryImageCount = entryIndex < 99 ? 2 : 1;
        paragraph.images = [];
        for (let index = 0; index < entryImageCount; index += 1) {
          const order = imageOrder;
          paragraph.images.push(order);
          images.push({
            relationId: `rImage${order}`,
            packagePath: `word/media/image${order}.png`,
            extension: ".png",
            order,
            caption: `图${String(order).padStart(3, "0")}`
          });
          imageOrder += 1;
        }
      }
      blocks.push(paragraph);
      paragraphBlocks.push(paragraph);
    }
  }

  assert.strictEqual(blocks.length, 1093);
  assert.strictEqual(paragraphBlocks.length, 991);
  assert.strictEqual(images.length, 200);
  const currentCharacters = blocks.reduce(
    (sum, block) => sum + block.text.length,
    0
  );
  let remainingCharacters = targetCharacters - currentCharacters;
  assert.ok(remainingCharacters > 0);
  const filler = "太阳系科学观察记录";
  paragraphBlocks.forEach((paragraph, index) => {
    const remainingParagraphs = paragraphBlocks.length - index;
    const additionalLength = Math.floor(
      remainingCharacters / remainingParagraphs
    );
    paragraph.text += filler
      .repeat(Math.ceil(additionalLength / filler.length))
      .slice(0, additionalLength);
    remainingCharacters -= additionalLength;
  });

  const extractedCharacters = blocks.reduce(
    (sum, block) => sum + block.text.length,
    0
  );
  assert.strictEqual(extractedCharacters, targetCharacters);

  return {
    schemaVersion: 1,
    sourceType: "docx",
    title,
    blocks,
    images,
    warnings: [],
    stats: {
      extractedBlocks: blocks.length,
      extractedCharacters,
      imageCount: images.length,
      imageReferenceCount: images.length,
      inferredHeadingCount: 0,
      omittedImageReferences: 0,
      skippedTableOfContentsParagraphs: 101,
      unsupportedImageReferences: 0,
      totalParagraphs: blocks.length + 101,
      truncated: false
    }
  };
}

function oversizedFinalDraftManifest() {
  const manifest = realScaleSpecialTopicManifest();
  const targetCharacters = 130000;
  const paragraphs = manifest.blocks.filter(
    (block) => block.type === "paragraph"
  );
  let remainingCharacters = targetCharacters - manifest.stats.extractedCharacters;
  paragraphs.forEach((paragraph, index) => {
    const remainingParagraphs = paragraphs.length - index;
    const additionalLength = Math.floor(
      remainingCharacters / remainingParagraphs
    );
    paragraph.text += "x".repeat(additionalLength);
    remainingCharacters -= additionalLength;
  });
  assert.strictEqual(remainingCharacters, 0);

  manifest.images = manifest.images.map((image) => {
    const orderSuffix = `-${image.order}.png`;
    const relationPrefix = `r${image.order}_`;
    return {
      ...image,
      relationId: relationPrefix + "r".repeat(128 - relationPrefix.length),
      packagePath:
        "word/media/" +
        "p".repeat(430 - "word/media/".length - orderSuffix.length) +
        orderSuffix,
      caption: `caption-${image.order}-` +
        "c".repeat(300 - `caption-${image.order}-`.length)
    };
  });
  manifest.stats = {
    ...manifest.stats,
    extractedCharacters: manifest.blocks.reduce(
      (sum, block) => sum + block.text.length,
      0
    )
  };
  assert.strictEqual(manifest.stats.extractedCharacters, targetCharacters);
  assert.strictEqual(manifest.images.length, 200);
  return manifest;
}

function storedUpload(database, uploadId) {
  const upload = database.store("adminUploads").get(uploadId);
  assert.ok(upload, `missing stored upload ${uploadId}`);
  return upload;
}

function simulateBrokerCompletion(database, uploadId, overrides = {}) {
  const upload = storedUpload(database, uploadId);
  const fileID = `cloud://test-environment/${upload.cloudPath}`;
  const completed = {
    ...upload,
    status: "uploaded",
    ticketStatus: "consumed",
    transportMode: "https-broker",
    transportStatus: "broker_uploaded",
    fileID,
    actualBytes: upload.declaredBytes,
    sha256: "a".repeat(64),
    validationStatus: "validated",
    inspection: {
      schemaVersion: 1,
      signatureValid: true,
      assetType: upload.assetType,
      extension: upload.extension,
      actualBytes: upload.declaredBytes
    },
    uploadedAt: new Date(),
    updateTime: new Date(),
    ...overrides
  };
  database.store("adminUploads").set(uploadId, completed);
  return completed;
}

function setBrokerUrl(value) {
  if (value === undefined) {
    delete process.env[BROKER_ENV_KEY];
    return;
  }

  process.env[BROKER_ENV_KEY] = value;
}

function assertSecureUploadReservation(result, database, assetType) {
  assert.strictEqual(result.success, true, assetType);
  assert.strictEqual(result.upload.status, "pending_upload");
  assert.match(result.upload.id, /^[a-f0-9]{32}$/);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.upload, "cloudPath"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.upload, "fileID"),
    false
  );

  const transport = result.uploadTransport;
  assert.ok(transport, `${assetType}: missing upload transport`);
  assert.strictEqual(transport.directClientUploadAllowed, false);
  assert.strictEqual(transport.mode, "https-broker");
  assert.strictEqual(transport.originalFileUploadRequired, true);
  assert.strictEqual(transport.sourceMode, "original-file");
  assert.strictEqual(
    transport.url,
    `${NORMALIZED_VALID_BROKER_URL}/${result.upload.id}`
  );
  assert.strictEqual(transport.fieldName, "file");
  assert.match(transport.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(
    new Date(transport.expiresAt).getTime(),
    new Date(result.upload.expiresAt).getTime()
  );
  assert.ok(Number.isSafeInteger(transport.maximumBytes));
  assert.ok(transport.maximumBytes >= result.upload.declaredBytes);

  const stored = database.store("adminUploads").get(result.upload.id);
  assert.ok(stored, `${assetType}: reservation was not stored`);
  assert.match(
    stored.cloudPath,
    /^admin-staging\/[a-f0-9]{24}\/[a-f0-9]{32}\/source\.[a-z0-9]+$/
  );
  const expectedTicketHash = crypto
    .createHash("sha256")
    .update(transport.ticket)
    .digest("hex");

  assert.match(stored.uploadTicketHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(stored.uploadTicketHash, expectedTicketHash);
  assert.strictEqual(stored.ticketStatus, "active");
  assert.strictEqual(stored.transportMode, "https-broker");
  assert.strictEqual(stored.transportStatus, "ticket_issued");
  assert.strictEqual(stored.originalFileUploadRequired, true);
  assert.strictEqual(stored.sourceMode, "original-file");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(stored, "uploadTicket"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(stored, "ticket"),
    false
  );
  assert.strictEqual(JSON.stringify(stored).includes(transport.ticket), false);
  assert.strictEqual(
    JSON.stringify(result).includes(stored.uploadTicketHash),
    false
  );
}

async function reserveUpload(main, database, assetType, overrides = {}) {
  const result = await main(declaration(assetType, overrides));
  assertSecureUploadReservation(result, database, assetType);
  return result;
}

function assertDirectUploadReservation(result, database, assetType) {
  assert.strictEqual(result.success, true, assetType);
  assert.strictEqual(result.upload.status, "pending_upload");
  assert.match(result.upload.id, /^[a-f0-9]{32}$/);

  const transport = result.uploadTransport;
  assert.ok(transport, `${assetType}: missing direct upload transport`);
  assert.strictEqual(transport.directClientUploadAllowed, true);
  assert.strictEqual(transport.mode, "cloud-storage-direct");
  const manifestOnly = ["manuscript", "special-topic"].includes(assetType);
  assert.strictEqual(
    transport.originalFileUploadRequired,
    !manifestOnly
  );
  assert.strictEqual(
    transport.sourceMode,
    manifestOnly ? "client-manifest-only" : "original-file"
  );
  assert.strictEqual(
    transport.requiresClientManifest,
    !["audio", "full-book-pdf"].includes(assetType)
  );
  if (assetType === "audio") {
    assert.match(
      transport.cloudPath,
      /^published\/audio\/content-one\/assets\/[a-f0-9]{32}\/primary\.mp3$/
    );
  } else if (assetType === "full-book-pdf") {
    assert.match(
      transport.cloudPath,
      /^protected\/books\/hospital-ship\/assets\/[a-f0-9]{32}\/hospital-ship\.pdf$/
    );
  } else if (!manifestOnly) {
    assert.match(
      transport.cloudPath,
      /^admin-direct-staging\/[a-f0-9]{24}\/[a-f0-9]{32}\/source\.[a-z0-9]+$/
    );
  } else {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(transport, "cloudPath"),
      false
    );
  }
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(transport, "ticket"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(transport, "url"),
    false
  );

  const stored = storedUpload(database, result.upload.id);
  assert.strictEqual(stored.cloudPath, transport.cloudPath || "");
  assert.strictEqual(stored.uploadTicketHash, "");
  assert.strictEqual(stored.ticketStatus, "not_required");
  assert.strictEqual(stored.transportMode, "cloud-storage-direct");
  assert.strictEqual(
    stored.transportStatus,
    manifestOnly ? "direct_manifest_reserved" : "direct_reserved"
  );
  assert.strictEqual(
    stored.validationStatus,
    manifestOnly ? "awaiting_client_manifest" : "awaiting_upload"
  );
  assert.strictEqual(stored.sourceMode, transport.sourceMode);
  assert.strictEqual(
    stored.originalFileUploadRequired,
    transport.originalFileUploadRequired
  );
  if (manifestOnly) {
    assert.strictEqual(stored.rawFileValidationStatus, "not_uploaded");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(stored, "fileID"),
      false
    );
  }
}

async function testAuthorizationAndStatus() {
  const database = new MemoryDatabase({
    adminAccounts: [
      adminAccount("moderator-a", "moderator-openid", "moderator"),
      adminAccount("uploader-a", "uploader-openid", "uploader"),
      adminAccount("reviewer-a", "reviewer-openid", "content-reviewer"),
      adminAccount("admin-a", "admin-openid", "admin")
    ]
  });
  const state = storageState();
  const moderator = loadAdminContentCenter(
    database,
    "moderator-openid",
    state
  );
  const uploader = loadAdminContentCenter(
    database,
    "uploader-openid",
    state
  );
  const reviewer = loadAdminContentCenter(
    database,
    "reviewer-openid",
    state
  );
  const admin = loadAdminContentCenter(database, "admin-openid", state);
  const moderationOnly = await moderator({ action: "status" });
  const allowed = await uploader({ action: "status" });
  const reviewerStatus = await reviewer({ action: "status" });
  const adminStatus = await admin({ action: "status" });

  assert.strictEqual(moderationOnly.success, true);
  assert.strictEqual(moderationOnly.capabilities.upload, false);
  assert.strictEqual(moderationOnly.capabilities.review, false);
  assert.strictEqual(moderationOnly.capabilities.moderation, true);
  assert.strictEqual(allowed.success, true);
  assert.strictEqual(allowed.capabilities.upload, true);
  assert.strictEqual(allowed.capabilities.moderation, false);
  assert.strictEqual(allowed.capabilities.directClientUpload, false);
  assert.strictEqual(allowed.capabilities.transportMode, "https-broker");
  assert.strictEqual(JSON.stringify(allowed).includes("openid"), false);
  assert.strictEqual(reviewerStatus.capabilities.moderation, true);
  assert.strictEqual(adminStatus.capabilities.moderation, true);
}

async function testBrokerConfigurationFallsBackToPrivateDirectUpload() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);

  try {
    for (const [label, brokerUrl] of [
      ["missing", undefined],
      ["non-https", "http://uploads.example.test/v1/admin-staging"]
    ]) {
      setBrokerUrl(brokerUrl);
      const status = await main({ action: "status" });

      assert.strictEqual(status.success, true, label);
      assert.strictEqual(status.capabilities.upload, true, label);
      assert.strictEqual(status.capabilities.directClientUpload, true, label);
      assert.strictEqual(
        status.capabilities.transportMode,
        "cloud-storage-direct",
        label
      );
      assert.strictEqual(
        status.capabilities.directUploadRequiresClientManifest,
        true,
        label
      );

      const reservationCount = database.documents("adminUploads").length;
      const result = await main(declaration("manuscript"));
      assertDirectUploadReservation(result, database, "manuscript");
      assert.strictEqual(
        database.documents("adminUploads").length,
        reservationCount + 1,
        label
      );
    }
  } finally {
    setBrokerUrl(VALID_BROKER_URL);
  }

  assert.strictEqual(database.documents("adminUploads").length, 2);
}

async function testDeclarationValidationAndPrivateTargets() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);

  const badName = await main(
    declaration("manuscript", { fileName: "../正文书稿.docx" })
  );
  assert.strictEqual(badName.code, "INVALID_FILE_NAME");

  const badMime = await main(
    declaration("audio", { fileName: "配音.mp3", mimeType: "audio/wav" })
  );
  assert.strictEqual(badMime.code, "INVALID_FILE_FORMAT");

  const legacyDoc = await main(
    declaration("manuscript", {
      fileName: "旧版正文.doc",
      mimeType: "application/msword"
    })
  );
  assert.strictEqual(legacyDoc.code, "LEGACY_DOC_UNSUPPORTED");
  assert.match(legacyDoc.message, /\.docx/);

  const topicPdf = await main(
    declaration("special-topic", {
      fileName: "special-topic.pdf",
      mimeType: "application/pdf"
    })
  );
  assert.strictEqual(topicPdf.code, "INVALID_FILE_FORMAT");

  const tooLarge = await main(
    declaration("topic-image", { declaredBytes: 21 * 1024 * 1024 })
  );
  assert.strictEqual(tooLarge.code, "INVALID_FILE_SIZE");

  const fullBookTooLarge = await main(
    declaration("full-book-pdf", {
      declaredBytes: 50 * 1024 * 1024 + 1
    })
  );
  assert.strictEqual(fullBookTooLarge.code, "INVALID_FILE_SIZE");

  const chapterExample = await main(
    declaration("full-book-pdf", {
      fileName: "食管癌的故事（定稿）.pdf"
    })
  );
  assert.strictEqual(
    chapterExample.code,
    "BOOK_CHAPTER_SOURCE_NOT_COMPLETE"
  );

  for (const clientDurationSeconds of [
    "42.5",
    0,
    -1,
    Number.POSITIVE_INFINITY,
    24 * 60 * 60 + 0.1
  ]) {
    const invalidDuration = await main(
      declaration("audio", { clientDurationSeconds })
    );
    assert.strictEqual(
      invalidDuration.code,
      "INVALID_CLIENT_AUDIO_DURATION"
    );
  }
  const durationOnPdf = await main(
    declaration("full-book-pdf", { clientDurationSeconds: 42.5 })
  );
  assert.strictEqual(
    durationOnPdf.code,
    "INVALID_CLIENT_AUDIO_DURATION"
  );

  const badRelation = await main(
    declaration("full-book-pdf", { bookId: "../other-book" })
  );
  assert.strictEqual(badRelation.code, "INVALID_RELATED_ID");

  const uploads = [];

  for (const assetType of [
    "manuscript",
    "audio",
    "special-topic",
    "full-book-pdf",
    "topic-image"
  ]) {
    const result = await reserveUpload(main, database, assetType);
    assert.strictEqual(
      storedUpload(database, result.upload.id).cloudPath.includes("正文书稿"),
      false
    );
    uploads.push(result);
  }

  assert.strictEqual(
    new Set(uploads.map((result) => result.upload.id)).size,
    5
  );
  assert.strictEqual(
    new Set(uploads.map((result) => result.uploadTransport.ticket)).size,
    5
  );
  assert.strictEqual(database.documents("adminUploads").length, 5);
  const fullBookReservation = uploads.find(
    (item) => item.upload.assetType === "full-book-pdf"
  );
  assert.strictEqual(
    fullBookReservation.uploadTransport.maximumBytes,
    50 * 1024 * 1024
  );
}

async function testConfirmIsExactAndConcurrentIdempotent() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);
  const created = await reserveUpload(main, database, "manuscript");
  const upload = created.upload;

  const beforeBroker = await main({
    action: "confirmUpload",
    uploadId: upload.id,
    cloudPath: "admin-staging/client-must-not-control-this",
    fileID: "cloud://test-environment/client-must-not-control-this"
  });
  assert.strictEqual(beforeBroker.code, "UPLOAD_NOT_BROKER_CONFIRMED");

  const completed = simulateBrokerCompletion(database, upload.id);
  state.files.add(completed.fileID);

  const request = {
    action: "confirmUpload",
    uploadId: upload.id
  };
  const confirmations = await Promise.all([main(request), main(request)]);

  assert.strictEqual(confirmations.every((result) => result.success), true);
  assert.strictEqual(
    confirmations.every((result) => result.alreadyConfirmed === true),
    true
  );
  assert.strictEqual(
    JSON.stringify(confirmations).includes(created.uploadTransport.ticket),
    false
  );
  const stored = database.store("adminUploads").get(upload.id);
  assert.strictEqual(stored.status, "uploaded");
  assert.strictEqual(stored.reviewStatus, "not_submitted");
  assert.strictEqual(stored.fileID, completed.fileID);
  assert.strictEqual(database.documents("contents").length, 0);
}

async function testMissingAndInvalidBrokerStateFailClosed() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);
  const missingCreated = await reserveUpload(main, database, "audio");
  simulateBrokerCompletion(database, missingCreated.upload.id);
  const missing = await main({
    action: "confirmUpload",
    uploadId: missingCreated.upload.id
  });
  assert.strictEqual(missing.code, "UPLOADED_FILE_NOT_FOUND");

  const invalidCreated = await reserveUpload(main, database, "audio");
  const invalidCompleted = simulateBrokerCompletion(
    database,
    invalidCreated.upload.id,
    {
      inspection: {
        schemaVersion: 1,
        signatureValid: false,
        assetType: "audio",
        extension: ".mp3",
        actualBytes: invalidCreated.upload.declaredBytes
      }
    }
  );
  state.files.add(invalidCompleted.fileID);
  const invalid = await main({
    action: "confirmUpload",
    uploadId: invalidCreated.upload.id
  });
  assert.strictEqual(invalid.code, "UPLOAD_NOT_BROKER_CONFIRMED");
}

async function testDirectConfirmationIsExactUnverifiedAndCancelable() {
  const database = new MemoryDatabase({
    adminAccounts: [
      adminAccount("admin-a", "admin-openid", "admin"),
      adminAccount("admin-b", "other-admin-openid", "admin")
    ]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);
  const otherMain = loadAdminContentCenter(
    database,
    "other-admin-openid",
    state
  );

  try {
    setBrokerUrl(undefined);
    const created = await main(declaration("manuscript"));
    assertDirectUploadReservation(created, database, "manuscript");
    const rejectedOriginal = await main({
      action: "confirmUpload",
      uploadId: created.upload.id,
      fileID:
        "cloud://test-environment/admin-direct-staging/fake/source.docx"
    });
    assert.strictEqual(
      rejectedOriginal.code,
      "UPLOAD_ORIGINAL_NOT_REQUIRED"
    );
    assert.strictEqual(state.verifyCalls, 0);
    const stored = storedUpload(database, created.upload.id);
    assert.strictEqual(stored.fileID, undefined);
    assert.strictEqual(stored.cloudPath, "");
    assert.strictEqual(stored.status, "pending_upload");
    assert.strictEqual(stored.transportStatus, "direct_manifest_reserved");
    assert.strictEqual(stored.validationStatus, "awaiting_client_manifest");
    assert.strictEqual(stored.rawFileValidationStatus, "not_uploaded");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(stored, "actualBytes"),
      false
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(stored, "sha256"),
      false
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(stored, "inspection"),
      false
    );

    const blockedDraft = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "direct-draft-0001"
    });
    assert.strictEqual(blockedDraft.success, false);
    assert.strictEqual(
      blockedDraft.code,
      "SOURCE_UPLOAD_MANIFEST_REQUIRED"
    );
    assert.strictEqual(database.documents("adminContentDrafts").length, 0);

    const attachEvent = {
      action: "attachClientManifest",
      uploadId: created.upload.id,
      requestId: "attach-manifest-0001",
      fileID: "cloud://attacker-environment/forged/source.docx",
      manifest: clientManifest()
    };
    const attached = await main(attachEvent);
    assert.strictEqual(attached.success, true);
    assert.strictEqual(attached.alreadyApplied, false);
    assert.strictEqual(attached.requiresClientManifest, false);
    assert.strictEqual(attached.requiresClientImages, false);
    assert.strictEqual(attached.canCreateDraft, true);
    assert.match(attached.manifestSha256, /^[a-f0-9]{64}$/);
    const attachedUpload = storedUpload(database, created.upload.id);
    assert.strictEqual(attachedUpload.status, "uploaded");
    assert.strictEqual(
      attachedUpload.validationStatus,
      "client_manifest_validated"
    );
    assert.strictEqual(
      attachedUpload.rawFileValidationStatus,
      "not_uploaded"
    );
    assert.strictEqual(attachedUpload.fileID, undefined);
    assert.strictEqual(attachedUpload.cloudPath, "");
    assert.strictEqual(
      attachedUpload.sourceMode,
      "client-manifest-only"
    );
    assert.ok(attachedUpload.clientDraftPayload.sections.length > 0);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(attachedUpload, "sha256"),
      false,
      "客户端清单哈希不得冒充原文件 SHA-256"
    );

    const attachReplay = await main(attachEvent);
    assert.strictEqual(attachReplay.success, true);
    assert.strictEqual(attachReplay.alreadyApplied, true);
    const reusedRequest = await main({
      ...attachEvent,
      manifest: clientManifest({ body: "另一份正文" })
    });
    assert.strictEqual(reusedRequest.code, "IDEMPOTENCY_KEY_REUSED");

    const createdDraft = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "direct-draft-0002"
    });
    assert.strictEqual(createdDraft.success, true);
    assert.strictEqual(createdDraft.draft.rawFileValidationStatus, undefined);
    const storedDraft = database
      .store("adminContentDrafts")
      .get(created.upload.id);
    assert.strictEqual(
      storedDraft.sourceFingerprints[0].scope,
      "client-parsed-docx-manifest"
    );
    assert.strictEqual(
      storedDraft.sourceFingerprints[0].rawFileVerified,
      false
    );
    assert.strictEqual(
      storedDraft.sourceFingerprints[0].originalFileRetained,
      false
    );
    assert.strictEqual(storedDraft.sourceFileID, "");
    assert.strictEqual(storedDraft.sourceMode, "client-manifest-only");
    assert.strictEqual(
      storedDraft.rawFileValidationStatus,
      "not_uploaded"
    );
    assert.strictEqual(
      storedUpload(database, created.upload.id).clientDraftPayload,
      null
    );

    const attachAfterDraft = await main(attachEvent);
    assert.strictEqual(attachAfterDraft.success, true);
    assert.strictEqual(attachAfterDraft.alreadyApplied, true);

    const cancelCreated = await main(declaration("manuscript"));
    assertDirectUploadReservation(cancelCreated, database, "manuscript");
    const canceled = await main({
      action: "cancelUpload",
      uploadId: cancelCreated.upload.id
    });
    assert.strictEqual(canceled.success, true);
    assert.strictEqual(
      storedUpload(database, cancelCreated.upload.id).status,
      "canceled"
    );

    const imageCreated = await main(declaration("special-topic", {
      fileName: "图文专题.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));
    assertDirectUploadReservation(imageCreated, database, "special-topic");
    const imageAttached = await main({
      action: "attachClientManifest",
      uploadId: imageCreated.upload.id,
      requestId: "attach-images-0001",
      manifest: clientManifest({ withImage: true })
    });
    assert.strictEqual(imageAttached.success, true);
    assert.strictEqual(imageAttached.requiresClientImages, true);
    assert.strictEqual(imageAttached.canCreateDraft, false);
    assert.strictEqual(imageAttached.imageUploadPlan.length, 1);
    const imagePlan = imageAttached.imageUploadPlan[0];
    assert.match(
      imagePlan.cloudPath,
      new RegExp(
        `^protected/special-topics/topic-one/assets/${imageCreated.upload.id}/` +
        "embedded/0001\\.png$"
      )
    );
    const imageBlockedDraft = await main({
      action: "createDraftFromUpload",
      uploadId: imageCreated.upload.id,
      requestId: "images-draft-0001"
    });
    assert.strictEqual(
      imageBlockedDraft.code,
      "SOURCE_UPLOAD_IMAGES_REQUIRED"
    );
    const imageFileID =
      `cloud://test-environment/${imagePlan.cloudPath}`;
    const invalidImageConfirmation = await main({
      action: "confirmClientImages",
      uploadId: imageCreated.upload.id,
      requestId: "confirm-images-invalid-0001",
      files: [{
        imageOrder: imagePlan.imageOrder,
        packagePath: imagePlan.packagePath,
        extension: imagePlan.extension,
        cloudPath: `${imagePlan.cloudPath}-wrong`,
        fileID: `${imageFileID}-wrong`
      }]
    });
    assert.strictEqual(
      invalidImageConfirmation.code,
      "CLIENT_IMAGE_CONFIRMATION_INVALID"
    );
    state.files.add(imageFileID);
    const confirmImagesEvent = {
      action: "confirmClientImages",
      uploadId: imageCreated.upload.id,
      requestId: "confirm-images-0001",
      files: [{
        imageOrder: imagePlan.imageOrder,
        packagePath: imagePlan.packagePath,
        extension: imagePlan.extension,
        cloudPath: imagePlan.cloudPath,
        fileID: imageFileID
      }]
    };
    const confirmedImages = await main(confirmImagesEvent);
    assert.strictEqual(confirmedImages.success, true);
    assert.strictEqual(confirmedImages.alreadyApplied, false);
    assert.strictEqual(confirmedImages.confirmedCount, 1);
    assert.strictEqual(confirmedImages.totalCount, 1);
    assert.strictEqual(confirmedImages.remainingCount, 0);
    assert.strictEqual(confirmedImages.complete, true);
    assert.strictEqual(confirmedImages.requiresClientImages, false);
    assert.strictEqual(confirmedImages.canCreateDraft, true);
    const confirmedImagesReplay = await main(confirmImagesEvent);
    assert.strictEqual(confirmedImagesReplay.success, true);
    assert.strictEqual(confirmedImagesReplay.alreadyApplied, true);
    const imageDraft = await main({
      action: "createDraftFromUpload",
      uploadId: imageCreated.upload.id,
      requestId: "images-draft-0002"
    });
    assert.strictEqual(imageDraft.success, true);
    const storedImageDraft = database
      .store("adminContentDrafts")
      .get(imageCreated.upload.id);
    assert.strictEqual(storedImageDraft.embeddedAssets.length, 1);
    assert.strictEqual(
      storedImageDraft.embeddedAssets[0].fileID,
      imageFileID
    );
    assert.deepStrictEqual(
      storedImageDraft.payload.embeddedAssets,
      storedImageDraft.embeddedAssets
    );
    const embeddedBlocks = storedImageDraft.payload.entries
      .flatMap((entry) => entry.blocks)
      .filter((block) => block.type === "image");
    assert.deepStrictEqual(embeddedBlocks, [{
      type: "image",
      embeddedAssetId: "embedded-0001",
      caption: "示例图片"
    }]);

    const manuscriptImageCreated = await main(declaration("manuscript"));
    const manuscriptImageAttach = await main({
      action: "attachClientManifest",
      uploadId: manuscriptImageCreated.upload.id,
      requestId: "attach-manuscript-images-0001",
      manifest: clientManifest({ withImage: true })
    });
    assert.strictEqual(manuscriptImageAttach.success, true);
    assert.strictEqual(manuscriptImageAttach.requiresClientImages, true);
    assert.strictEqual(manuscriptImageAttach.canCreateDraft, false);
    assert.strictEqual(manuscriptImageAttach.imageUploadPlan.length, 1);
    const manuscriptImagePlan = manuscriptImageAttach.imageUploadPlan[0];
    assert.match(
      manuscriptImagePlan.cloudPath,
      new RegExp(
        `^protected/contents/content-one/assets/` +
        `${manuscriptImageCreated.upload.id}/embedded/0001\\.png$`
      )
    );
    const manuscriptImageFileID =
      `cloud://test-environment/${manuscriptImagePlan.cloudPath}`;
    state.files.add(manuscriptImageFileID);
    const manuscriptImagesConfirmed = await main({
      action: "confirmClientImages",
      uploadId: manuscriptImageCreated.upload.id,
      requestId: "confirm-manuscript-images-0001",
      files: [{
        imageOrder: manuscriptImagePlan.imageOrder,
        packagePath: manuscriptImagePlan.packagePath,
        extension: manuscriptImagePlan.extension,
        cloudPath: manuscriptImagePlan.cloudPath,
        fileID: manuscriptImageFileID
      }]
    });
    assert.strictEqual(manuscriptImagesConfirmed.success, true);
    assert.strictEqual(manuscriptImagesConfirmed.canCreateDraft, true);
    const manuscriptImageDraft = await main({
      action: "createDraftFromUpload",
      uploadId: manuscriptImageCreated.upload.id,
      requestId: "draft-manuscript-images-0001"
    });
    assert.strictEqual(manuscriptImageDraft.success, true);
    const storedManuscriptImageDraft = database
      .store("adminContentDrafts")
      .get(manuscriptImageCreated.upload.id);
    assert.strictEqual(storedManuscriptImageDraft.embeddedAssets.length, 1);
    assert.deepStrictEqual(
      storedManuscriptImageDraft.payload.sections[0].blocks,
      [
        { type: "text", text: "这是从 Word 中读取的正文。" },
        {
          type: "image",
          embeddedAssetId: "embedded-0001",
          caption: "示例图片"
        }
      ]
    );
    assert.strictEqual(
      storedUpload(database, manuscriptImageCreated.upload.id).validationStatus,
      "client_manifest_validated"
    );

    const partialCreated = await main(declaration("special-topic", {
      fileName: "分批图文专题.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));
    const partialAttached = await main({
      action: "attachClientManifest",
      uploadId: partialCreated.upload.id,
      requestId: "attach-partial-images-0001",
      manifest: clientManifest({ imageCount: 51 })
    });
    assert.strictEqual(partialAttached.success, true);
    assert.strictEqual(partialAttached.imageUploadPlan.length, 51);
    const [firstPlan, secondPlan] = partialAttached.imageUploadPlan;
    const firstFileID =
      `cloud://test-environment/${firstPlan.cloudPath}`;
    const secondFileID =
      `cloud://test-environment/${secondPlan.cloudPath}`;
    const partialImageFileIDs = partialAttached.imageUploadPlan.map(
      (plan) => `cloud://test-environment/${plan.cloudPath}`
    );
    partialImageFileIDs.forEach((imageFileID) => state.files.add(imageFileID));
    const oversizedBatch = await main({
      action: "confirmClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "confirm-partial-images-too-many-0001",
      files: partialAttached.imageUploadPlan.slice(0, 21).map(
        (plan, index) => ({
          imageOrder: plan.imageOrder,
          packagePath: plan.packagePath,
          extension: plan.extension,
          cloudPath: plan.cloudPath,
          fileID: partialImageFileIDs[index]
        })
      )
    });
    assert.strictEqual(oversizedBatch.code, "CLIENT_IMAGE_BATCH_INVALID");
    const firstBatch = {
      action: "confirmClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "confirm-partial-images-0001",
      files: [{
        imageOrder: firstPlan.imageOrder,
        packagePath: firstPlan.packagePath,
        extension: firstPlan.extension,
        cloudPath: firstPlan.cloudPath,
        fileID: firstFileID
      }]
    };
    const firstBatchResult = await main(firstBatch);
    assert.strictEqual(firstBatchResult.success, true);
    assert.strictEqual(firstBatchResult.confirmedCount, 1);
    assert.strictEqual(firstBatchResult.totalCount, 51);
    assert.strictEqual(firstBatchResult.remainingCount, 50);
    assert.strictEqual(firstBatchResult.complete, false);
    assert.strictEqual(firstBatchResult.canCreateDraft, false);
    assert.strictEqual(
      storedUpload(database, partialCreated.upload.id)
        .clientImageEnvironment,
      "test-environment"
    );

    const crossEnvironmentFileID =
      `cloud://other-environment/${secondPlan.cloudPath}`;
    state.files.add(crossEnvironmentFileID);
    const crossEnvironment = await main({
      action: "confirmClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "confirm-partial-images-cross-environment-0001",
      files: [{
        imageOrder: secondPlan.imageOrder,
        packagePath: secondPlan.packagePath,
        extension: secondPlan.extension,
        cloudPath: secondPlan.cloudPath,
        fileID: crossEnvironmentFileID
      }]
    });
    assert.strictEqual(
      crossEnvironment.code,
      "CLIENT_IMAGE_CONFIRMATION_INVALID"
    );

    const crossOwnerConfirmation = await otherMain(firstBatch);
    assert.strictEqual(crossOwnerConfirmation.code, "UPLOAD_NOT_FOUND");
    const reusedImageMutation = await main({
      ...firstBatch,
      files: [{
        imageOrder: secondPlan.imageOrder,
        packagePath: secondPlan.packagePath,
        extension: secondPlan.extension,
        cloudPath: secondPlan.cloudPath,
        fileID: secondFileID
      }]
    });
    assert.strictEqual(
      reusedImageMutation.code,
      "IDEMPOTENCY_KEY_REUSED"
    );

    const resumedFirst = await main({
      action: "resumeClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "resume-partial-images-0001"
    });
    assert.strictEqual(resumedFirst.success, true);
    assert.strictEqual(resumedFirst.resumedCount, 20);
    assert.strictEqual(resumedFirst.confirmedCount, 21);
    assert.strictEqual(resumedFirst.remainingCount, 30);
    assert.strictEqual(resumedFirst.validationStatus, "awaiting_client_images");
    const resumedFirstReplay = await main({
      action: "resumeClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "resume-partial-images-0001"
    });
    assert.strictEqual(resumedFirstReplay.success, true);
    assert.strictEqual(resumedFirstReplay.alreadyApplied, true);
    assert.strictEqual(resumedFirstReplay.resumedCount, 0);
    assert.strictEqual(resumedFirstReplay.confirmedCount, 21);
    const resumedSecond = await main({
      action: "resumeClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "resume-partial-images-0002"
    });
    assert.strictEqual(resumedSecond.success, true);
    assert.strictEqual(resumedSecond.resumedCount, 20);
    assert.strictEqual(resumedSecond.confirmedCount, 41);
    const resumedFinal = await main({
      action: "resumeClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "resume-partial-images-0003"
    });
    assert.strictEqual(resumedFinal.success, true);
    assert.strictEqual(resumedFinal.resumedCount, 10);
    assert.strictEqual(resumedFinal.confirmedCount, 51);
    assert.strictEqual(resumedFinal.remainingCount, 0);
    assert.strictEqual(resumedFinal.complete, true);
    assert.strictEqual(
      resumedFinal.validationStatus,
      "client_manifest_validated"
    );
    const crossOwnerResume = await otherMain({
      action: "resumeClientImages",
      uploadId: partialCreated.upload.id,
      requestId: "resume-partial-images-other-owner-0001"
    });
    assert.strictEqual(crossOwnerResume.code, "UPLOAD_NOT_FOUND");

    const deleteCallsBeforePartialCancel = state.deleteCalls;
    const partialCanceled = await main({
      action: "cancelUpload",
      uploadId: partialCreated.upload.id
    });
    assert.strictEqual(partialCanceled.success, true);
    assert.strictEqual(partialCanceled.cleanupRequired, true);
    assert.strictEqual(partialCanceled.cleanupRemainingCount, 51);
    assert.strictEqual(
      partialImageFileIDs.every((imageFileID) => state.files.has(imageFileID)),
      true
    );
    assert.strictEqual(
      state.deleteCalls - deleteCallsBeforePartialCancel,
      0,
      "取消必须先提交状态，不能同步清理 51 张图片"
    );
    const uploadsAfterPartialCancel = await main({
      action: "listUploads",
      limit: 50
    });
    const publicPartialCanceled = uploadsAfterPartialCancel.uploads.find(
      (upload) => upload.id === partialCreated.upload.id
    );
    assert.ok(publicPartialCanceled);
    assert.strictEqual(publicPartialCanceled.cleanupRequired, true);
    assert.strictEqual(publicPartialCanceled.cleanupRemainingCount, 51);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        publicPartialCanceled,
        "cleanupFileIDs"
      ),
      false
    );
    assert.strictEqual(
      JSON.stringify(publicPartialCanceled).includes("cloud://"),
      false
    );
    const cleanupFirst = await main({
      action: "cleanupCanceledUpload",
      uploadId: partialCreated.upload.id,
      requestId: "cleanup-partial-images-0001"
    });
    assert.strictEqual(cleanupFirst.success, true);
    assert.strictEqual(cleanupFirst.cleanupProcessedCount, 20);
    assert.strictEqual(cleanupFirst.cleanupRemainingCount, 31);
    const cleanupFirstReplay = await main({
      action: "cleanupCanceledUpload",
      uploadId: partialCreated.upload.id,
      requestId: "cleanup-partial-images-0001"
    });
    assert.strictEqual(cleanupFirstReplay.success, true);
    assert.strictEqual(cleanupFirstReplay.alreadyApplied, true);
    assert.strictEqual(cleanupFirstReplay.cleanupRemainingCount, 31);
    await main({
      action: "cleanupCanceledUpload",
      uploadId: partialCreated.upload.id,
      requestId: "cleanup-partial-images-0002"
    });
    const cleanupFinal = await main({
      action: "cleanupCanceledUpload",
      uploadId: partialCreated.upload.id,
      requestId: "cleanup-partial-images-0003"
    });
    assert.strictEqual(cleanupFinal.success, true);
    assert.strictEqual(cleanupFinal.cleanupProcessedCount, 11);
    assert.strictEqual(cleanupFinal.cleanupRemainingCount, 0);
    assert.strictEqual(cleanupFinal.cleanupRequired, false);
    assert.strictEqual(
      partialImageFileIDs.every((imageFileID) => !state.files.has(imageFileID)),
      true
    );
    assert.strictEqual(
      state.deleteCalls - deleteCallsBeforePartialCancel,
      3,
      "51 images must be deleted in three bounded cleanup batches"
    );
    const storedPartialCanceled = storedUpload(
      database,
      partialCreated.upload.id
    );
    assert.strictEqual(storedPartialCanceled.cleanupRequired, false);
    assert.deepStrictEqual(storedPartialCanceled.cleanupFileIDs, []);

    const expired = await main(declaration("special-topic"));
    assertDirectUploadReservation(expired, database, "special-topic");
    const expiredUpload = storedUpload(database, expired.upload.id);
    expiredUpload.expiresAt = new Date(Date.now() - 1000);
    database.store("adminUploads").set(expired.upload.id, expiredUpload);
    const expiredConfirm = await main({
      action: "attachClientManifest",
      uploadId: expired.upload.id,
      requestId: "expired-manifest-0001",
      manifest: clientManifest()
    });
    assert.strictEqual(expiredConfirm.code, "UPLOAD_RESERVATION_EXPIRED");
  } finally {
    setBrokerUrl(VALID_BROKER_URL);
  }
}

async function testResumeClientImagesAfterReloadAtFortyOfTwoHundred() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const originalBrokerUrl = process.env[BROKER_ENV_KEY];

  try {
    setBrokerUrl("");
    const main = loadAdminContentCenter(database, "admin-openid", state);
    const created = await main(declaration("special-topic", {
      fileName: "resume-200-images.docx"
    }));
    const attached = await main({
      action: "attachClientManifest",
      uploadId: created.upload.id,
      requestId: "attach-resume-200-images-0001",
      manifest: splitSpecialTopicManifest(200)
    });
    assert.strictEqual(
      attached.success,
      true,
      `attach 200-image manifest failed: ${JSON.stringify(attached)}`
    );
    assert.strictEqual(attached.imageUploadPlan.length, 200);
    const fileIDs = attached.imageUploadPlan.map(
      (plan) => `cloud://test-environment/${plan.cloudPath}`
    );
    fileIDs.forEach((fileID) => state.files.add(fileID));
    const confirmationFiles = (offset, limit) =>
      attached.imageUploadPlan.slice(offset, offset + limit).map(
        (plan, index) => ({
          imageOrder: plan.imageOrder,
          packagePath: plan.packagePath,
          extension: plan.extension,
          cloudPath: plan.cloudPath,
          fileID: fileIDs[offset + index]
        })
      );
    await main({
      action: "confirmClientImages",
      uploadId: created.upload.id,
      requestId: "confirm-resume-200-images-0001",
      files: confirmationFiles(0, 20)
    });
    const confirmedForty = await main({
      action: "confirmClientImages",
      uploadId: created.upload.id,
      requestId: "confirm-resume-200-images-0002",
      files: confirmationFiles(20, 20)
    });
    assert.strictEqual(confirmedForty.confirmedCount, 40);
    assert.strictEqual(confirmedForty.remainingCount, 160);

    const afterReload = loadAdminContentCenter(
      database,
      "admin-openid",
      state
    );
    const resumed = await afterReload({
      action: "resumeClientImages",
      uploadId: created.upload.id,
      requestId: "resume-after-reload-200-images-0001"
    });
    assert.strictEqual(resumed.success, true);
    assert.strictEqual(resumed.resumedCount, 20);
    assert.strictEqual(resumed.confirmedCount, 60);
    assert.strictEqual(resumed.remainingCount, 140);
    assert.strictEqual(resumed.validationStatus, "awaiting_client_images");
    const replay = await afterReload({
      action: "resumeClientImages",
      uploadId: created.upload.id,
      requestId: "resume-after-reload-200-images-0001"
    });
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.alreadyApplied, true);
    assert.strictEqual(replay.confirmedCount, 60);
  } finally {
    setBrokerUrl(originalBrokerUrl);
  }
}

async function testRealScaleSpecialTopicDraftCreationIsBoundedAndIdempotent() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const originalBrokerUrl = process.env[BROKER_ENV_KEY];

  try {
    setBrokerUrl("");
    const main = loadAdminContentCenter(database, "admin-openid", state);
    const manifest = realScaleSpecialTopicManifest();
    assert.strictEqual(manifest.blocks.length, 1093);
    assert.strictEqual(manifest.stats.extractedCharacters, 62238);
    assert.strictEqual(manifest.images.length, 200);

    const created = await main(declaration("special-topic", {
      fileName: "real-scale-200-images.docx",
      declaredBytes: 58295855
    }));
    const attached = await main({
      action: "attachClientManifest",
      uploadId: created.upload.id,
      requestId: "attach-real-scale-200-images-0001",
      manifest
    });
    assert.strictEqual(
      attached.success,
      true,
      `attach real-scale manifest failed: ${JSON.stringify(attached)}`
    );
    assert.strictEqual(attached.imageUploadPlan.length, 200);

    const fileIDs = attached.imageUploadPlan.map(
      (plan) => `cloud://test-environment/${plan.cloudPath}`
    );
    fileIDs.forEach((fileID) => state.files.add(fileID));
    for (let batchIndex = 0; batchIndex < 10; batchIndex += 1) {
      const offset = batchIndex * 20;
      const confirmation = await main({
        action: "confirmClientImages",
        uploadId: created.upload.id,
        requestId:
          `confirm-real-scale-200-images-${String(batchIndex + 1).padStart(2, "0")}`,
        files: attached.imageUploadPlan
          .slice(offset, offset + 20)
          .map((plan, index) => ({
            imageOrder: plan.imageOrder,
            packagePath: plan.packagePath,
            extension: plan.extension,
            cloudPath: plan.cloudPath,
            fileID: fileIDs[offset + index]
          }))
      });
      assert.strictEqual(
        confirmation.success,
        true,
        `image confirmation batch ${batchIndex + 1} failed`
      );
      assert.strictEqual(confirmation.confirmedCount, offset + 20);
      assert.strictEqual(confirmation.remainingCount, 180 - offset);
    }

    const confirmedUpload = clone(storedUpload(database, created.upload.id));
    assert.strictEqual(confirmedUpload.validationStatus, "client_manifest_validated");
    assert.strictEqual(confirmedUpload.clientDraftPayload.entries.length, 101);

    const tracesBeforeChangedSource = database.transactionTraces.length;
    database.beforeNextTransaction(() => {
      const changedUpload = clone(storedUpload(database, created.upload.id));
      changedUpload.clientImageUploadPlan[0].packagePath =
        "word/media/concurrently-changed-image.png";
      database.store("adminUploads").set(created.upload.id, changedUpload);
    });
    const changedSourceResult = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "create-real-scale-changed-source-0001"
    });
    assert.strictEqual(
      changedSourceResult.success,
      false,
      `concurrent source mutation was not rejected: ${JSON.stringify(changedSourceResult)}`
    );
    assert.strictEqual(changedSourceResult.code, "SOURCE_UPLOAD_CHANGED");
    assert.strictEqual(database.documents("adminContentDrafts").length, 0);
    assert.strictEqual(
      database.transactionTraces.length,
      tracesBeforeChangedSource + 1
    );
    database.store("adminUploads").set(
      created.upload.id,
      clone(confirmedUpload)
    );

    const tracesBeforeCreate = database.transactionTraces.length;
    const startedAt = Date.now();
    const createEvent = {
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "create-real-scale-200-images-0001"
    };
    const createdDraft = await main(createEvent);
    const elapsedMs = Date.now() - startedAt;
    assert.strictEqual(
      createdDraft.success,
      true,
      `create real-scale draft failed: ${JSON.stringify(createdDraft)}`
    );
    assert.ok(createdDraft.draft.id);
    assert.strictEqual(createdDraft.draft.payloadOmitted, true);
    assert.strictEqual(createdDraft.draft.payload.entries, undefined);
    assert.strictEqual(createdDraft.draft.payload.embeddedAssets, undefined);
    assert.ok(
      Buffer.byteLength(JSON.stringify(createdDraft), "utf8") < 32 * 1024,
      "createDraft response must remain lightweight for a 200-image draft"
    );
    assert.ok(
      elapsedMs < 3000,
      `real-scale draft creation took ${elapsedMs}ms locally`
    );

    const storedDraft = database
      .store("adminContentDrafts")
      .get(created.upload.id);
    assert.ok(storedDraft);
    assert.strictEqual(storedDraft.payload.entries.length, 101);
    assert.strictEqual(storedDraft.embeddedAssets.length, 200);
    assert.strictEqual(storedDraft.payload.embeddedAssets.length, 200);
    const storedBlocks = storedDraft.payload.entries.flatMap(
      (entry) => entry.blocks
    );
    const storedImageBlocks = storedBlocks.filter(
      (block) => block.type === "image"
    );
    assert.strictEqual(storedBlocks.length, 1292);
    assert.strictEqual(storedImageBlocks.length, 200);
    assert.strictEqual(
      new Set(storedImageBlocks.map((block) => block.embeddedAssetId)).size,
      200
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(storedDraft), "utf8") < 1024 * 1024,
      "real-scale draft must fit within the document database size limit"
    );

    const createTraces = database.transactionTraces.slice(tracesBeforeCreate);
    const atomicCreateTrace = createTraces.find((trace) =>
      trace.operations.some((operation) =>
        operation.operation === "set" &&
        operation.collection === "adminContentDrafts"
      )
    );
    assert.ok(atomicCreateTrace, "missing atomic createDraft transaction");
    const createOperations = atomicCreateTrace.operations;
    assert.deepStrictEqual(
      createOperations
        .filter((operation) => operation.operation === "get")
        .map((operation) => operation.collection)
        .sort(),
      ["adminAccounts", "adminContentDrafts", "adminUploads"].sort()
    );
    assert.deepStrictEqual(
      createOperations
        .filter((operation) => operation.operation === "set")
        .map((operation) => operation.collection),
      ["adminContentDrafts"]
    );
    assert.deepStrictEqual(
      createOperations
        .filter((operation) => operation.operation === "update")
        .map((operation) => operation.collection),
      ["adminUploads"]
    );
    assert.strictEqual(
      createOperations.some((operation) =>
        operation.collection === "specialTopics" ||
        operation.collection === "contents" ||
        operation.collection === "books"
      ),
      false,
      "createDraft transaction must not read a target collection"
    );
    const atomicallyLinkedUpload = storedUpload(database, created.upload.id);
    assert.strictEqual(atomicallyLinkedUpload.draftId, createdDraft.draft.id);
    assert.strictEqual(atomicallyLinkedUpload.ingestionStatus, "draft_created");
    assert.strictEqual(atomicallyLinkedUpload.reviewStatus, "not_submitted");

    const listedDrafts = await main({
      action: "listDrafts",
      offset: 0,
      limit: 50
    });
    assert.strictEqual(listedDrafts.success, true);
    assert.strictEqual(listedDrafts.drafts.length, 1);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(listedDrafts.drafts[0], "payload"),
      false,
      "listDrafts must never return the full draft payload"
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(listedDrafts), "utf8") < 64 * 1024,
      "listDrafts response must stay bounded for a 200-image draft"
    );
    assert.ok(
      database.fieldProjections.some((fields) =>
        fields["payload.title"] === true &&
        fields["inspection.metadata.previewParagraphCount"] === true &&
        !Object.prototype.hasOwnProperty.call(fields, "payload")
      ),
      "listDrafts must project summary fields instead of fetching full payloads"
    );

    const draftBeforeOversizedSave = clone(
      database.store("adminContentDrafts").get(created.upload.id)
    );
    const oversizedSave = await main({
      action: "saveDraft",
      draftId: created.upload.id,
      expectedDraftVersion: draftBeforeOversizedSave.draftVersion,
      requestId: "save-real-scale-too-large-0001",
      patch: {
        entries: draftBeforeOversizedSave.payload.entries.map((entry) => ({
          ...clone(entry),
          blocks: [
            ...clone(entry.blocks),
            { type: "text", text: "超".repeat(2200) }
          ]
        }))
      }
    });
    assert.strictEqual(oversizedSave.success, false);
    assert.strictEqual(oversizedSave.code, "DRAFT_TOO_LARGE");
    assert.ok(
      oversizedSave.draftDocumentBytes >
        oversizedSave.maximumDraftDocumentBytes
    );
    const draftAfterOversizedSave = database
      .store("adminContentDrafts")
      .get(created.upload.id);
    assert.strictEqual(
      draftAfterOversizedSave.draftVersion,
      draftBeforeOversizedSave.draftVersion,
      "oversized save must not change the draft version"
    );
    assert.strictEqual(
      draftAfterOversizedSave.payload.entries.length,
      draftBeforeOversizedSave.payload.entries.length,
      "oversized save must not replace the stored payload"
    );

    const tracesBeforeReplay = database.transactionTraces.length;
    const replay = await main(createEvent);
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.alreadyApplied, true);
    assert.strictEqual(replay.draft.id, createdDraft.draft.id);
    assert.strictEqual(replay.draft.payloadOmitted, true);
    assert.strictEqual(database.transactionTraces.length, tracesBeforeReplay);

    const detachedUpload = clone(storedUpload(database, created.upload.id));
    detachedUpload.draftId = "";
    detachedUpload.ingestionStatus = "uploaded";
    detachedUpload.reviewStatus = "not_started";
    database.store("adminUploads").set(created.upload.id, detachedUpload);

    const cancelBoundUpload = await main({
      action: "cancelUpload",
      uploadId: created.upload.id
    });
    assert.strictEqual(cancelBoundUpload.success, false);
    assert.strictEqual(cancelBoundUpload.code, "UPLOAD_BOUND_TO_DRAFT");
    assert.strictEqual(storedUpload(database, created.upload.id).status, "uploaded");
    assert.strictEqual(database.documents("adminContentDrafts").length, 1);

    const cleanupFileID =
      "cloud://test-environment/admin-direct-staging/historical/source.docx";
    state.files.add(cleanupFileID);
    const halfCanceledUpload = clone(storedUpload(database, created.upload.id));
    halfCanceledUpload.status = "canceled";
    halfCanceledUpload.draftId = "";
    halfCanceledUpload.cleanupRequired = true;
    halfCanceledUpload.cleanupFileID = cleanupFileID;
    halfCanceledUpload.cleanupFileIDs = [cleanupFileID];
    database.store("adminUploads").set(created.upload.id, halfCanceledUpload);
    const deleteCallsBeforeBoundCleanup = state.deleteCalls;
    const boundCleanup = await main({
      action: "cleanupCanceledUpload",
      uploadId: created.upload.id,
      requestId: "cleanup-bound-real-scale-upload-0001"
    });
    assert.strictEqual(boundCleanup.success, false);
    assert.strictEqual(boundCleanup.code, "UPLOAD_BOUND_TO_DRAFT");
    assert.strictEqual(state.deleteCalls, deleteCallsBeforeBoundCleanup);
    assert.strictEqual(state.files.has(cleanupFileID), true);

    database.store("adminUploads").set(created.upload.id, detachedUpload);
    const repaired = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "repair-real-scale-draft-link-0001"
    });
    assert.strictEqual(repaired.success, true);
    assert.strictEqual(repaired.alreadyApplied, true);
    assert.strictEqual(repaired.uploadReconciled, true);
    assert.strictEqual(repaired.draft.id, createdDraft.draft.id);
    const repairedUpload = storedUpload(database, created.upload.id);
    assert.strictEqual(repairedUpload.draftId, createdDraft.draft.id);
    assert.strictEqual(repairedUpload.ingestionStatus, "draft_created");
    assert.strictEqual(repairedUpload.reviewStatus, "not_submitted");
    assert.strictEqual(database.documents("adminContentDrafts").length, 1);
  } finally {
    setBrokerUrl(originalBrokerUrl);
  }
}

async function testAdminsAreIsolatedAndListsHideOpenid() {
  const database = new MemoryDatabase({
    adminAccounts: [
      adminAccount("admin-a", "admin-a-openid", "admin"),
      adminAccount("admin-b", "admin-b-openid", "uploader")
    ]
  });
  const state = storageState();
  const adminA = loadAdminContentCenter(database, "admin-a-openid", state);
  const adminB = loadAdminContentCenter(database, "admin-b-openid", state);
  const createdA = await reserveUpload(adminA, database, "manuscript");
  const createdB = await reserveUpload(adminB, database, "manuscript");
  const completedB = simulateBrokerCompletion(database, createdB.upload.id);
  state.files.add(completedB.fileID);

  const listA = await adminA({ action: "listUploads" });
  const listB = await adminB({ action: "listUploads" });
  assert.deepStrictEqual(listA.uploads.map((item) => item.id), [createdA.upload.id]);
  assert.deepStrictEqual(listB.uploads.map((item) => item.id), [createdB.upload.id]);
  assert.strictEqual(JSON.stringify(listA).includes("openid"), false);
  assert.strictEqual(JSON.stringify(listB).includes("openid"), false);
  assert.strictEqual(
    JSON.stringify(listA).includes(createdA.uploadTransport.ticket),
    false
  );
  assert.strictEqual(
    JSON.stringify(listB).includes(createdB.uploadTransport.ticket),
    false
  );
  assert.strictEqual(JSON.stringify(listA).includes("uploadTicketHash"), false);
  assert.strictEqual(JSON.stringify(listB).includes("uploadTicketHash"), false);
  assert.strictEqual(JSON.stringify(listA).includes("admin-staging/"), false);
  assert.strictEqual(JSON.stringify(listB).includes("admin-staging/"), false);
  assert.strictEqual(JSON.stringify(listA).includes("cloud://"), false);
  assert.strictEqual(JSON.stringify(listB).includes("cloud://"), false);

  const crossConfirm = await adminA({
    action: "confirmUpload",
    uploadId: createdB.upload.id
  });
  assert.strictEqual(crossConfirm.code, "UPLOAD_NOT_FOUND");

  const crossCancel = await adminA({
    action: "cancelUpload",
    uploadId: createdB.upload.id
  });
  assert.strictEqual(crossCancel.code, "UPLOAD_NOT_FOUND");
}

async function testCancelHidesCleanupFile() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);
  const created = await reserveUpload(main, database, "full-book-pdf");
  const preparedCloudPath =
    `protected/books/hospital-ship/assets/${created.upload.id}/hospital-ship.pdf`;
  const preparedFileID = `cloud://test-environment/${preparedCloudPath}`;
  const completed = simulateBrokerCompletion(database, created.upload.id, {
    preparedCloudPath,
    preparedFileID
  });
  state.files.add(completed.fileID);
  state.files.add(preparedFileID);
  const confirmed = await main({
    action: "confirmUpload",
    uploadId: created.upload.id
  });
  assert.strictEqual(confirmed.success, true);
  assert.strictEqual(JSON.stringify(confirmed).includes("admin-staging/"), false);
  assert.strictEqual(JSON.stringify(confirmed).includes("cloud://"), false);

  const canceled = await main({
    action: "cancelUpload",
    uploadId: created.upload.id
  });
  assert.strictEqual(canceled.success, true);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(canceled, "cleanupFileID"),
    false
  );
  assert.strictEqual(JSON.stringify(canceled).includes("admin-staging/"), false);
  assert.strictEqual(JSON.stringify(canceled).includes("cloud://"), false);
  const storedPendingCleanup = storedUpload(database, created.upload.id);
  assert.strictEqual(storedPendingCleanup.cleanupRequired, true);
  assert.strictEqual(storedPendingCleanup.cleanupFileIDs.length, 2);
  assert.strictEqual(state.files.has(completed.fileID), true);
  assert.strictEqual(state.files.has(preparedFileID), true);
  assert.strictEqual(state.deleteCalls, 0);

  const cleaned = await main({
    action: "cleanupCanceledUpload",
    uploadId: created.upload.id,
    requestId: "cleanup-hidden-files-0001"
  });
  assert.strictEqual(cleaned.success, true);
  assert.strictEqual(cleaned.cleanupProcessedCount, 2);
  assert.strictEqual(cleaned.cleanupRemainingCount, 0);
  assert.strictEqual(JSON.stringify(cleaned).includes("admin-staging/"), false);
  assert.strictEqual(JSON.stringify(cleaned).includes("cloud://"), false);
  const storedCanceled = storedUpload(database, created.upload.id);
  assert.strictEqual(storedCanceled.cleanupRequired, false);
  assert.strictEqual(storedCanceled.cleanupFileID, "");
  assert.deepStrictEqual(storedCanceled.cleanupFileIDs, []);
  assert.strictEqual(state.files.has(completed.fileID), false);
  assert.strictEqual(state.files.has(preparedFileID), false);
  assert.strictEqual(state.deleteCalls, 1);

  const retry = await main({
    action: "cancelUpload",
    uploadId: created.upload.id
  });
  assert.strictEqual(retry.success, true);
  assert.strictEqual(retry.alreadyCanceled, true);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(retry, "cleanupFileID"),
    false
  );
  assert.strictEqual(state.deleteCalls, 1);

  const pending = await reserveUpload(main, database, "topic-image");
  const pendingCancel = await main({
    action: "cancelUpload",
    uploadId: pending.upload.id
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(pendingCancel, "cleanupFileID"),
    false
  );
}

async function testDirectAudioUsesDurableAttestedPath() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")],
    contents: [{
      _id: "content-one",
      contentId: "content-one",
      title: "已发布正文",
      currentRevision: `r-${"1".repeat(32)}`,
      audioRevision: "",
      pendingReviewCount: 0,
      status: "published",
      publishedAt: new Date("2026-07-20T00:00:00.000Z")
    }]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);

  try {
    setBrokerUrl(undefined);
    const created = await main(declaration("audio", {
      clientDurationSeconds: 42.5
    }));
    assertDirectUploadReservation(created, database, "audio");
    assert.strictEqual(created.uploadTransport.requiresClientManifest, false);
    const fileID =
      `cloud://test-environment/${created.uploadTransport.cloudPath}`;
    state.files.add(fileID);

    const confirmed = await main({
      action: "confirmUpload",
      uploadId: created.upload.id,
      fileID
    });
    assert.strictEqual(confirmed.success, true);
    assert.strictEqual(confirmed.requiresClientManifest, false);
    assert.strictEqual(confirmed.canCreateDraft, true);
    assert.strictEqual(confirmed.upload.canCreateDraft, true);
    assert.match(confirmed.warning, /未校验实际字节/);

    const upload = storedUpload(database, created.upload.id);
    assert.strictEqual(upload.status, "uploaded");
    assert.strictEqual(upload.validationStatus, "admin_attested_unverified");
    assert.strictEqual(upload.rawFileValidationStatus, "unverified");
    assert.strictEqual(upload.preparedFileID, fileID);
    assert.strictEqual(upload.preparedCloudPath, upload.cloudPath);
    assert.deepStrictEqual(
      {
        schemaVersion: upload.clientAttestedMetadata.schemaVersion,
        scope: upload.clientAttestedMetadata.scope,
        source: upload.clientAttestedMetadata.source,
        durationSeconds: upload.clientAttestedMetadata.durationSeconds,
        adminAccountId: upload.clientAttestedMetadata.adminAccountId
      },
      {
        schemaVersion: 1,
        scope: "client-measured-audio-duration",
        source: "wechat-client-media-metadata",
        durationSeconds: 42.5,
        adminAccountId: "admin-a"
      }
    );
    assert.deepStrictEqual(upload.directVerification, {
      exactReservedPath: true,
      objectExists: true,
      actualBytesVerified: false,
      sha256Verified: false,
      structureVerified: false
    });
    assert.strictEqual(
      upload.directAdminAttestation.scope,
      "exact-path-object-exists"
    );
    assert.strictEqual(
      upload.directAdminAttestation.adminAccountId,
      "admin-a"
    );
    assert.strictEqual(
      upload.directAdminAttestation.clientDurationSeconds,
      42.5
    );

    const replay = await main({
      action: "confirmUpload",
      uploadId: created.upload.id,
      fileID
    });
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.alreadyConfirmed, true);

    const createdDraft = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "direct-audio-draft-0001"
    });
    assert.strictEqual(createdDraft.success, true);
    const draft = database.store("adminContentDrafts").get(created.upload.id);
    assert.strictEqual(draft.preparedFileID, fileID);
    assert.strictEqual(draft.preparedCloudPath, upload.cloudPath);
    assert.strictEqual(draft.rawFileValidationStatus, "unverified");
    assert.strictEqual(draft.payload.durationSeconds, 42.5);
    assert.strictEqual(
      draft.sourceFingerprints[0].scope,
      "exact-path-object-exists-admin-attestation"
    );
    assert.strictEqual(draft.sourceFingerprints[0].rawFileVerified, false);

    const saved = await main({
      action: "saveDraft",
      draftId: created.upload.id,
      expectedDraftVersion: 1,
      requestId: "direct-audio-save-0001",
      patch: {
        title: "管理员试听录音",
        narrator: "测试配音员",
        bitrate: 128000
      }
    });
    assert.strictEqual(saved.success, true);
    const submitted = await main({
      action: "submitDraft",
      draftId: created.upload.id,
      expectedDraftVersion: saved.draft.draftVersion,
      requestId: "direct-audio-submit-0001"
    });
    assert.strictEqual(submitted.success, true);
    assert.strictEqual(submitted.draft.state, "in_review");

    const cancelCreated = await main(declaration("audio", {
      fileName: "待取消录音.m4a",
      mimeType: "audio/mp4"
    }));
    const cancelFileID =
      `cloud://test-environment/${cancelCreated.uploadTransport.cloudPath}`;
    state.files.add(cancelFileID);
    await main({
      action: "confirmUpload",
      uploadId: cancelCreated.upload.id,
      fileID: cancelFileID
    });
    const canceled = await main({
      action: "cancelUpload",
      uploadId: cancelCreated.upload.id
    });
    assert.strictEqual(canceled.success, true);
    assert.strictEqual(state.files.has(cancelFileID), true);
    const canceledCleanup = await main({
      action: "cleanupCanceledUpload",
      uploadId: cancelCreated.upload.id,
      requestId: "cleanup-direct-audio-0001"
    });
    assert.strictEqual(canceledCleanup.success, true);
    assert.strictEqual(state.files.has(cancelFileID), false);
  } finally {
    setBrokerUrl(VALID_BROKER_URL);
  }
}

async function testDirectFullBookUsesDurableAttestedPathAndPreview() {
  const database = new MemoryDatabase({
    adminAccounts: [adminAccount("admin-a", "admin-openid", "admin")],
    books: [{
      _id: "hospital-ship",
      bookId: "hospital-ship",
      title: "中国医院船",
      subtitle: "爱与真",
      status: "draft"
    }],
    contents: [{
      _id: "chapter-one",
      contentId: "chapter-one",
      bookId: "hospital-ship",
      title: "第一篇",
      currentRevision: `r-${"1".repeat(32)}`,
      sortOrder: 10,
      sections: [{
        kind: "story",
        heading: "",
        paragraphs: ["第一篇已发布正文。"]
      }],
      status: "published"
    }]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);

  try {
    setBrokerUrl(undefined);
    const created = await main(declaration("full-book-pdf"));
    assertDirectUploadReservation(
      created,
      database,
      "full-book-pdf"
    );
    assert.strictEqual(created.uploadTransport.maximumBytes, 50 * 1024 * 1024);
    assert.strictEqual(created.uploadTransport.requiresClientManifest, false);
    const fileID =
      `cloud://test-environment/${created.uploadTransport.cloudPath}`;
    state.files.add(fileID);

    const confirmed = await main({
      action: "confirmUpload",
      uploadId: created.upload.id,
      fileID
    });
    assert.strictEqual(confirmed.success, true);
    assert.strictEqual(confirmed.requiresClientManifest, false);
    assert.strictEqual(confirmed.canCreateDraft, true);
    assert.match(confirmed.warning, /整书 PDF/);
    const upload = storedUpload(database, created.upload.id);
    assert.strictEqual(upload.status, "uploaded");
    assert.strictEqual(upload.validationStatus, "admin_attested_unverified");
    assert.strictEqual(upload.rawFileValidationStatus, "unverified");
    assert.strictEqual(upload.preparedFileID, fileID);

    const createdDraft = await main({
      action: "createDraftFromUpload",
      uploadId: created.upload.id,
      requestId: "direct-pdf-draft-0001"
    });
    assert.strictEqual(createdDraft.success, true);
    assert.strictEqual(createdDraft.draft.payloadOmitted, true);
    const storedFullBookDraft = database
      .store("adminContentDrafts")
      .get(created.upload.id);
    assert.strictEqual(
      storedFullBookDraft.payload.structureMode,
      "from-published-contents"
    );
    assert.deepStrictEqual(storedFullBookDraft.payload.chapters, []);
    assert.strictEqual(storedFullBookDraft.payload.title, "中国医院船");
    assert.strictEqual(createdDraft.draft.issues.length, 0);

    const submitted = await main({
      action: "submitDraft",
      draftId: created.upload.id,
      expectedDraftVersion: createdDraft.draft.draftVersion,
      requestId: "direct-pdf-submit-0001"
    });
    assert.strictEqual(submitted.success, true);
    const preview = await main({
      action: "getDraftAssetPreview",
      draftId: created.upload.id,
      expectedSnapshotHash: submitted.draft.snapshotHash
    });
    assert.strictEqual(preview.success, true);
    assert.match(preview.previewUrl, /^https:\/\/temporary\.invalid\//);
  } finally {
    setBrokerUrl(VALID_BROKER_URL);
  }
}

async function testUploadTargetPickerIsPublishedAndMinimal() {
  const database = new MemoryDatabase({
    adminAccounts: [
      adminAccount("admin-a", "admin-openid", "admin"),
      adminAccount("reviewer-a", "reviewer-openid", "content-reviewer")
    ],
    contents: [{
      _id: "content-older",
      contentId: "content-older",
      title: "较早文章",
      subtitle: "较早副标题",
      status: "published",
      publishedAt: new Date("2026-07-20T00:00:00.000Z"),
      fileID: "cloud://must-not-leak/private"
    }, {
      _id: "content-newer",
      contentId: "content-newer",
      title: "最新文章",
      status: "published",
      publishedAt: new Date("2026-07-21T00:00:00.000Z"),
      embeddedAssets: [{ fileID: "cloud://must-not-leak/image" }]
    }, {
      _id: "content-draft",
      contentId: "content-draft",
      title: "未发布文章",
      status: "draft",
      publishedAt: new Date("2026-07-22T00:00:00.000Z")
    }],
    specialTopics: [{
      _id: "topic-one",
      topicId: "topic-one",
      title: "专题一",
      summary: "专题摘要",
      status: "published",
      publishedAt: new Date("2026-07-23T00:00:00.000Z"),
      previewCover: "cloud://must-not-leak/cover"
    }],
    books: [{
      _id: "china-hospital-ship",
      bookId: "china-hospital-ship",
      title: "中国医院船",
      subtitle: "爱与真",
      status: "draft",
      pdf: { fileID: "cloud://must-not-leak/book" }
    }, {
      _id: "other-book",
      bookId: "other-book",
      title: "另一部书",
      status: "published",
      publishedAt: new Date("2026-07-24T00:00:00.000Z")
    }]
  });
  const state = storageState();
  const main = loadAdminContentCenter(database, "admin-openid", state);
  const reviewer = loadAdminContentCenter(
    database,
    "reviewer-openid",
    state
  );

  const contents = await main({
    action: "listUploadTargets",
    targetType: "content",
    limit: 50
  });
  assert.strictEqual(contents.success, true);
  assert.deepStrictEqual(contents.targets, [{
    id: "content-newer",
    title: "最新文章"
  }, {
    id: "content-older",
    title: "较早文章",
    subtitle: "较早副标题"
  }]);
  assert.strictEqual(JSON.stringify(contents).includes("cloud://"), false);

  const topics = await main({
    action: "listUploadTargets",
    targetType: "special-topic"
  });
  assert.deepStrictEqual(topics.targets, [{
    id: "topic-one",
    title: "专题一",
    subtitle: "专题摘要"
  }]);
  assert.strictEqual(JSON.stringify(topics).includes("previewCover"), false);

  const books = await main({
    action: "listUploadTargets",
    targetType: "book"
  });
  assert.deepStrictEqual(books.targets, [{
    id: "china-hospital-ship",
    title: "中国医院船",
    subtitle: "爱与真"
  }, {
    id: "other-book",
    title: "另一部书"
  }]);
  assert.strictEqual(JSON.stringify(books).includes("cloud://"), false);
  const indexManifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "cloud-security/database-indexes.manifest.json"),
    "utf8"
  ));
  assert.strictEqual(
    indexManifest.indexes.some((index) =>
      index.collection === "books" &&
      JSON.stringify(index.fields) === JSON.stringify([
        { field: "status", mode: "asc" },
        { field: "publishedAt", mode: "desc" },
        { field: "_id", mode: "desc" }
      ])
    ),
    true,
    "整书目标查询必须登记对应复合索引"
  );
  const forbidden = await reviewer({
    action: "listUploadTargets",
    targetType: "content"
  });
  assert.strictEqual(forbidden.code, "UPLOAD_FORBIDDEN");
}

async function main() {
  const originalBrokerUrl = process.env[BROKER_ENV_KEY];

  try {
    setBrokerUrl(VALID_BROKER_URL);
    await testAuthorizationAndStatus();
    await testBrokerConfigurationFallsBackToPrivateDirectUpload();
    await testDeclarationValidationAndPrivateTargets();
    await testConfirmIsExactAndConcurrentIdempotent();
    await testMissingAndInvalidBrokerStateFailClosed();
    await testDirectConfirmationIsExactUnverifiedAndCancelable();
    await testResumeClientImagesAfterReloadAtFortyOfTwoHundred();
    await testRealScaleSpecialTopicDraftCreationIsBoundedAndIdempotent();
    await testDirectAudioUsesDurableAttestedPath();
    await testDirectFullBookUsesDurableAttestedPathAndPreview();
    await testUploadTargetPickerIsPublishedAndMinimal();
    await testAdminsAreIsolatedAndListsHideOpenid();
    await testCancelHidesCleanupFile();
    console.log(
      "管理员上传专项测试通过：HTTPS 中转优先、私有云存储直传回退、一次性 ticket、broker 深度校验、Word 清单与内嵌图片、直传录音人工确认、精确路径、目标选择、确认幂等、管理员隔离和取消清理均已覆盖。"
    );
  } finally {
    setBrokerUrl(originalBrokerUrl);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
