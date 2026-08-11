const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const RECORD_ONE = "1".repeat(32);
const RECORD_TWO = "2".repeat(32);
const HASH_ONE = "a".repeat(64);
const HASH_TWO = "b".repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleAll(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await settle();
  }
}

function pendingRecord(id, commentHash, title) {
  return {
    id,
    contentId: `story-${id.slice(0, 4)}`,
    title,
    comment: "这是一篇命中敏感词、需要结合文章语境判断的少年读后感。",
    contentRevision: "revision-1",
    submittedAt: "2026-07-30T08:30:00.000Z",
    reviewCategory: "敏感词测试",
    commentHash
  };
}

function createHarness(handler, options = {}) {
  const calls = {
    cloud: [],
    modals: [],
    toasts: []
  };
  const wx = {
    cloud: {
      async callFunction(request) {
        calls.cloud.push(clone(request));
        return handler(request);
      }
    },
    showModal(request) {
      calls.modals.push({
        title: request.title,
        content: request.content,
        confirmText: request.confirmText
      });
      const result = options.modalResult || {
        confirm: true,
        cancel: false
      };
      if (request.success) request.success(result);
    },
    showToast(request) {
      calls.toasts.push(clone(request));
    }
  };

  return { calls, wx };
}

function loadPage(wx) {
  const relativePath =
    "miniprogram/pages/adminModeration/adminModeration.js";
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const localRequire = Module.createRequire(filename);
  let definition = null;
  const sandbox = {
    clearTimeout,
    console: { error() {}, log() {}, warn() {} },
    Date,
    Page(config) {
      definition = config;
    },
    require: localRequire,
    setTimeout,
    wx
  };

  vm.runInNewContext(source, sandbox, { filename });
  assert(definition, `${relativePath} 没有注册页面`);
  const page = { ...definition };
  page.data = clone(definition.data || {});
  page.setData = function setData(update, callback) {
    Object.assign(this.data, update);
    if (typeof callback === "function") callback();
  };
  return page;
}

async function testListAndPagination() {
  const harness = createHarness(async (request) => {
    assert.strictEqual(request.name, "moderationCenter");
    assert.strictEqual(request.data.action, "listPending");

    if (request.data.offset === 0) {
      return {
        result: {
          success: true,
          action: "listPending",
          records: [
            pendingRecord(RECORD_ONE, HASH_ONE, "第一篇文章"),
            { id: "invalid", commentHash: "invalid", comment: "无效记录" }
          ],
          hasMore: true,
          nextOffset: 20
        }
      };
    }

    assert.strictEqual(request.data.offset, 20);
    return {
      result: {
        success: true,
        action: "listPending",
        records: [pendingRecord(RECORD_TWO, HASH_TWO, "第二篇文章")],
        hasMore: false,
        nextOffset: null
      }
    };
  });
  const page = loadPage(harness.wx);
  page.onLoad();
  page.onShow();
  await settleAll();

  assert.strictEqual(page.data.authorized, true);
  assert.strictEqual(page.data.records.length, 1);
  assert.strictEqual(page.data.records[0].id, RECORD_ONE);
  assert.strictEqual(page.data.hasMore, true);

  page.loadMore();
  await settleAll();
  assert.deepStrictEqual(
    clone(page.data.records.map((record) => record.id)),
    [RECORD_ONE, RECORD_TWO]
  );
  assert.strictEqual(page.data.hasMore, false);
}

async function testApproveAndDuplicateTap() {
  const reviewResponse = deferred();
  const harness = createHarness(async (request) => {
    if (request.data.action === "listPending") {
      return {
        result: {
          success: true,
          records: [pendingRecord(RECORD_ONE, HASH_ONE, "待批准文章")],
          hasMore: false,
          nextOffset: null
        }
      };
    }

    if (request.data.action === "review") {
      return reviewResponse.promise;
    }

    throw new Error(`unexpected action: ${request.data.action}`);
  });
  const page = loadPage(harness.wx);
  page.onLoad();
  page.onShow();
  await settleAll();
  const event = {
    currentTarget: {
      dataset: { recordId: RECORD_ONE, decision: "approve" }
    }
  };

  page.confirmReview(event);
  page.confirmReview(event);
  await settleAll(2);
  const reviewCalls = harness.calls.cloud.filter(
    (request) => request.data.action === "review"
  );
  assert.strictEqual(reviewCalls.length, 1, "重复点击不得重复提交审批");
  assert.deepStrictEqual(reviewCalls[0].data, {
    action: "review",
    recordId: RECORD_ONE,
    expectedCommentHash: HASH_ONE,
    decision: "approve"
  });

  reviewResponse.resolve({
    result: {
      success: true,
      status: "completed",
      decision: "approve",
      starAwarded: 50,
      fullBookGranted: true
    }
  });
  await settleAll();
  assert.strictEqual(page.data.records.length, 0);
  assert.strictEqual(page.data.actionRecordId, "");
  assert(
    harness.calls.toasts.some((toast) => /50星/.test(toast.title)),
    "批准补发50星后应给出明确提示"
  );
}

