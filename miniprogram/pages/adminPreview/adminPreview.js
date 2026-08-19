const CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const SUPPORTED_TYPES = [
  "manuscript",
  "special-topic",
  "zhi-entry",
  "quiz-question"
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanText(value, maxLength = 10000) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

function shortText(value, maxLength = 28) {
  const text = cleanText(value, maxLength + 1);
  return text.length > maxLength
    ? `${text.slice(0, Math.max(1, maxLength - 1))}…`
    : text;
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function buildEmbeddedAssetMap(payload) {
  const map = Object.create(null);
  const assets = Array.isArray(payload.embeddedAssets)
    ? payload.embeddedAssets
    : [];
  assets.forEach((source) => {
    const asset = asObject(source);
    const id = cleanText(
      asset.id || asset.embeddedAssetId || asset.assetId || asset._id,
      64
    ).toLowerCase();
    const src = cleanText(
      asset.fileID || asset.tempFileURL || asset.previewUrl || asset.url,
      2048
    );
    if (id && src) map[id] = src;
  });
  return map;
}

function firstHeading(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const heading = list.find((item) =>
    item && item.type === "heading" && cleanText(item.text, 300)
  );
  return heading ? cleanText(heading.text, 300) : "";
}

function normalizeBlock(source, index, embeddedAssetMap) {
  const block = asObject(source);
  const type = block.type === "heading"
    ? "heading"
    : block.type === "image"
      ? "image"
      : "text";
  if (type === "image") {
    const embeddedAssetId = cleanText(block.embeddedAssetId, 64).toLowerCase();
    const src = cleanText(
      block.src || block.fileID || embeddedAssetMap[embeddedAssetId],
      2048
    );
    return {
      key: `image-${index}-${embeddedAssetId || "missing"}`,
      type,
      src,
      caption: cleanText(block.caption, 300),
      imageFailed: false
    };
  }
  return {
    key: `${type}-${index}`,
    type,
    text: cleanText(block.text, type === "heading" ? 300 : 10000)
  };
}

function blocksForPart(part, assetType, embeddedAssetMap) {
  const source = asObject(part);
  let blocks = Array.isArray(source.blocks) ? source.blocks : [];
  if (assetType === "manuscript" && blocks.length === 0) {
    blocks = (Array.isArray(source.paragraphs) ? source.paragraphs : [])
      .map((text) => ({ type: "text", text }));
  }
  return blocks
    .map((block, index) => normalizeBlock(block, index, embeddedAssetMap))
    .filter((block) => block.type === "image" || block.text);
}

function sourceModeLabel(sourceMode) {
  return sourceMode === "client-manifest-only"
    ? "Word 正文与图片清单"
    : "管理员结构化表单";
}

Page({
  data: {
    ready: false,
    errorMessage: "",
    assetType: "",
    assetLabel: "",
    sourceModeLabel: "",
    isLongForm: false,
    isSpecialTopic: false,
    isManuscript: false,
    isZhiEntry: false,
    isQuizQuestion: false,
    title: "",
    subtitle: "",
    summary: "",
    producer: "",
    metaLine: "",
    notice: "",
    coverSrc: "",
    directory: [],
    selectedIndex: 0,
    selectedTitle: "",
    selectedCounter: "",
    contentBlocks: [],
    zhiEntry: null,
    quiz: null
  },

  onLoad(options = {}) {
    this.pageUnloaded = false;
    let token = "";
    try {
      token = decodeURIComponent(options.token || "");
    } catch (error) {
      token = "";
    }

    const app = typeof getApp === "function" ? getApp() : null;
    const cache = app && app.globalData
      ? app.globalData.adminDraftPreview
      : null;
    const createdAt = Number(cache && cache.createdAt);
    const cacheAge = Date.now() - createdAt;
    const payload = asObject(cache && cache.payload);
    const assetType = cleanText(cache && cache.assetType, 32);
    if (
      !token ||
      !cache ||
      cache.token !== token ||
      !Number.isFinite(createdAt) ||
      cacheAge < 0 ||
      cacheAge > CACHE_MAX_AGE_MS ||
      !SUPPORTED_TYPES.includes(assetType) ||
      Object.keys(payload).length === 0
    ) {
      this.setData({
        errorMessage: "这份预览已失效，请返回内容草稿后重新点击“预览发布效果”。"
      });
      return;
    }

    this.previewApp = app;
    this.previewCache = cache;
    this.previewPayload = payload;
    this.embeddedAssetMap = buildEmbeddedAssetMap(payload);
    this.preparePreview(assetType, payload, cache);
  },

  onUnload() {
    this.pageUnloaded = true;
    if (
      this.previewApp &&
      this.previewApp.globalData &&
      this.previewApp.globalData.adminDraftPreview === this.previewCache
    ) {
      delete this.previewApp.globalData.adminDraftPreview;
    }
    this.previewParts = null;
    this.previewPayload = null;
    this.embeddedAssetMap = null;
  },

  preparePreview(assetType, payload, cache) {
    const common = {
      ready: true,
      assetType,
      sourceModeLabel: sourceModeLabel(cache.sourceMode),
      isLongForm: ["manuscript", "special-topic"].includes(assetType),
      isSpecialTopic: assetType === "special-topic",
      isManuscript: assetType === "manuscript",
      isZhiEntry: assetType === "zhi-entry",
      isQuizQuestion: assetType === "quiz-question"
    };

    if (assetType === "special-topic") {
      const parts = Array.isArray(payload.entries) ? payload.entries : [];
      const directory = parts.map((part, index) => ({
        index,
        label: shortText(firstHeading(part && part.blocks) || `专题内容 ${index + 1}`),
        active: index === 0
      }));
      this.previewParts = parts;
      this.setData({
        ...common,
        assetLabel: "少年真小专题",
        title: cleanText(payload.title, 120) || "未命名小专题",
        summary: cleanText(payload.summary, 500),
        producer: cleanText(payload.producer, 120),
        notice: `读者首次解锁需 ${Math.max(0, finiteInteger(payload.unlockCostStars))} 颗红五星；本次管理员预览不扣星。`,
        coverSrc: cleanText(payload.previewCoverFileID, 2048),
        directory
      });
      this.renderPart(0);
      return;
    }

    if (assetType === "manuscript") {
      const parts = Array.isArray(payload.sections) ? payload.sections : [];
      const directory = parts.map((part, index) => ({
        index,
        label: shortText(part && part.heading || `正文小节 ${index + 1}`),
        active: index === 0
      }));
      const meta = [
        cleanText(payload.sourceLabel, 120),
        cleanText(payload.department, 80)
      ].filter(Boolean).join(" · ");
      this.previewParts = parts;
      this.setData({
        ...common,
        assetLabel: "首页书稿",
        title: cleanText(payload.title, 120) || "未命名书稿",
        subtitle: cleanText(payload.subtitle, 240),
        metaLine: meta,
        notice: cleanText(payload.disclaimer, 1000),
        coverSrc: cleanText(payload.coverFileID, 2048),
        directory
      });
      this.renderPart(0);
      return;
    }

    if (assetType === "zhi-entry") {
      this.setData({
        ...common,
        assetLabel: "少年志消息",
        title: cleanText(payload.label, 80) || "少年志消息",
        zhiEntry: {
          eventAt: cleanText(payload.eventAt, 32),
          source: cleanText(payload.source, 120),
          label: cleanText(payload.label, 80),
          content: cleanText(payload.content, 2000)
        }
      });
      return;
    }

    const correctKey = cleanText(payload.correctKey, 1).toUpperCase();
    const options = (Array.isArray(payload.options) ? payload.options : [])
      .map((source, index) => {
        const option = asObject(source);
        const key = cleanText(option.key, 1).toUpperCase() || String.fromCharCode(65 + index);
        return {
          key,
          label: cleanText(option.label, 30) || `选择${key}`,
          text: cleanText(option.text, 1000),
          isCorrect: key === correctKey
        };
      });
    this.setData({
      ...common,
      assetLabel: "少年爱题目",
      title: cleanText(payload.topic, 120) || "少年爱答题",
      quiz: {
        department: cleanText(payload.department, 160),
        source: cleanText(payload.source, 300),
        question: cleanText(payload.question, 3000),
        correctKey,
        options,
        correctFeedback: cleanText(payload.correctFeedback, 500),
        wrongFeedback: cleanText(payload.wrongFeedback, 500),
        explanation: cleanText(payload.explanation, 5000)
      }
    });
  },

  selectPart(event) {
    const index = finiteInteger(
      event && event.currentTarget && event.currentTarget.dataset.index,
      -1
    );
    this.renderPart(index);
  },

  renderPart(index) {
    const parts = Array.isArray(this.previewParts) ? this.previewParts : [];
    if (index < 0 || index >= parts.length) {
      this.setData({
        selectedIndex: 0,
        selectedTitle: "暂无可预览正文",
        selectedCounter: "0 / 0",
        contentBlocks: []
      });
      return;
    }
    const part = asObject(parts[index]);
    const selectedTitle = this.data.assetType === "manuscript"
      ? cleanText(part.heading, 120) || `正文小节 ${index + 1}`
      : firstHeading(part.blocks) || `专题内容 ${index + 1}`;
    this.setData({
      selectedIndex: index,
      selectedTitle,
      selectedCounter: `${index + 1} / ${parts.length}`,
      contentBlocks: blocksForPart(
        part,
        this.data.assetType,
        this.embeddedAssetMap || Object.create(null)
      ),
      directory: this.data.directory.map((item) => ({
        ...item,
        active: item.index === index
      }))
    });
  },

  onImageError(event) {
    const index = finiteInteger(
      event && event.currentTarget && event.currentTarget.dataset.index,
      -1
    );
    if (index < 0 || index >= this.data.contentBlocks.length) return;
    this.setData({
      contentBlocks: this.data.contentBlocks.map((block, blockIndex) =>
        blockIndex === index ? { ...block, imageFailed: true } : block
      )
    });
  }
});
