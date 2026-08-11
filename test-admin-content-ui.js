const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const adminContent = require("./miniprogram/utils/adminContent");
const DRAFT_ID = "a".repeat(32);
const SECOND_DRAFT_ID = "b".repeat(32);
const SNAPSHOT_ONE = "1".repeat(64);
const SNAPSHOT_TWO = "2".repeat(64);
const quietConsole = {
  error() {},
  log() {},
  warn() {}
};

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function settle(iterations = 6) {
  for (let index = 0; index < iterations; index += 1) {
    await flush();
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function roleCapabilities(overrides = {}) {
  return {
    upload: false,
    drafts: false,
    review: false,
    assetPreview: true,
    publish: false,
    transportMode: "disabled",
    ...overrides
  };
}

function manuscriptPayload(overrides = {}) {
  return {
    contentId: "article-one",
    bookId: "hospital-ship",
    title: "测试书稿",
    subtitle: "",
    sourceLabel: "编辑部",
    department: "胸外科",
    catalogViews: ["book"],
    sortOrder: 10,
    coverFileID: "",
    disclaimer: "",
    sections: [
      {
        kind: "story",
        heading: "开篇",
        paragraphs: ["正文第一段。"]
      }
    ],
    structureConfirmed: true,
    ...overrides
  };
}

function draftFixture(overrides = {}) {
  const state = overrides.state || "editing";
  const payload = overrides.payload || manuscriptPayload();
  return {
    id: overrides.id || DRAFT_ID,
    assetType: overrides.assetType || "manuscript",
    kind: overrides.kind || "content",
    targetId: overrides.targetId || "article-one",
    revision: overrides.revision || `r-${overrides.id || DRAFT_ID}`,
    basePublishedRevision:
      overrides.basePublishedRevision === undefined
        ? ""
        : overrides.basePublishedRevision,
    baseAssetRevision:
      overrides.baseAssetRevision === undefined ? "" : overrides.baseAssetRevision,
    draftVersion: overrides.draftVersion || 1,
    state,
    payload,
    issues: overrides.issues || [],
    inspection: overrides.inspection || {
      format: "docx",
      paragraphCount: 1,
      embeddedImageCount: 0,
      needsManualStructure: false
    },
    snapshotHash:
      overrides.snapshotHash === undefined
        ? state === "editing"
          ? ""
          : SNAPSHOT_ONE
        : overrides.snapshotHash,
    review:
      overrides.review === undefined
        ? state === "editing"
          ? null
          : {
              round: 1,
              decision: state === "approved" || state === "published" ? "approve" : "",
              note: "",
              submittedAt: "2026-07-19T00:00:00.000Z",
              reviewedAt:
                state === "approved" || state === "published"
                  ? "2026-07-19T00:05:00.000Z"
                  : null
            }
        : overrides.review,
    publication:
      overrides.publication || {
        status: state === "published" ? "published" : "not_started",
        publishedAt: state === "published" ? "2026-07-19T00:10:00.000Z" : null
      },
    createdAt: "2026-07-19T00:00:00.000Z",
    updateTime: "2026-07-19T00:00:00.000Z"
  };
}

function createAudioContext(calls) {
  const handlers = {};
  const context = {
    autoplay: false,
    destroyed: false,
    paused: true,
    played: false,
    src: "",
    stopped: false,
    destroy() {
      this.destroyed = true;
    },
    onEnded(handler) {
      handlers.ended = handler;
    },
    onError(handler) {
      handlers.error = handler;
    },
    onPause(handler) {
      handlers.pause = handler;
    },
    onPlay(handler) {
      handlers.play = handler;
    },
    pause() {
      this.paused = true;
      if (handlers.pause) handlers.pause();
    },
    play() {
      this.paused = false;
      this.played = true;
      if (handlers.play) handlers.play();
    },
    stop() {
      this.paused = true;
      this.stopped = true;
      if (handlers.pause) handlers.pause();
    }
  };
  calls.audioContexts.push(context);
  return context;
}

function createWx(options = {}) {
  const app = options.app || { globalData: {} };
  const calls = {
    audioContexts: [],
    cloud: [],
    downloadFile: [],
    modals: [],
    navigateTo: [],
    openDocument: [],
    previewImage: [],
    toasts: []
  };
  const wx = {
    cloud: {
      async callFunction(request) {
        calls.cloud.push(clone(request));
        if (options.callFunction) {
          return options.callFunction(request);
        }
        return { result: { success: true } };
      }
    },
    createInnerAudioContext() {
      return options.createInnerAudioContext
        ? options.createInnerAudioContext(calls)
        : createAudioContext(calls);
    },
    downloadFile(request) {
      calls.downloadFile.push({ url: request.url });
      if (options.downloadFile) {
        return options.downloadFile(request);
      }
      request.success({
        statusCode: 200,
        tempFilePath: "wxfile://admin-preview/document"
      });
      return { abort() {} };
    },
    navigateTo(request) {
      calls.navigateTo.push({ url: request.url });
      if (options.navigateTo) {
        return options.navigateTo(request);
      }
      if (request.success) request.success({});
    },
    openDocument(request) {
      calls.openDocument.push({
        filePath: request.filePath,
        showMenu: request.showMenu
      });
      if (options.openDocument) {
        return options.openDocument(request);
      }
      if (request.success) request.success({});
    },
    previewImage(request) {
      calls.previewImage.push({
        current: request.current,
        urls: Array.isArray(request.urls) ? request.urls.slice() : []
      });
      if (options.previewImage) {
        return options.previewImage(request);
      }
      if (request.success) request.success({});
    },
    showModal(request) {
      calls.modals.push({
        title: request.title,
        content: request.content,
        confirmText: request.confirmText
      });
      const modalResult = options.modalResult || { confirm: true, cancel: false };
      if (request.success) request.success(modalResult);
    },
    showToast(request) {
      calls.toasts.push(clone(request));
    }
  };

  return { app, calls, wx };
}

function loadPage(relativePath, wx, app = { globalData: {} }) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const localRequire = Module.createRequire(filename);
  let definition = null;
  const sandbox = {
    clearTimeout,
    console: quietConsole,
    getApp: () => app,
    getCurrentPages: () => [],
    Page(config) {
      definition = config;
    },
    require: localRequire,
    setTimeout,
    wx
  };

  vm.runInNewContext(source, sandbox, { filename });
  assert(definition, `${relativePath} did not call Page()`);
  const page = { ...definition };
  page.data = clone(definition.data || {});
  page.setData = function setData(update, callback) {
    Object.assign(this.data, update);
    if (typeof callback === "function") callback();
  };
  return page;
}

function actionCalls(harness, action) {
  return harness.calls.cloud.filter(
    (request) => request.data && request.data.action === action
  );
}

function assertMutationId(value) {
  assert.match(value, /^[A-Za-z0-9_-]{8,128}$/);
}

const tests = [];

function test(name, handler) {
  tests.push({ name, handler });
}

test("reviewer-only 门户只加载审核队列并隐藏上传与编辑能力", async () => {
  const reviewDraft = draftFixture({
    state: "in_review",
    snapshotHash: SNAPSHOT_ONE
  });
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["content-reviewer"],
            capabilities: roleCapabilities({ review: true })
          }
        };
      }
      if (action === "listReviewQueue") {
        assert.deepStrictEqual(clone(request.data), {
          action: "listReviewQueue",
          limit: 20,
          offset: 0
        });
        return {
          result: {
            success: true,
            drafts: [reviewDraft],
            hasMore: false,
            nextOffset: null
          }
        };
      }
      throw new Error(`reviewer-only portal called forbidden action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );

  page.onLoad();
  page.onShow();
  await settle();

  assert.strictEqual(page.data.authorized, true);
  assert.strictEqual(page.data.capabilities.review, true);
  assert.strictEqual(page.data.capabilities.upload, false);
  assert.strictEqual(page.data.capabilities.drafts, false);
  assert.strictEqual(page.data.capabilities.publish, false);
  assert.strictEqual(page.data.uploadAvailable, false);
  assert.strictEqual(page.data.uploads.length, 0);
  assert.strictEqual(page.data.drafts.length, 0);
  assert.strictEqual(page.data.reviewDrafts.length, 1);
  assert.strictEqual(actionCalls(harness, "listUploads").length, 0);
  assert.strictEqual(actionCalls(harness, "listDrafts").length, 0);
  assert.strictEqual(actionCalls(harness, "listReviewQueue").length, 1);

  page.openDraft({ currentTarget: { dataset: { draftId: DRAFT_ID } } });
  assert.deepStrictEqual(harness.calls.navigateTo, [
    { url: `/pages/adminDraft/adminDraft?id=${DRAFT_ID}` }
  ]);
});

test("uploader 创建草稿时仅发送任务编号并只携带草稿编号导航", async () => {
  const upload = {
    id: DRAFT_ID,
    originalFileName: "示范书稿.docx",
    assetType: "manuscript",
    relatedId: "article-one",
    status: "uploaded",
    reviewStatus: "not_submitted",
    validationStatus: "validated"
  };
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["uploader"],
            capabilities: roleCapabilities({
              upload: true,
              drafts: true,
              transportMode: "https-broker"
            })
          }
        };
      }
      if (action === "listUploads") {
        return {
          result: {
            success: true,
            uploads: [upload],
            hasMore: false,
            nextOffset: null
          }
        };
      }
      if (action === "listDrafts") {
        return {
          result: {
            success: true,
            drafts: [],
            hasMore: false,
            nextOffset: null
          }
        };
      }
      if (action === "createDraftFromUpload") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "requestId", "uploadId"]
        );
        assert.strictEqual(request.data.uploadId, DRAFT_ID);
        assertMutationId(request.data.requestId);
        assert.strictEqual(JSON.stringify(request.data).includes("cloud://"), false);
        assert.strictEqual(
          JSON.stringify(request.data).includes("admin-staging/"),
          false
        );
        return { result: { success: true, draft: draftFixture() } };
      }
      throw new Error(`unexpected uploader action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );

  page.onLoad();
  page.onShow();
  await settle();
  assert.strictEqual(page.data.uploads[0].canCreateDraft, true);

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(actionCalls(harness, "createDraftFromUpload").length, 1);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  const navigationUrl = harness.calls.navigateTo[0].url;
  assert.strictEqual(
    navigationUrl,
    `/pages/adminDraft/adminDraft?id=${DRAFT_ID}`
  );
  const query = navigationUrl.split("?")[1].split("&");
  assert.deepStrictEqual(query, [`id=${DRAFT_ID}`]);
});