async function testReject() {
  const harness = createHarness(async (request) => {
    if (request.data.action === "listPending") {
      return {
        result: {
          success: true,
          records: [pendingRecord(RECORD_ONE, HASH_ONE, "待退回文章")],
          hasMore: false,
          nextOffset: null
        }
      };
    }

    assert.strictEqual(request.data.action, "review");
    assert.strictEqual(request.data.decision, "reject");
    return {
      result: {
        success: true,
        status: "revision_required",
        decision: "reject",
        starAwarded: 0,
        fullBookGranted: false
      }
    };
  });
  const page = loadPage(harness.wx);
  page.onLoad();
  page.onShow();
  await settleAll();
  page.confirmReview({
    currentTarget: {
      dataset: { recordId: RECORD_ONE, decision: "reject" }
    }
  });
  await settleAll();

  assert.strictEqual(page.data.records.length, 0);
  assert(
    harness.calls.modals.some((modal) => /不会被删除/.test(modal.content))
  );
  assert(
    harness.calls.toasts.some((toast) => /退回修改/.test(toast.title))
  );
}

async function testLateReviewResponseIsIgnored() {
  const reviewResponse = deferred();
  const harness = createHarness(async (request) => {
    if (request.data.action === "listPending") {
      return {
        result: {
          success: true,
          records: [pendingRecord(RECORD_ONE, HASH_ONE, "晚到响应文章")],
          hasMore: false,
          nextOffset: null
        }
      };
    }

    return reviewResponse.promise;
  });
  const page = loadPage(harness.wx);
  page.onLoad();
  page.onShow();
  await settleAll();
  page.confirmReview({
    currentTarget: {
      dataset: { recordId: RECORD_ONE, decision: "approve" }
    }
  });
  await settleAll(2);
  page.onHide();
  reviewResponse.resolve({
    result: {
      success: true,
      status: "completed",
      decision: "approve",
      starAwarded: 50
    }
  });
  await settleAll();

  assert.strictEqual(page.data.records.length, 1);
  assert.strictEqual(harness.calls.toasts.length, 0);
}

async function testLateListAndPermissionDenied() {
  const listResponse = deferred();
  const lateHarness = createHarness(() => listResponse.promise);
  const latePage = loadPage(lateHarness.wx);
  latePage.onLoad();
  latePage.onShow();
  latePage.onHide();
  listResponse.resolve({
    result: {
      success: true,
      records: [pendingRecord(RECORD_ONE, HASH_ONE, "不应写入页面")],
      hasMore: false
    }
  });
  await settleAll();
  assert.strictEqual(latePage.data.records.length, 0);

  const deniedHarness = createHarness(async () => ({
    result: {
      success: false,
      code: "ADMIN_FORBIDDEN",
      message: "当前微信没有读后感复审权限"
    }
  }));
  const deniedPage = loadPage(deniedHarness.wx);
  deniedPage.onLoad();
  deniedPage.onShow();
  await settleAll();
  assert.strictEqual(deniedPage.data.accessChecked, true);
  assert.strictEqual(deniedPage.data.authorized, false);
  assert.match(deniedPage.data.accessMessage, /没有读后感复审权限/);
}

function testStaticEntryAndCopy() {
  const app = JSON.parse(
    fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8")
  );
  const pageWxml = fs.readFileSync(
    path.join(
      root,
      "miniprogram/pages/adminModeration/adminModeration.wxml"
    ),
    "utf8"
  );
  const uploadsWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminUploads/adminUploads.wxml"),
    "utf8"
  );
  const registeredPages = [
    ...(Array.isArray(app.pages) ? app.pages : []),
    ...(Array.isArray(app.subPackages) ? app.subPackages : []).flatMap(
      (subpackage) =>
        (subpackage.pages || []).map(
          (pagePath) => `${subpackage.root}/${pagePath}`
        )
    )
  ];

  assert(registeredPages.includes("pages/adminModeration/adminModeration"));
  assert(uploadsWxml.includes('bindtap="openModeration"'));
  assert(uploadsWxml.includes("待复审读后感"));
  assert(pageWxml.includes("批准并发奖励"));
  assert(pageWxml.includes("退回修改"));
  assert.strictEqual(pageWxml.includes("删除"), false);
}

async function main() {
  await testListAndPagination();
  await testApproveAndDuplicateTap();
  await testReject();
  await testLateReviewResponseIsIgnored();
  await testLateListAndPermissionDenied();
  testStaticEntryAndCopy();
  console.log(
    "管理员读后感复审 UI 测试通过：列表分页、批准补发50星、退回、权限、重复点击与晚到响应均已覆盖。"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
