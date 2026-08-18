const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const adminContent = require("./miniprogram/utils/adminContent");
const DRAFT_ID = "d".repeat(32);
const SNAPSHOT = "a".repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleAll(count = 5) {
  for (let index = 0; index < count; index += 1) await settle();
}

function createHarness(handler, app = { globalData: {} }) {
  const calls = {
    cloud: [],
    navigateTo: [],
    modals: []
  };
  const wx = {
    cloud: {
      async callFunction(request) {
        calls.cloud.push(clone(request));
        return handler(request);
      }
    },
    navigateTo(request) {
      calls.navigateTo.push(clone(request));
      if (request.success) request.success({});
    },
    showModal(request) {
      calls.modals.push({
        title: request.title,
        content: request.content,
        confirmText: request.confirmText
      });
      request.success({ confirm: true, cancel: false });
    },
    showToast() {}
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
    console: { error() {}, log() {}, warn() {} },
    Date,
    getApp: () => app,
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

function statusResult(overrides = {}) {
  return {
    result: {
      success: true,
      authorized: true,
      capabilities: {
        drafts: true,
        assetPreview: true,
        ...overrides
      }
    }
  };
}

async function testQuizCreationForm() {
  const harness = createHarness(async (request) => {
    if (request.data.action === "status") return statusResult();
    if (request.data.action === "createEditorialDraft") {
      return {
        result: {
          success: true,
          draft: { id: DRAFT_ID }
        }
      };
    }
    throw new Error(`unexpected action: ${request.data.action}`);
  });
  const page = loadPage(
    "miniprogram/pages/adminEditorial/adminEditorial.js",
    harness.wx
  );
  page.onLoad({ type: "quiz-question" });
  page.onShow();
  await settleAll();
  assert.strictEqual(page.data.authorized, true);
  assert.strictEqual(page.data.selectedType, "quiz-question");

  page.setData({
    quizForm: {
      topic: "食管癌的故事",
      department: "胸外科",
      source: "书稿第一章",
      question: "下列哪一项属于典型症状？",
      options: [
        { key: "A", text: "进行性吞咽困难" },
        { key: "B", text: "长期高温饮食" }
      ],
      correctKey: "A",
      correctFeedback: "答对了。",
      wrongFeedback: "再想一想。",
      explanation: "进行性吞咽困难属于典型症状。",
      sortOrder: "10"
    }
  });
  page.addOption();
  page.onOptionInput({
    currentTarget: { dataset: { index: 2 } },
    detail: { value: "保持规律作息" }
  });
  page.chooseCorrectOption({
    currentTarget: { dataset: { key: "C" } }
  });
  await page.createDraft();

  const request = harness.calls.cloud.find(
    (item) => item.data.action === "createEditorialDraft"
  );
  assert(request);
  assert.deepStrictEqual(Object.keys(request.data).sort(), [
    "action",
    "assetType",
    "payload",
    "requestId"
  ]);
  assert.strictEqual(request.data.assetType, "quiz-question");
  assert.match(request.data.requestId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.deepStrictEqual(
    request.data.payload.options.map((option) => ({
      key: option.key,
      label: option.label,
      text: option.text
    })),
    [
      { key: "A", label: "选择一", text: "进行性吞咽困难" },
      { key: "B", label: "选择二", text: "长期高温饮食" },
      { key: "C", label: "选择三", text: "保持规律作息" }
    ]
  );
  assert.strictEqual(request.data.payload.correctKey, "C");
  assert.strictEqual(
    request.data.payload.sortOrder,
    0,
    "录入页应自动使用默认顺序，不让管理员填写技术排序值"
  );
  assert.deepStrictEqual(harness.calls.navigateTo, [{
    url: `/pages/adminDraft/adminDraft?id=${DRAFT_ID}`
  }]);
}

async function testZhiValidationAndCreation() {
  const harness = createHarness(async (request) => {
    if (request.data.action === "status") return statusResult();
    return {
      result: {
        success: true,
        draft: { id: DRAFT_ID }
      }
    };
  });
  const page = loadPage(
    "miniprogram/pages/adminEditorial/adminEditorial.js",
    harness.wx
  );
  page.onLoad({ type: "zhi-entry" });
  page.onShow();
  await settleAll();

  page.setData({
    zhiForm: {
      eventAt: "2026-07-30",
      source: "",
      label: "志愿活动",
      content: "少年志消息正文。"
    }
  });
  await page.createDraft();
  assert.match(page.data.pageError, /来源/);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (item) => item.data.action === "createEditorialDraft"
    ).length,
    0
  );

  page.onZhiInput({
    currentTarget: { dataset: { field: "source" } },
    detail: { value: "中国医院船编辑部" }
  });
  await page.createDraft();
  const request = harness.calls.cloud.find(
    (item) => item.data.action === "createEditorialDraft"
  );
  assert.deepStrictEqual(clone(request.data.payload), {
    eventAt: "2026-07-30",
    source: "中国医院船编辑部",
    label: "志愿活动",
    content: "少年志消息正文。"
  });
}

function testDraftPatchKeepsEmbeddedImages() {
  const embeddedAssets = [{
    id: "embedded-0001",
    order: 1,
    fileID: "cloud://env/protected/contents/demo/image.png",
    cloudPath: "protected/contents/demo/image.png",
    extension: "png"
  }];
  const manuscriptForm = adminContent.payloadToForm({
    assetType: "manuscript",
    payload: {
      title: "带图书稿",
      catalogViews: ["book"],
      sections: [{
        kind: "story",
        heading: "第一节",
        paragraphs: ["原文第一段", "原文第二段"],
        blocks: [
          { type: "text", text: "原文第一段" },
          {
            type: "image",
            embeddedAssetId: "embedded-0001",
            caption: "图片说明"
          },
          { type: "text", text: "原文第二段" }
        ]
      }],
      embeddedAssets,
      structureConfirmed: true
    }
  });
  manuscriptForm.sections[0].blocks[0].text = "校对后的第一段";
  const manuscriptPatch = adminContent.buildPatch(
    "manuscript",
    manuscriptForm,
    "article-one"
  );
  assert.deepStrictEqual(manuscriptPatch.sections[0].blocks, [
    { type: "text", text: "校对后的第一段" },
    {
      type: "image",
      embeddedAssetId: "embedded-0001",
      caption: "图片说明"
    },
    { type: "text", text: "原文第二段" }
  ]);
  assert.deepStrictEqual(
    manuscriptPatch.sections[0].paragraphs,
    ["校对后的第一段", "原文第二段"]
  );
  assert.deepStrictEqual(manuscriptPatch.embeddedAssets, embeddedAssets);

  const topicForm = adminContent.payloadToForm({
    assetType: "special-topic",
    payload: {
      title: "带图专题",
      entries: [{
        sortOrder: 10,
        blocks: [
          { type: "text", text: "专题正文" },
          {
            type: "image",
            embeddedAssetId: "embedded-0001",
            caption: "专题图片"
          }
        ]
      }],
      embeddedAssets,
      structureConfirmed: true
    }
  });
  const topicPatch = adminContent.buildPatch(
    "special-topic",
    topicForm,
    "topic-one"
  );
  assert.deepStrictEqual(topicPatch.entries[0].blocks[1], {
    type: "image",
    embeddedAssetId: "embedded-0001",
    caption: "专题图片"
  });
  assert.deepStrictEqual(topicPatch.embeddedAssets, embeddedAssets);
}

async function testEditorialDraftPreviewAndSave() {
  const draft = {
    id: DRAFT_ID,
    assetType: "quiz-question",
    kind: "quiz",
    targetId: "quiz-" + "1".repeat(28),
    revision: "r-" + "2".repeat(32),
    draftVersion: 1,
    state: "in_review",
    payload: {
      topic: "医学故事",
      department: "胸外科",
      source: "书稿",
      question: "测试题目",
      options: [
        { key: "one", label: "选择一", text: "答案甲" },
        { key: "two", label: "选择二", text: "答案乙" }
      ],
      correctKey: "two",
      correctFeedback: "",
      wrongFeedback: "",
      explanation: "",
      sortOrder: 10
    },
    issues: [],
    inspection: {},
    snapshotHash: SNAPSHOT,
    updateTime: "2026-07-30T00:00:00.000Z"
  };
  const harness = createHarness(async (request) => {
    if (request.data.action === "status") {
      return statusResult({ review: true });
    }
    if (request.data.action === "getDraft") {
      return { result: { success: true, draft } };
    }
    if (request.data.action === "getDraftAssetPreview") {
      return {
        result: {
          success: true,
          assetType: "quiz-question",
          previewKind: "structured",
          snapshotHash: SNAPSHOT,
          sourceMode: "structured-form"
        }
      };
    }
    throw new Error(`unexpected action: ${request.data.action}`);
  });
  const page = loadPage(
    "miniprogram/pages/adminDraft/adminDraft.js",
    harness.wx,
    harness.app
  );
  page.onLoad({ id: DRAFT_ID });
  page.onShow();
  await settleAll();
  assert.strictEqual(page.data.draft.isEditorial, true);
  assert.strictEqual(page.data.form.correctKey, "B");
  assert.deepStrictEqual(
    page.data.form.options.map((option) => option.key),
    ["A", "B"]
  );

  await page.previewAsset();
  assert.strictEqual(page.data.previewedSnapshotHash, SNAPSHOT);
  assert.match(page.data.actionMessage, /预览|核对/);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
  assert.match(
    harness.calls.navigateTo[0].url,
    /^\/pages\/adminPreview\/adminPreview\?token=[A-Za-z0-9_-]+$/
  );
  const cache = harness.app.globalData.adminDraftPreview;
  assert(cache, "结构化预览应写入稳定的 app.globalData 缓存");
  assert.strictEqual(cache.draftId, DRAFT_ID);
  assert.strictEqual(cache.assetType, "quiz-question");
  assert.strictEqual(cache.snapshotHash, SNAPSHOT);
  assert.deepStrictEqual(clone(cache.payload), draft.payload);
  assert.strictEqual(
    decodeURIComponent(harness.calls.navigateTo[0].url.split("token=")[1]),
    cache.token
  );
}

function testStaticChineseForms() {
  const createWxml = fs.readFileSync(
    path.join(
      root,
      "miniprogram/pages/adminEditorial/adminEditorial.wxml"
    ),
    "utf8"
  );
  const draftWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminDraft/adminDraft.wxml"),
    "utf8"
  );
  const previewWxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminPreview/adminPreview.wxml"),
    "utf8"
  );
  [
    "少年志消息",
    "少年爱题目",
    "消息日期",
    "消息来源",
    "消息标签",
    "消息正文",
    "选项与正确答案",
    "生成草稿并继续"
  ].forEach((copy) => assert(createWxml.includes(copy), `缺少文案：${copy}`));
  assert(!/MIME|revision|目标编号|草稿编号/.test(createWxml));
  assert(draftWxml.includes("预览发布效果"));
  assert(draftWxml.includes("Word 内嵌图片"));
  assert(draftWxml.includes("block.embeddedAssetId"));
  ["管理员只读预览", "不会正式发布", "不会扣除红五星"].forEach((copy) => {
    assert(previewWxml.includes(copy), `预览页缺少安全文案：${copy}`);
  });
}

async function main() {
  await testQuizCreationForm();
  await testZhiValidationAndCreation();
  testDraftPatchKeepsEmbeddedImages();
  await testEditorialDraftPreviewAndSave();
  testStaticChineseForms();
  console.log(
    "管理员中文录入 UI 测试通过：少年志、少年爱、草稿预览及 Word 内嵌图片保留。"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