test("创建草稿遇到临时云错误时复用同一 requestId 自动退避", async () => {
  let createAttempt = 0;
  const requestIds = [];
  const delays = [];
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.data.action, "createDraftFromUpload");
      createAttempt += 1;
      requestIds.push(request.data.requestId);
      if (createAttempt < 3) {
        return {
          result: {
            success: false,
            code: "ADMIN_CONTENT_CENTER_FAILED",
            message: "管理员内容服务暂不可用"
          }
        };
      }
      return { result: { success: true, draft: draftFixture() } };
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async (milliseconds) => {
    delays.push(milliseconds);
  };

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(createAttempt, 3);
  assert.strictEqual(new Set(requestIds).size, 1);
  assertMutationId(requestIds[0]);
  assert.deepStrictEqual(delays, [800, 1600]);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.strictEqual(page.data.historyError, "");
  assert.strictEqual(page.data.creatingDraftId, "");
});

test("创建草稿响应丢失时自动用草稿编号对账且不重复创建", async () => {
  const requestIds = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "createDraftFromUpload") {
        requestIds.push(request.data.requestId);
        throw new Error("opaque cloud invocation rejection");
      }
      if (action === "getDraft") {
        assert.deepStrictEqual(clone(request.data), {
          action: "getDraft",
          draftId: DRAFT_ID
        });
        return { result: { success: true, draft: draftFixture() } };
      }
      throw new Error(`unexpected draft reconciliation action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async () => {};

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(requestIds.length, 4);
  assert.strictEqual(new Set(requestIds).size, 1);
  assert.strictEqual(actionCalls(harness, "getDraft").length, 1);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.strictEqual(page.data.historyError, "");
  assert.strictEqual(page.draftMutationIds[DRAFT_ID], undefined);
});

test("创建草稿把 429、5xx 与连接重置按传输错误重试", async () => {
  let createAttempt = 0;
  const requestIds = [];
  const delays = [];
  const failures = [
    Object.assign(new Error("rate limited"), { statusCode: 429 }),
    Object.assign(new Error("upstream unavailable"), { status: 503 }),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
  ];
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.data.action, "createDraftFromUpload");
      requestIds.push(request.data.requestId);
      if (createAttempt < failures.length) {
        const failure = failures[createAttempt];
        createAttempt += 1;
        throw failure;
      }
      createAttempt += 1;
      return { result: { success: true, draft: draftFixture() } };
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async (milliseconds) => {
    delays.push(milliseconds);
  };

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(createAttempt, 4);
  assert.strictEqual(new Set(requestIds).size, 1);
  assert.deepStrictEqual(delays, [800, 1600, 3200]);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.strictEqual(page.data.historyError, "");
});

test("离开页面会终止草稿对账并恢复创建按钮且不会延迟跳转", async () => {
  const reconciliation = deferred();
  const reconciliationStarted = deferred();
  const requestIds = [];
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "createDraftFromUpload") {
        requestIds.push(request.data.requestId);
        throw new Error("opaque transport rejection");
      }
      if (request.data.action === "getDraft") {
        reconciliationStarted.resolve();
        return reconciliation.promise;
      }
      throw new Error(`unexpected hidden-page action ${request.data.action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async () => {};

  const creation = page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });
  await reconciliationStarted.promise;
  const activeOperationId = page.draftOperationId;
  assert.strictEqual(page.data.creatingDraftId, DRAFT_ID);

  page.onHide();
  assert.strictEqual(page.draftOperationId, activeOperationId + 1);
  assert.strictEqual(page.data.creatingDraftId, "");
  reconciliation.resolve({
    result: { success: true, draft: draftFixture() }
  });
  await creation;

  assert.strictEqual(requestIds.length, 4);
  assert.strictEqual(new Set(requestIds).size, 1);
  assert.strictEqual(harness.calls.navigateTo.length, 0);
  assertMutationId(page.draftMutationIds[DRAFT_ID]);
});

