const { loadContentCatalogResult } = require("../../utils/contents");

const SUMMARY_READ_STORAGE_KEY = "summaryReadContentIds";

const palette = ["#aa99c5", "#7ebdee", "#f99f87", "#41ac8e"];

function readViewedIds() {
  try {
    // Older builds cached this state before the server confirmed membership.
    // Remove that untrusted cache and use readingStates from the cloud catalog.
    wx.removeStorageSync(SUMMARY_READ_STORAGE_KEY);
  } catch (error) {
    console.warn("清理旧摘要阅读缓存失败：", error);
  }

  return [];
}

function formatPublishedAt(value, fallback) {
  if (!value) {
    return fallback || "发布日期待定";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return fallback || "发布日期待定";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}年${month}月${day}日`;
}

function createDisplayItems(items, viewedIds) {
  return items.map((item, index) =>
    Object.assign({}, item, {
      color: palette[index % palette.length],
      viewed: item.available && Boolean(item.viewed)
    })
  );
}

Page({
  data: {
    items: [],
    catalogLoaded: false
  },

  onShow() {
    this.pageVisible = true;
    this.pageDestroyed = false;
    const viewedIds = readViewedIds();

    this.setData({
      items: [],
      catalogLoaded: false
    });

    this.loadCatalog(viewedIds);
  },

  onHide() {
    this.pageVisible = false;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogLoading = false;
  },

  onUnload() {
    this.pageVisible = false;
    this.pageDestroyed = true;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogLoading = false;
  },

  async loadCatalog(viewedIds) {
    if (this.catalogLoading || !this.pageVisible || this.pageDestroyed) {
      return;
    }

    const requestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestId = requestId;
    this.catalogLoading = true;
    const result = await loadContentCatalogResult("summary");

    if (
      requestId !== this.catalogRequestId ||
      !this.pageVisible ||
      this.pageDestroyed
    ) {
      return;
    }

    this.catalogLoading = false;
    this.catalogHasMore = result.hasMore;
    this.catalogNextOffset = result.nextOffset;
    const remoteItems = result.items
      .filter((item) => item.available)
      .map((item) => ({
        id: item.id,
        bookName: "《中国医院船》",
        dateLabel: formatPublishedAt(item.publishedAt, item.sourceLabel),
        title: item.title,
        available: true,
        viewed: Boolean(item.viewed)
      }));

    this.remoteSummaryItems = remoteItems;
    this.setData({ catalogLoaded: true });
    this.renderCatalog(viewedIds);
  },

  renderCatalog(viewedIds = readViewedIds()) {
    const remoteItems = Array.isArray(this.remoteSummaryItems)
      ? this.remoteSummaryItems
      : [];

    this.setData({
      items: createDisplayItems(remoteItems, viewedIds)
    });
  },

  async onReachBottom() {
    if (
      this.catalogLoading ||
      !this.pageVisible ||
      this.pageDestroyed ||
      !this.catalogHasMore ||
      !Number.isInteger(this.catalogNextOffset)
    ) {
      return;
    }

    const requestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestId = requestId;
    this.catalogLoading = true;
    const result = await loadContentCatalogResult("summary", {
      offset: this.catalogNextOffset
    });

    if (
      requestId !== this.catalogRequestId ||
      !this.pageVisible ||
      this.pageDestroyed
    ) {
      return;
    }

    this.catalogLoading = false;

    if (!result.success) {
      wx.showToast({
        title: "更多摘要加载失败",
        icon: "none"
      });
      return;
    }

    const existingIds = new Set(
      (this.remoteSummaryItems || []).map((item) => item.id)
    );
    const appendedItems = result.items
      .filter((item) => item.available && !existingIds.has(item.id))
      .map((item) => ({
        id: item.id,
        bookName: "《中国医院船》",
        dateLabel: formatPublishedAt(item.publishedAt, item.sourceLabel),
        title: item.title,
        available: true,
        viewed: Boolean(item.viewed)
      }));

    this.remoteSummaryItems = (this.remoteSummaryItems || []).concat(
      appendedItems
    );
    this.catalogHasMore = result.hasMore;
    this.catalogNextOffset = result.nextOffset;
    this.renderCatalog();
  },

  openSummary(event) {
    const contentId = event.currentTarget.dataset.id;
    const item = this.data.items.find((candidate) => candidate.id === contentId);

    if (!item || !item.available) {
      wx.showToast({
        title: "正式摘要尚未接入",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/article/article?id=${encodeURIComponent(contentId)}`
    });
  }
});