test("草稿创建成功但页面跳转失败时保留可重试入口并提示原因", async () => {
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.data.action, "createDraftFromUpload");
      return { result: { success: true, draft: draftFixture() } };
    },
    navigateTo(request) {
      request.fail({ errMsg: "navigateTo:fail page not found" });
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({
    capabilities: roleCapabilities({ drafts: true }),
    uploads: [{
      uploadId: DRAFT_ID,
      canCreateDraft: true,
      canCancel: true,
      hasDraft: false
    }]
  });

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.strictEqual(
    page.data.historyError,
    "草稿已创建，但页面打开失败，请点击“打开草稿”重试。"
  );
  assert.strictEqual(page.data.uploads[0].hasDraft, true);
  assert.strictEqual(page.data.uploads[0].canCancel, false);
  assert.strictEqual(page.data.creatingDraftId, "");
  assert.strictEqual(page.draftMutationIds[DRAFT_ID], undefined);
});

test("创建结果仍未知时保留 requestId 供再次点击继续核对", async () => {
  let createAttempt = 0;
  const requestIds = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "createDraftFromUpload") {
        createAttempt += 1;
        requestIds.push(request.data.requestId);
        if (createAttempt <= 4) {
          return {
            result: {
              success: false,
              code: "ADMIN_CONTENT_CENTER_FAILED",
              message: "管理员内容服务暂不可用"
            }
          };
        }
        return { result: { success: true, draft: draftFixture() } };
      }
      if (action === "getDraft") {
        return {
          result: {
            success: false,
            code: "DRAFT_NOT_FOUND",
            message: "内容草稿不存在"
          }
        };
      }
      throw new Error(`unexpected unknown-result action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async () => {};
  const event = {
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  };

  await page.createOrOpenDraft(event);
  assert.strictEqual(createAttempt, 4);
  assert.match(page.data.historyError, /已保留本次请求/);
  const preservedRequestId = page.draftMutationIds[DRAFT_ID];
  assertMutationId(preservedRequestId);

  await page.createOrOpenDraft(event);
  assert.strictEqual(createAttempt, 5);
  assert.strictEqual(requestIds.every((id) => id === preservedRequestId), true);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.strictEqual(page.draftMutationIds[DRAFT_ID], undefined);
});

test("创建草稿业务校验失败不重试并显示服务端原因", async () => {
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.data.action, "createDraftFromUpload");
      return {
        result: {
          success: false,
          code: "SOURCE_UPLOAD_IMAGES_REQUIRED",
          message: "Word 正文中的内嵌图片尚未上传并确认，不能创建草稿"
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  page.onLoad();
  page.isPageVisible = true;
  page.setData({ capabilities: roleCapabilities({ drafts: true }) });
  page.waitForClientImageDelay = async () => {
    throw new Error("business error must not retry");
  };

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  assert.strictEqual(actionCalls(harness, "createDraftFromUpload").length, 1);
  assert.strictEqual(actionCalls(harness, "getDraft").length, 0);
  assert.strictEqual(
    page.data.historyError,
    "Word 正文中的内嵌图片尚未上传并确认，不能创建草稿"
  );
  assert.strictEqual(page.draftMutationIds[DRAFT_ID], undefined);
});

test("Word 图片批次确认对临时服务错误复用 requestId 自动退避", async () => {
  const callsByBatch = new Map();
  const delays = [];
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.data.action, "confirmClientImages");
      const key = request.data.requestId;
      callsByBatch.set(key, (callsByBatch.get(key) || 0) + 1);
      if (
        key === "confirm-images-first" &&
        callsByBatch.get(key) < 3
      ) {
        return {
          result: {
            success: false,
            code: "ADMIN_CONTENT_CENTER_FAILED",
            message: "管理员内容服务暂不可用"
          }
        };
      }
      const finalBatch = key === "confirm-images-second";
      return {
        result: {
          success: true,
          complete: finalBatch,
          requiresClientImages: !finalBatch,
          canCreateDraft: finalBatch,
          upload: {
            id: DRAFT_ID,
            status: finalBatch ? "uploaded" : "uploaded_unverified",
            validationStatus: finalBatch
              ? "client_manifest_validated"
              : "awaiting_client_images",
            requiresClientImages: !finalBatch,
            canCreateDraft: finalBatch
          }
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );
  const imageFiles = [
    { imageOrder: 1, fileID: "cloud://test/one.png" },
    { imageOrder: 2, fileID: "cloud://test/two.png" }
  ];
  const ticket = {
    uploadId: DRAFT_ID,
    mode: "cloud-storage-direct",
    imageUploadPlan: [
      { imageOrder: 1 },
      { imageOrder: 2 }
    ],
    imageFiles,
    imageConfirmationState: [
      {
        confirmed: false,
        files: [imageFiles[0]],
        requestId: "confirm-images-first"
      },
      {
        confirmed: false,
        files: [imageFiles[1]],
        requestId: "confirm-images-second"
      }
    ]
  };

  page.onLoad();
  page.isPageVisible = true;
  page.uploadOperationId = 7;
  page.retryStage = "image-confirm";
  page.pendingUploadTicket = ticket;
  page.waitForClientImageDelay = async (milliseconds) => {
    delays.push(milliseconds);
  };
  const result = await page.transferAndConfirmClientImages(
    ticket,
    { images: [] },
    {
      success: true,
      upload: {
        id: DRAFT_ID,
        status: "uploaded_unverified",
        validationStatus: "awaiting_client_images",
        requiresClientImages: true
      }
    },
    7
  );

  assert.strictEqual(result.complete, true);
  assert.deepStrictEqual(Array.from(callsByBatch.entries()), [
    ["confirm-images-first", 3],
    ["confirm-images-second", 1]
  ]);
  assert.deepStrictEqual(delays, [800, 1600, 500]);
  assert.strictEqual(ticket.imageConfirmationState[0].confirmed, true);
  assert.strictEqual(ticket.imageConfirmationState[1].confirmed, true);
});

test("历史上传显示图片进度并从服务端循环继续确认", async () => {
  let history = [{
    uploadId: DRAFT_ID,
    fileName: "两百图专题.docx",
    assetType: "special-topic",
    status: "uploaded_unverified",
    validationStatus: "awaiting_client_images",
    clientImageCount: 60,
    confirmedClientImageCount: 20,
    remainingClientImageCount: 40
  }];
  let resumeAttempt = 0;
  const delays = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "listUploads") {
        return {
          result: {
            success: true,
            uploads: history,
            hasMore: false
          }
        };
      }
      if (action === "resumeClientImages") {
        resumeAttempt += 1;
        if (resumeAttempt === 1) {
          return {
            result: {
              success: false,
              code: "ADMIN_CONTENT_CENTER_FAILED",
              message: "管理员内容服务暂不可用"
            }
          };
        }
        if (resumeAttempt === 2) {
          history = [{
            ...history[0],
            confirmedClientImageCount: 40,
            remainingClientImageCount: 20
          }];
          return {
            result: {
              success: true,
              complete: false,
              totalCount: 60,
              confirmedCount: 40,
              remainingCount: 20,
              upload: {
                id: DRAFT_ID,
                status: "uploaded_unverified",
                validationStatus: "awaiting_client_images"
              }
            }
          };
        }
        history = [{
          ...history[0],
          status: "uploaded",
          validationStatus: "client_manifest_validated",
          confirmedClientImageCount: 60,
          remainingClientImageCount: 0
        }];
        return {
          result: {
            success: true,
            complete: true,
            canCreateDraft: true,
            totalCount: 60,
            confirmedCount: 60,
            remainingCount: 0,
            upload: {
              id: DRAFT_ID,
              status: "uploaded",
              validationStatus: "client_manifest_validated",
              canCreateDraft: true
            }
          }
        };
      }
      throw new Error(`unexpected history resume action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );

  page.onLoad();
  page.isPageVisible = true;
  page.setData({
    authorized: true,
    capabilities: roleCapabilities({ drafts: true })
  });
  page.waitForClientImageDelay = async (milliseconds) => {
    delays.push(milliseconds);
  };
  await page.loadHistory();
  assert.strictEqual(page.data.uploads[0].clientImageCount, 60);
  assert.strictEqual(page.data.uploads[0].confirmedClientImageCount, 20);
  assert.strictEqual(page.data.uploads[0].remainingClientImageCount, 40);
  assert.strictEqual(
    page.data.uploads[0].clientImageProgressLabel,
    "图片确认 20/60，还剩 40 张"
  );
  assert.strictEqual(page.data.uploads[0].canResumeClientImages, true);

  await page.resumeClientImages({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });

  const resumeCalls = actionCalls(harness, "resumeClientImages");
  assert.strictEqual(resumeCalls.length, 3);
  assert.strictEqual(
    resumeCalls[0].data.requestId,
    resumeCalls[1].data.requestId
  );
  assert.notStrictEqual(
    resumeCalls[1].data.requestId,
    resumeCalls[2].data.requestId
  );
  assert.deepStrictEqual(delays, [800, 500]);
  assert.strictEqual(page.data.uploads[0].canResumeClientImages, false);
  assert.strictEqual(page.data.uploads[0].canCreateDraft, true);
  assert.strictEqual(page.data.resumingClientImagesId, "");

  const wxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminUploads/adminUploads.wxml"),
    "utf8"
  );
  assert(wxml.includes("{{item.clientImageProgressLabel}}"));
  assert(wxml.includes('bindtap="resumeClientImages"'));
  assert(wxml.includes("继续确认图片"));
});

test("取消响应含糊时刷新对账，已取消任务不要求再次点击", async () => {
  let history = [{
    uploadId: DRAFT_ID,
    fileName: "待取消专题.docx",
    assetType: "special-topic",
    status: "uploaded_unverified",
    validationStatus: "awaiting_client_images",
    clientImageCount: 200,
    confirmedClientImageCount: 40,
    remainingClientImageCount: 160
  }];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "listUploads") {
        return { result: { success: true, uploads: history } };
      }
      if (action === "cancelUpload") {
        history = [{
          ...history[0],
          status: "canceled",
          cleanupRequired: true,
          cleanupRemainingCount: 2
        }];
        return {
          result: {
            success: false,
            code: "ADMIN_CONTENT_CENTER_FAILED",
            message: "管理员内容服务暂不可用"
          }
        };
      }
      if (action === "cleanupCanceledUpload") {
        history = [{
          ...history[0],
          cleanupRequired: false,
          cleanupRemainingCount: 0
        }];
        return {
          result: {
            success: true,
            complete: true,
            cleanupRequired: false,
            cleanupRemainingCount: 0,
            upload: history[0]
          }
        };
      }
      throw new Error(`unexpected cancel action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminUploads/adminUploads.js",
    harness.wx
  );

  page.onLoad();
  page.isPageVisible = true;
  page.setData({
    authorized: true,
    capabilities: roleCapabilities({ drafts: true })
  });
  page.waitForClientImageDelay = async () => {};
  await page.loadHistory();
  await page.cancelUpload({
    currentTarget: { dataset: { uploadId: DRAFT_ID } }
  });
  await settle();

  assert.strictEqual(actionCalls(harness, "cancelUpload").length, 1);
  assert.strictEqual(actionCalls(harness, "cleanupCanceledUpload").length, 1);
  assert.strictEqual(page.data.historyError, "");
  assert.strictEqual(page.data.uploads[0].status, "canceled");
  assert.strictEqual(page.data.uploads[0].canResumeClientImages, false);
  assert.strictEqual(page.data.uploads[0].cleanupRequired, false);
  assert.strictEqual(page.data.cancelingUploadId, "");
});

test("离开图片确认页保留云端任务，早期任务和明确取消仍会释放", async () => {
  const resumableId = "c".repeat(32);
  const earlyId = "d".repeat(32);
  const explicitId = "e".repeat(32);
  const harness = createWx();
  const makePage = (uploadId, retryStage, explicit = false) => {
    const page = loadPage(
      "miniprogram/pages/adminUploads/adminUploads.js",
      harness.wx
    );
    page.onLoad();
    page.isPageVisible = true;
    page.pendingUploadTicket = {
      uploadId,
      manifestResult: retryStage === "images" ? { success: true } : null
    };
    page.retryStage = retryStage;
    page.setData({ uploading: true });
    if (explicit) {
      page.cancelActiveUpload();
    } else {
      page.onHide();
    }
  };

  makePage(resumableId, "images");
  makePage(earlyId, "upload");
  makePage(explicitId, "image-confirm", true);
  await settle();

  assert.deepStrictEqual(
    actionCalls(harness, "cancelUpload").map(
      (request) => request.data.uploadId
    ),
    [earlyId, explicitId]
  );
});

test("管理员保存当前版本后使用服务端新版本送审", async () => {
  let currentDraft = draftFixture();
  let savedPatch = null;
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["admin"],
            capabilities: roleCapabilities({
              upload: true,
              drafts: true,
              review: true,
              publish: true,
              transportMode: "https-broker"
            })
          }
        };
      }
      if (action === "getDraft") {
        assert.deepStrictEqual(clone(request.data), {
          action: "getDraft",
          draftId: DRAFT_ID
        });
        return { result: { success: true, draft: currentDraft } };
      }
      if (action === "saveDraft") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "draftId", "expectedDraftVersion", "patch", "requestId"]
        );
        assert.strictEqual(request.data.draftId, DRAFT_ID);
        assert.strictEqual(request.data.expectedDraftVersion, 1);
        assertMutationId(request.data.requestId);
        savedPatch = clone(request.data.patch);
        currentDraft = draftFixture({
          draftVersion: 2,
          payload: { contentId: "article-one", ...savedPatch }
        });
        return { result: { success: true, draft: currentDraft } };
      }
      if (action === "submitDraft") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "draftId", "expectedDraftVersion", "requestId"]
        );
        assert.strictEqual(request.data.draftId, DRAFT_ID);
        assert.strictEqual(request.data.expectedDraftVersion, 2);
        assertMutationId(request.data.requestId);
        currentDraft = draftFixture({
          state: "in_review",
          draftVersion: 3,
          snapshotHash: SNAPSHOT_ONE,
          payload: { contentId: "article-one", ...savedPatch }
        });
        return { result: { success: true, draft: currentDraft } };
      }
      throw new Error(`unexpected admin editor action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx
  );

  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settle();
  assert.strictEqual(page.data.draft.draftVersion, 1);

  page.onFieldInput({
    currentTarget: { dataset: { field: "title" } },
    detail: { value: "管理员校对后的标题" }
  });
  await page.saveDraft();
  assert.strictEqual(savedPatch.title, "管理员校对后的标题");
  assert.strictEqual(page.data.draft.draftVersion, 2);

  await page.submitDraft();
  assert.strictEqual(page.data.draft.state, "in_review");
  assert.strictEqual(page.data.draft.draftVersion, 3);
  assert.strictEqual(page.data.draft.snapshotHash, SNAPSHOT_ONE);
  assert.strictEqual(actionCalls(harness, "saveDraft").length, 1);
  assert.strictEqual(actionCalls(harness, "submitDraft").length, 1);
  assert.strictEqual(harness.calls.modals.length, 1);
});

test("草稿有未保存修改时预览会先自动保存当前表单", async () => {
  const topicPayload = {
    topicId: "solar-system",
    title: "太阳系的物体",
    summary: "",
    producer: "清华大学-皮家齐",
    unlockCostStars: 0,
    entries: [{
      sortOrder: 10,
      blocks: [{ type: "text", text: "专题正文" }]
    }],
    structureConfirmed: true
  };
  let currentDraft = draftFixture({
    assetType: "special-topic",
    targetId: "solar-system",
    payload: topicPayload,
    inspection: {
      format: "docx-client-manifest",
      paragraphCount: 1,
      embeddedImageCount: 0,
      needsManualStructure: false
    }
  });
  const actions = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      actions.push(action);
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["admin"],
            capabilities: roleCapabilities({ drafts: true })
          }
        };
      }
      if (action === "getDraft") {
        return { result: { success: true, draft: currentDraft } };
      }
      if (action === "saveDraft") {
        assert.strictEqual(request.data.patch.unlockCostStars, 1);
        currentDraft = draftFixture({
          assetType: "special-topic",
          targetId: "solar-system",
          draftVersion: 2,
          payload: { ...topicPayload, ...request.data.patch },
          inspection: currentDraft.inspection
        });
        return { result: { success: true, draft: currentDraft } };
      }
      if (action === "getDraftAssetPreview") {
        assert.strictEqual(currentDraft.payload.unlockCostStars, 1);
        return {
          result: {
            success: true,
            assetType: "special-topic",
            previewKind: "structured",
            snapshotHash: ""
          }
        };
      }
      throw new Error(`unexpected auto-save preview action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx,
    harness.app
  );

  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settle();
  page.onFieldInput({
    currentTarget: { dataset: { field: "unlockCostStars" } },
    detail: { value: "1" }
  });
  assert.strictEqual(page.data.formDirty, true);

  await page.previewAsset();

  assert.deepStrictEqual(actions.slice(-2), [
    "saveDraft",
    "getDraftAssetPreview"
  ]);
  assert.strictEqual(page.data.formDirty, false);
  assert.strictEqual(page.data.draft.draftVersion, 2);
  assert.strictEqual(page.data.draft.payload.unlockCostStars, 1);
  assert.strictEqual(page.data.pageError, "");
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.match(
    harness.calls.navigateTo[0].url,
    /^\/pages\/adminPreview\/adminPreview\?token=[A-Za-z0-9_-]+$/
  );
  const cache = harness.app.globalData.adminDraftPreview;
  assert(cache, "自动保存后的结构化预览应写入稳定缓存");
  assert.strictEqual(cache.draftId, DRAFT_ID);
  assert.strictEqual(cache.assetType, "special-topic");
  assert.strictEqual(cache.payload.unlockCostStars, 1);
  assert.deepStrictEqual(clone(cache.payload), currentDraft.payload);
});

test("审核批准必须先预览完全相同的快照", async () => {
  let currentSnapshot = SNAPSHOT_ONE;
  const reviewRequests = [];
  const previewRequests = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["content-reviewer"],
            capabilities: roleCapabilities({ review: true })
          }
        };
      }
      if (action === "getDraft") {
        return {
          result: {
            success: true,
            draft: draftFixture({
              state: "in_review",
              draftVersion: 3,
              snapshotHash: currentSnapshot
            })
          }
        };
      }
      if (action === "getDraftAssetPreview") {
        previewRequests.push(clone(request.data));
        assert.deepStrictEqual(Object.keys(request.data).sort(), [
          "action",
          "draftId",
          "expectedSnapshotHash"
        ]);
        assert.strictEqual(request.data.draftId, DRAFT_ID);
        assert.strictEqual(request.data.expectedSnapshotHash, currentSnapshot);
        return {
          result: {
            success: true,
            snapshotHash: currentSnapshot,
            previewUrl: `https://temporary.invalid/${currentSnapshot}.docx`
          }
        };
      }
      if (action === "reviewDraft") {
        reviewRequests.push(clone(request.data));
        assert.deepStrictEqual(Object.keys(request.data).sort(), [
          "action",
          "decision",
          "draftId",
          "expectedSnapshotHash",
          "note",
          "requestId"
        ]);
        assert.strictEqual(request.data.decision, "approve");
        assert.strictEqual(request.data.expectedSnapshotHash, currentSnapshot);
        assertMutationId(request.data.requestId);
        return {
          result: {
            success: true,
            draft: draftFixture({
              state: "approved",
              draftVersion: 4,
              snapshotHash: currentSnapshot
            })
          }
        };
      }
      throw new Error(`unexpected reviewer action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx
  );

  page.onLoad({ draftId: DRAFT_ID });
  page.onShow();
  await settle();

  await page.reviewDraft({
    currentTarget: { dataset: { decision: "approve" } }
  });
  assert.strictEqual(reviewRequests.length, 0);
  assert.match(page.data.pageError, /预览|原件/);

  await page.previewAsset();
  assert.strictEqual(previewRequests.length, 1);
  assert.strictEqual(page.data.previewedSnapshotHash, SNAPSHOT_ONE);
  assert.deepStrictEqual(harness.calls.downloadFile, [
    { url: `https://temporary.invalid/${SNAPSHOT_ONE}.docx` }
  ]);
  assert.deepStrictEqual(harness.calls.openDocument, [
    {
      filePath: "wxfile://admin-preview/document",
      showMenu: false
    }
  ]);
  assert.strictEqual(
    JSON.stringify(page.data).includes("temporary.invalid"),
    false,
    "临时预览 URL 不得写入页面 data"
  );

  currentSnapshot = SNAPSHOT_TWO;
  page.applyDraft(
    adminContent.normalizeDraft(
      draftFixture({
        state: "in_review",
        draftVersion: 4,
        snapshotHash: SNAPSHOT_TWO
      })
    ),
    page.data.capabilities
  );
  assert.strictEqual(page.data.previewedSnapshotHash, "");
  await page.reviewDraft({
    currentTarget: { dataset: { decision: "approve" } }
  });
  assert.strictEqual(reviewRequests.length, 0);

  await page.previewAsset();
  assert.strictEqual(page.data.previewedSnapshotHash, SNAPSHOT_TWO);
  await page.reviewDraft({
    currentTarget: { dataset: { decision: "approve" } }
  });
  assert.strictEqual(reviewRequests.length, 1);
  assert.strictEqual(
    reviewRequests[0].expectedSnapshotHash,
    SNAPSHOT_TWO
  );
  assert.strictEqual(page.data.draft.state, "approved");

  await page.openPreview(
    "https://temporary.invalid/topic-image.png",
    "topic-image"
  );
  assert.deepStrictEqual(clone(harness.calls.previewImage), [
    {
      current: "https://temporary.invalid/topic-image.png",
      urls: ["https://temporary.invalid/topic-image.png"]
    }
  ]);

  await page.openPreview("https://temporary.invalid/audio.mp3", "audio");
  assert.strictEqual(harness.calls.audioContexts.length, 1);
  const audio = harness.calls.audioContexts[0];
  assert.strictEqual(audio.src, "https://temporary.invalid/audio.mp3");
  assert.strictEqual(audio.played, true);
  page.destroyAudioPreview();
  assert.strictEqual(audio.destroyed, true);
});

test("本地解析的 Word 草稿使用结构化预览且不再打开原文件", async () => {
  const cases = [
    {
      id: DRAFT_ID,
      assetType: "manuscript",
      targetId: "article-one",
      payload: manuscriptPayload()
    },
    {
      id: SECOND_DRAFT_ID,
      assetType: "special-topic",
      targetId: "hospital-ship-story",
      payload: {
        topicId: "hospital-ship-story",
        title: "医院船故事",
        summary: "",
        producer: "",
        unlockCostStars: 10,
        entries: [{
          sortOrder: 10,
          blocks: [{ type: "text", text: "专题正文" }]
        }],
        structureConfirmed: true
      }
    }
  ];

  for (const item of cases) {
    const draft = draftFixture({
      id: item.id,
      assetType: item.assetType,
      targetId: item.targetId,
      state: "in_review",
      draftVersion: 3,
      snapshotHash: SNAPSHOT_ONE,
      payload: item.payload,
      inspection: {
        format: "docx-client-manifest",
        paragraphCount: 1,
        embeddedImageCount: 0,
        needsManualStructure: true
      }
    });
    const reviewRequests = [];
    const harness = createWx({
      async callFunction(request) {
        const action = request.data.action;
        if (action === "status") {
          return {
            result: {
              success: true,
              authorized: true,
              roles: ["content-reviewer"],
              capabilities: roleCapabilities({ review: true })
            }
          };
        }
        if (action === "getDraft") {
          return { result: { success: true, draft } };
        }
        if (action === "getDraftAssetPreview") {
          return {
            result: {
              success: true,
              assetType: item.assetType,
              previewKind: "structured",
              snapshotHash: SNAPSHOT_ONE,
              sourceMode: "client-manifest-only"
            }
          };
        }
        if (action === "reviewDraft") {
          reviewRequests.push(clone(request.data));
          return {
            result: {
              success: true,
              draft: draftFixture({
                ...item,
                state: "approved",
                draftVersion: 4,
                snapshotHash: SNAPSHOT_ONE,
                inspection: draft.inspection
              })
            }
          };
        }
        throw new Error(`unexpected structured preview action ${action}`);
      }
    });
    const page = loadPage(
      "miniprogram/pages/adminDraft/adminDraft.js",
      harness.wx,
      harness.app
    );

    page.onLoad({ draftId: item.id });
    page.onShow();
    await settle();
    assert.strictEqual(page.data.draft.usesStructuredPreview, true);

    await page.previewAsset();
    assert.strictEqual(page.data.previewedSnapshotHash, SNAPSHOT_ONE);
    assert.strictEqual(harness.calls.downloadFile.length, 0);
    assert.strictEqual(harness.calls.openDocument.length, 0);
    assert.strictEqual(harness.calls.navigateTo.length, 1);
    assert.match(
      harness.calls.navigateTo[0].url,
      /^\/pages\/adminPreview\/adminPreview\?token=[A-Za-z0-9_-]+$/
    );
    const cache = harness.app.globalData.adminDraftPreview;
    assert(cache, `${item.assetType} 结构化预览应写入稳定缓存`);
    assert.strictEqual(cache.draftId, item.id);
    assert.strictEqual(cache.assetType, item.assetType);
    assert.strictEqual(cache.snapshotHash, SNAPSHOT_ONE);
    assert.strictEqual(cache.sourceMode, "client-manifest-only");
    assert.deepStrictEqual(clone(cache.payload), item.payload);

    await page.reviewDraft({
      currentTarget: { dataset: { decision: "approve" } }
    });
    assert.strictEqual(reviewRequests.length, 1);
    assert.strictEqual(reviewRequests[0].expectedSnapshotHash, SNAPSHOT_ONE);
  }
});

test("管理员结构化预览从稳定缓存读取且目录切换不调用云函数", async () => {
  const token = "preview-token-manuscript-0001";
  const cache = {
    token,
    draftId: DRAFT_ID,
    assetType: "manuscript",
    targetId: "article-one",
    snapshotHash: SNAPSHOT_ONE,
    sourceMode: "client-manifest-only",
    createdAt: Date.now(),
    payload: manuscriptPayload({
      title: "只读发布效果",
      sections: [
        {
          kind: "story",
          heading: "第一节",
          paragraphs: ["第一节正文。"]
        },
        {
          kind: "story",
          heading: "第二节",
          paragraphs: ["第二节正文。"]
        }
      ]
    })
  };
  const app = { globalData: { adminDraftPreview: cache } };
  const harness = createWx({
    app,
    async callFunction(request) {
      throw new Error(
        `只读预览不应调用云函数：${request && request.data && request.data.action}`
      );
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminPreview/adminPreview.js",
    harness.wx,
    app
  );

  page.onLoad({ token: encodeURIComponent(token) });
  assert.strictEqual(page.data.ready, true);
  assert.strictEqual(page.data.errorMessage, "");
  assert.strictEqual(page.data.title, "只读发布效果");
  assert.strictEqual(page.data.directory.length, 2);
  assert.strictEqual(page.data.selectedIndex, 0);
  assert.strictEqual(page.data.selectedTitle, "第一节");
  assert.deepStrictEqual(
    clone(page.data.contentBlocks.map((block) => block.text)),
    ["第一节正文。"]
  );
  assert.strictEqual(harness.calls.cloud.length, 0);

  page.selectPart({ currentTarget: { dataset: { index: 1 } } });
  assert.strictEqual(page.data.selectedIndex, 1);
  assert.strictEqual(page.data.selectedTitle, "第二节");
  assert.strictEqual(page.data.selectedCounter, "2 / 2");
  assert.deepStrictEqual(
    clone(page.data.contentBlocks.map((block) => block.text)),
    ["第二节正文。"]
  );
  assert.strictEqual(harness.calls.cloud.length, 0);

  const replacement = {
    ...cache,
    token: "preview-token-replacement-0002",
    createdAt: Date.now()
  };
  app.globalData.adminDraftPreview = replacement;
  page.onUnload();
  assert.strictEqual(
    app.globalData.adminDraftPreview,
    replacement,
    "卸载旧预览页不得删除后来写入的其他 token 缓存"
  );

  const replacementPage = loadPage(
    "miniprogram/pages/adminPreview/adminPreview.js",
    harness.wx,
    app
  );
  replacementPage.onLoad({ token: encodeURIComponent(replacement.token) });
  assert.strictEqual(replacementPage.data.ready, true);
  replacementPage.onUnload();
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      app.globalData,
      "adminDraftPreview"
    ),
    false,
    "卸载当前 token 的预览页应清除自己的缓存"
  );
  assert.strictEqual(harness.calls.cloud.length, 0);
});

test("管理员发布严格携带审核快照与目标基线版本", async () => {
  const approvedDraft = draftFixture({
    state: "approved",
    draftVersion: 4,
    snapshotHash: SNAPSHOT_ONE,
    basePublishedRevision: "r-previous-publication"
  });
  let publishRequest = null;
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["admin"],
            capabilities: roleCapabilities({
              upload: true,
              drafts: true,
              review: true,
              publish: true,
              transportMode: "https-broker"
            })
          }
        };
      }
      if (action === "getDraft") {
        return { result: { success: true, draft: approvedDraft } };
      }
      if (action === "publishDraft") {
        publishRequest = clone(request.data);
        return {
          result: {
            success: true,
            draft: draftFixture({
              state: "published",
              draftVersion: 5,
              snapshotHash: SNAPSHOT_ONE,
              basePublishedRevision: "r-previous-publication"
            })
          }
        };
      }
      throw new Error(`unexpected publisher action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx
  );

  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settle();
  await page.publishDraft();

  assert(publishRequest);
  assert.deepStrictEqual(Object.keys(publishRequest).sort(), [
    "action",
    "draftId",
    "expectedSnapshotHash",
    "expectedTargetRevision",
    "requestId"
  ]);
  assert.strictEqual(publishRequest.action, "publishDraft");
  assert.strictEqual(publishRequest.draftId, DRAFT_ID);
  assert.strictEqual(publishRequest.expectedSnapshotHash, SNAPSHOT_ONE);
  assert.strictEqual(
    publishRequest.expectedTargetRevision,
    "r-previous-publication"
  );
  assertMutationId(publishRequest.requestId);
  assert.strictEqual(page.data.draft.state, "published");
});

test("管理员大型专题发布复用请求编号并轮询至精简终态", async () => {
  const topicPayload = {
    topicId: "topic-heavy",
    title: "大型专题",
    summary: "大型专题摘要",
    producer: "编辑部",
    unlockCostStars: 5,
    sortOrder: 10,
    previewCoverFileID: "",
    entries: [
      {
        sortOrder: 10,
        blocks: [{ type: "text", text: "正文" }]
      }
    ],
    structureConfirmed: true
  };
  const approvedDraft = draftFixture({
    state: "approved",
    draftVersion: 5,
    snapshotHash: SNAPSHOT_ONE,
    assetType: "special-topic",
    kind: "topic",
    targetId: "topic-heavy",
    payload: topicPayload
  });
  const slimPublishedDraft = draftFixture({
    state: "published",
    draftVersion: 6,
    snapshotHash: SNAPSHOT_ONE,
    assetType: "special-topic",
    kind: "topic",
    targetId: "topic-heavy",
    payload: topicPayload
  });
  delete slimPublishedDraft.payload;

  const pendingResults = [
    {
      success: true,
      pending: true,
      phase: "verifying-assets",
      processed: 50,
      total: 200,
      message: "validating assets"
    },
    {
      success: true,
      pending: true,
      phase: "verifying-assets",
      processed: 200,
      total: 200,
      message: "assets validated"
    },
    {
      success: true,
      pending: true,
      phase: "preparing-entries",
      processed: 10,
      total: 101,
      message: "preparing entries"
    },
    {
      success: true,
      pending: true,
      phase: "preparing-entries",
      processed: 101,
      total: 101,
      message: "entries prepared"
    }
  ];
  let publishAttempt = 0;
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["admin"],
            capabilities: roleCapabilities({
              upload: true,
              drafts: true,
              review: true,
              publish: true,
              transportMode: "cloud-storage-direct"
            })
          }
        };
      }
      if (action === "getDraft") {
        return { result: { success: true, draft: approvedDraft } };
      }
      if (action === "publishDraft") {
        const pending = pendingResults[publishAttempt];
        publishAttempt += 1;
        return {
          result: pending || {
            success: true,
            alreadyApplied: false,
            draft: slimPublishedDraft
          }
        };
      }
      throw new Error(`unexpected resumable publisher action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx
  );

  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settle();
  await page.publishDraft();

  const publishRequests = actionCalls(harness, "publishDraft");
  assert.strictEqual(publishRequests.length, 5);
  assert.strictEqual(harness.calls.modals.length, 1);
  const requestIds = publishRequests.map((request) => request.data.requestId);
  assert.strictEqual(new Set(requestIds).size, 1);
  assertMutationId(requestIds[0]);
  publishRequests.forEach((request) => {
    assert.deepStrictEqual(Object.keys(request.data).sort(), [
      "action",
      "draftId",
      "expectedSnapshotHash",
      "expectedTargetRevision",
      "requestId"
    ]);
    assert.strictEqual(request.data.draftId, DRAFT_ID);
    assert.strictEqual(request.data.expectedSnapshotHash, SNAPSHOT_ONE);
    assert.strictEqual(request.data.expectedTargetRevision, "");
  });
  assert.strictEqual(page.data.draft.state, "published");
  assert.deepStrictEqual(clone(page.data.draft.payload), topicPayload);
  assert.strictEqual(page.data.form.title, topicPayload.title);
  assert.strictEqual(page.data.busyAction, "");
  assert.strictEqual(page.data.pageError, "");
});

test("模糊网络失败重试复用同一个幂等请求编号", async () => {
  let saveAttempt = 0;
  const requestIds = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            success: true,
            authorized: true,
            roles: ["uploader"],
            capabilities: roleCapabilities({ drafts: true })
          }
        };
      }
      if (action === "getDraft") {
        return { result: { success: true, draft: draftFixture() } };
      }
      if (action === "saveDraft") {
        saveAttempt += 1;
        requestIds.push(request.data.requestId);
        if (saveAttempt === 1) {
          throw new Error("network response lost");
        }
        return {
          result: {
            success: true,
            alreadyApplied: true,
            draft: draftFixture({ draftVersion: 2 })
          }
        };
      }
      throw new Error(`unexpected retry action ${action}`);
    }
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx
  );

  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settle();
  await page.saveDraft();
  assert.strictEqual(page.data.draft.draftVersion, 1);
  await page.saveDraft();

  assert.strictEqual(saveAttempt, 2);
  assert.strictEqual(requestIds[0], requestIds[1]);
  assertMutationId(requestIds[0]);
  assert.strictEqual(page.data.draft.draftVersion, 2);
});

test("buildPatch 为五类素材生成后端所需的最低结构", () => {
  const manuscript = adminContent.buildPatch(
    "manuscript",
    {
      bookId: " Hospital-Ship ",
      title: " 文章标题 ",
      subtitle: "副标题",
      sourceLabel: "编辑部",
      department: "胸外科",
      catalogBook: true,
      catalogSummary: true,
      sortOrder: "20",
      coverFileID: "",
      disclaimer: "声明",
      sections: [
        {
          kind: "story",
          heading: "正文",
          paragraphs: [" 第一段 ", ""]
        }
      ],
      structureConfirmed: true
    },
    "article-one"
  );
  assert.strictEqual(manuscript.bookId, "hospital-ship");
  assert.strictEqual(manuscript.title, "文章标题");
  assert.deepStrictEqual(manuscript.catalogViews, ["book", "summary"]);
  assert.deepStrictEqual(manuscript.sections, [
    { kind: "story", heading: "正文", paragraphs: ["第一段"] }
  ]);
  assert.strictEqual(manuscript.structureConfirmed, true);

  const audio = adminContent.buildPatch(
    "audio",
    {
      title: "配音",
      narrator: "少年会员",
      language: "zh-CN",
      durationSeconds: "125.5",
      bitrate: "128000"
    },
    "article-one"
  );
  assert.deepStrictEqual(audio, {
    title: "配音",
    narrator: "少年会员",
    language: "zh-CN",
    durationSeconds: 125.5,
    bitrate: 128000
  });

  const topicImageDraftId = SECOND_DRAFT_ID;
  const specialTopic = adminContent.buildPatch(
    "special-topic",
    {
      title: "小专题",
      summary: "专题摘要",
      producer: "编辑部",
      unlockCostStars: "50",
      sortOrder: "10",
      previewCoverFileID: "",
      entries: [
        {
          sortOrder: "10",
          blocks: [
            { type: "heading", text: "第一节" },
            { type: "text", text: "图文正文" },
            {
              type: "image",
              imageDraftId: topicImageDraftId.toUpperCase(),
              caption: "示意图"
            }
          ]
        }
      ],
      structureConfirmed: true
    },
    "topic-one"
  );
  assert.strictEqual(specialTopic.unlockCostStars, 50);
  assert.strictEqual(specialTopic.entries.length, 1);
  assert.deepStrictEqual(
    specialTopic.entries[0].blocks.map((block) => block.type),
    ["heading", "text", "image"]
  );
  assert.strictEqual(
    specialTopic.entries[0].blocks[2].imageDraftId,
    topicImageDraftId
  );
  assert.strictEqual(specialTopic.structureConfirmed, true);

  const fullBook = adminContent.buildPatch(
    "full-book-pdf",
    {
      title: "中国医院船",
      subtitle: "",
      fileName: "",
      structureMode: "replace",
      chapters: [
        {
          chapterId: "chapter-one",
          title: "第一章",
          sortOrder: "10",
          sourceContentId: "article-one",
          sourceContentRevision: "r-source",
          sections: [
            { kind: "story", heading: "", paragraphs: ["章节正文"] }
          ]
        }
      ],
      structureConfirmed: true
    },
    "hospital-ship"
  );
  assert.strictEqual(fullBook.fileName, "hospital-ship.pdf");
  assert.strictEqual(fullBook.structureMode, "replace");
  assert.strictEqual(fullBook.chapters.length, 1);
  assert.strictEqual(fullBook.chapters[0].chapterId, "chapter-one");
  assert.deepStrictEqual(fullBook.chapters[0].sections, [
    { kind: "story", heading: "", paragraphs: ["章节正文"] }
  ]);
  assert.strictEqual(fullBook.structureConfirmed, true);

  const topicImage = adminContent.buildPatch(
    "topic-image",
    { caption: " 专题配图说明 " },
    "topic-one"
  );
  assert.deepStrictEqual(topicImage, { caption: "专题配图说明" });

  const reuseBook = adminContent.buildPatch(
    "full-book-pdf",
    {
      title: "中国医院船",
      structureMode: "reuse-current",
      chapters: [{ chapterId: "must-not-send" }],
      structureConfirmed: false
    },
    "hospital-ship"
  );
  assert.deepStrictEqual(reuseBook.chapters, []);
  assert.strictEqual(reuseBook.structureConfirmed, true);

  const generatedBook = adminContent.buildPatch(
    "full-book-pdf",
    {
      title: "中国医院船",
      structureMode: "from-published-contents",
      chapters: [{ chapterId: "must-not-send" }],
      structureConfirmed: false
    },
    "china-hospital-ship"
  );
  assert.deepStrictEqual(generatedBook.chapters, []);
  assert.strictEqual(
    generatedBook.structureMode,
    "from-published-contents"
  );
  assert.strictEqual(generatedBook.structureConfirmed, true);
});

test("buildChangedPatch omits unchanged large topic payload fields", () => {
  const entries = Array.from({ length: 101 }, (_, index) => ({
    sortOrder: (index + 1) * 10,
    blocks: [
      {
        type: "text",
        text: `Topic paragraph ${index + 1}`
      }
    ]
  }));
  const embeddedAssets = Array.from({ length: 200 }, (_, index) => ({
    id: `asset-${index + 1}`,
    imageOrder: index + 1
  }));
  const draft = {
    assetType: "special-topic",
    targetId: "solar-system",
    payload: {
      topicId: "solar-system",
      title: "Solar system objects",
      summary: "A long illustrated topic",
      producer: "Editorial team",
      unlockCostStars: 0,
      sortOrder: 10,
      previewCoverFileID: "",
      entries,
      embeddedAssets,
      structureConfirmed: false
    }
  };
  const form = adminContent.payloadToForm(draft);
  form.unlockCostStars = 50;
  form.structureConfirmed = true;

  assert.deepStrictEqual(
    adminContent.buildChangedPatch("special-topic", form, draft),
    {
      unlockCostStars: 50,
      structureConfirmed: true
    }
  );
});

test("草稿与中文录入页不要求甲方填写内部技术字段", () => {
  const draftWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminDraft/adminDraft.wxml"),
    "utf8"
  );
  const editorialWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminEditorial/adminEditorial.wxml"),
    "utf8"
  );
  [
    "目标编号",
    "整书编号",
    "章节短编号",
    "关联文章编号",
    "图片草稿编号",
    "码率（bps）",
    "排序值"
  ].forEach((technicalLabel) => {
    assert(
      !draftWxml.includes(technicalLabel),
      `草稿页不应展示技术字段：${technicalLabel}`
    );
  });
  assert(!editorialWxml.includes("显示顺序（选填）"));
  assert(draftWxml.includes("系统自动归档和排序"));
  assert(draftWxml.includes("无需手工填写技术参数"));
  assert(draftWxml.includes("不需要填写编号"));
});

test("长草稿页在顶部和底部都保留当前流程操作", () => {
  const draftWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminDraft/adminDraft.wxml"),
    "utf8"
  );
  const draftWxss = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminDraft/adminDraft.wxss"),
    "utf8"
  );

  assert(draftWxml.includes("快捷操作"));
  assert(draftWxml.includes("长内容可在页面顶部直接完成当前步骤"));
  ["保存草稿", "提交复核", "批准当前内容", "发布已批准版本"].forEach(
    (label) => {
      assert(
        draftWxml.split(label).length - 1 >= 2,
        `${label} 应同时出现在顶部快捷区和底部完整操作区`
      );
    }
  );
  assert(
    draftWxml.includes(
      'disabled="{{busyAction || previewedSnapshotHash !== draft.snapshotHash}}"'
    ),
    "顶部批准操作必须沿用预览快照校验"
  );
  assert(draftWxss.includes(".quick-action-card"));
  assert(draftWxss.includes(".quick-action-row"));
});

async function main() {
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.handler();
      passed += 1;
      console.log(`✓ ${entry.name}`);
    } catch (error) {
      console.error(`✗ ${entry.name}`);
      throw error;
    }
  }
  console.log(`管理员内容中心前端 VM 回归通过：${passed}/${tests.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
