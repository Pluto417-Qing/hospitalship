const {
  bookContentList,
  loadContentCatalogResult
} = require("../../utils/contents");

const cardColors = ["#aa99c5", "#7ebdee", "#f99f87", "#41ac8e"];
const defaultContent = bookContentList.find((item) => item.available) || null;
const CATALOG_DRAFT_STORAGE_KEY = "bookCatalogCommentDraft";

function readCatalogDraft() {
  try {
    const draft = wx.getStorageSync(CATALOG_DRAFT_STORAGE_KEY);

    if (!draft || typeof draft !== "object") {
      return null;
    }

    const comment = typeof draft.comment === "string"
      ? Array.from(draft.comment).slice(0, 2000).join("")
      : "";
    const selectedContentId = typeof draft.selectedContentId === "string"
      ? draft.selectedContentId.slice(0, 64)
      : "";

    return {
      comment,
      selectedContentId
    };
  } catch (error) {
    console.warn("读取书目页读后感草稿失败：", error);
    return null;
  }
}

function saveCatalogDraft(comment, selectedContentId) {
  try {
    wx.setStorageSync(CATALOG_DRAFT_STORAGE_KEY, {
      comment,
      selectedContentId
    });
  } catch (error) {
    console.warn("保存书目页读后感草稿失败：", error);
  }
}

function clearCatalogDraft() {
  try {
    wx.removeStorageSync(CATALOG_DRAFT_STORAGE_KEY);
  } catch (error) {
    console.warn("清除书目页读后感草稿失败：", error);
  }
}

function rememberCatalogCommentIntent(contentId) {
  if (!contentId) {
    return;
  }

  try {
    wx.setStorageSync("pendingMemberIntent", {
      type: "catalog-comment",
      contentId,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn("保存书目读后感登录回跳失败：", error);
  }
}

function createCatalogContents(contents = bookContentList) {
  return contents.map((item, index) => ({
    ...item,
    displayAccent: cardColors[index % cardColors.length]
  }));
}

function createSelectionState(contents, selectedContentId) {
  const selected = contents.find(
    (item) => item.available && item.id === selectedContentId
  ) || null;
  const bookContent = selected && selected.bookId
    ? selected
    : contents.find((item) => item.available && item.bookId) || null;

  return {
    selectedContentTitle: selected ? selected.title : "",
    selectedContentViewed: Boolean(selected && selected.viewed),
    selectedBookId: bookContent ? bookContent.bookId : ""
  };
}

Page({
  data: {
    contents: createCatalogContents(),
    comment: "",
    commentLength: 0,
    submitting: false,
    submitted: false,
    needsRevision: false,
    reviewPending: false,
    selectedContentId: defaultContent ? defaultContent.id : "",
    selectedContentTitle: defaultContent ? defaultContent.title : "",
    selectedContentViewed: Boolean(defaultContent && defaultContent.viewed),
    selectedBookId: defaultContent && defaultContent.bookId
      ? defaultContent.bookId
      : ""
  },

  onLoad() {
    this.pageVisible = true;
    this.pageDestroyed = false;
    const draft = readCatalogDraft();

    if (draft) {
      this.setData({
        comment: draft.comment,
        commentLength: Array.from(draft.comment.trim()).length,
        selectedContentId:
          draft.selectedContentId || this.data.selectedContentId
      });
    }

    this.loadCatalog();
  },

  onShow() {
    const returningToPage = Boolean(this.hasShown);
    const shouldReload = Boolean(
      this.catalogReloadOnShow || this.readStateRefreshPending
    );
    this.hasShown = true;
    this.pageVisible = true;
    this.catalogReloadOnShow = false;
    this.readStateRefreshPending = false;

    if (returningToPage && shouldReload && !this.catalogLoading) {
      this.loadCatalog();
    }
  },

  onHide() {
    if (this.catalogLoading) {
      this.catalogReloadOnShow = true;
    }

    this.pageVisible = false;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogLoading = false;
  },

  onUnload() {
    this.pageVisible = false;
    this.pageDestroyed = true;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogLoading = false;
    this.submitRequestId = (this.submitRequestId || 0) + 1;
  },

  async loadCatalog() {
    if (this.catalogLoading || !this.pageVisible || this.pageDestroyed) {
      return;
    }

    const requestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestId = requestId;
    this.catalogLoading = true;

    // 只使用本地固定的4项内容，不从云函数加载额外内容
    const contents = bookContentList.slice(0, 4);

    if (
      requestId !== this.catalogRequestId ||
      !this.pageVisible ||
      this.pageDestroyed
    ) {
      return;
    }

    this.catalogLoading = false;
    this.catalogHasMore = false;
    this.catalogNextOffset = 0;

    const selectedExists = contents.some(
      (item) => item.available && item.id === this.data.selectedContentId
    );
    const firstAvailable = contents.find((item) => item.available);

    const selectedContentId = selectedExists
      ? this.data.selectedContentId
      : firstAvailable
        ? firstAvailable.id
        : "";

    this.setData({
      contents: createCatalogContents(contents),
      selectedContentId,
      ...createSelectionState(contents, selectedContentId)
    });
    saveCatalogDraft(this.data.comment, selectedContentId);
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
    const result = await loadContentCatalogResult("book", {
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
        title: "更多书目加载失败",
        icon: "none"
      });
      return;
    }

    const incomingById = new Map(
      result.items.map((item) => [item.id, item])
    );
    const existingIds = new Set(this.data.contents.map((item) => item.id));
    const contents = this.data.contents.map((item) => {
      const incoming = incomingById.get(item.id);

      if (!incoming || (item.available && !incoming.available)) {
        return item;
      }

      return incoming;
    });

    result.items.forEach((item) => {
      if (!existingIds.has(item.id)) {
        contents.push(item);
      }
    });

    const selectedExists = contents.some(
      (item) => item.available && item.id === this.data.selectedContentId
    );
    const firstAvailable = contents.find((item) => item.available);
    const selectedContentId = selectedExists
      ? this.data.selectedContentId
      : firstAvailable
        ? firstAvailable.id
        : "";

    this.catalogHasMore = result.hasMore;
    this.catalogNextOffset = result.nextOffset;
    this.setData({
      contents: createCatalogContents(contents),
      selectedContentId,
      ...createSelectionState(contents, selectedContentId)
    });
    saveCatalogDraft(this.data.comment, selectedContentId);
  },

  openContent(event) {
    const contentId = event.currentTarget.dataset.id;
    const content = this.data.contents.find((item) => item.id === contentId);

    if (!content || !content.available) {
      wx.showToast({
        title: "正式内容尚未录入",
        icon: "none"
      });
      return;
    }

    this.setData({
      selectedContentId: contentId,
      ...createSelectionState(this.data.contents, contentId)
    });
    saveCatalogDraft(this.data.comment, contentId);
    this.readStateRefreshPending = true;

    wx.navigateTo({
      url: `/pages/bookText/bookText?id=${encodeURIComponent(contentId)}`,
      fail: () => {
        this.readStateRefreshPending = false;
      }
    });
  },

  openAudio(event) {
    const contentId = event.currentTarget.dataset.id;
    const content = this.data.contents.find((item) => item.id === contentId);

    if (!content || !content.available || !content.audioAvailable) {
      wx.showToast({
        title: "配音资源尚未接入",
        icon: "none"
      });
      return;
    }

    this.setData({
      selectedContentId: contentId,
      ...createSelectionState(this.data.contents, contentId)
    });
    saveCatalogDraft(this.data.comment, contentId);

    wx.navigateTo({
      url: `/pages/bookAudio/bookAudio?id=${encodeURIComponent(contentId)}`
    });
  },

  onCommentInput(event) {
    const comment = event.detail.value;

    this.setData({
      comment,
      commentLength: Array.from(comment.trim()).length,
      submitted: false,
      reviewPending: false
    });
    saveCatalogDraft(comment, this.data.selectedContentId);
  },

  async submitComment() {
    if (this.data.submitting || this.pageDestroyed) {
      return;
    }

    const content =
      this.data.contents.find(
        (item) => item.available && item.id === this.data.selectedContentId
      ) || null;
    const comment = this.data.comment.trim();
    const commentLength = Array.from(comment).length;

    if (!content) {
      wx.showToast({
        title: "暂无可提交的内容",
        icon: "none"
      });
      return;
    }

    if (!content.viewed) {
      wx.showToast({
        title: "请先打开当前篇目的正文",
        icon: "none"
      });
      return;
    }

    if (commentLength < 100 || commentLength > 2000) {
      wx.showToast({
        title: "读后感需为100至2000字",
        icon: "none"
      });
      return;
    }

    this.setData({ submitting: true });
    const requestId = (this.submitRequestId || 0) + 1;
    this.submitRequestId = requestId;
    wx.showLoading({
      title: "正在提交",
      mask: true
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "saveRecord",
        data: {
          contentId: content.id,
          comment
        }
      });
      const result = response.result || {};

      if (this.pageDestroyed || requestId !== this.submitRequestId) {
        return;
      }

      if (!result.success) {
        if (
          [
            "NOT_REGISTERED",
            "MEMBER_LOGIN_REQUIRED",
            "MEMBER_SESSION_EXPIRED",
            "ACCOUNT_INACTIVE"
          ].includes(result.code)
        ) {
          saveCatalogDraft(comment, content.id);
          wx.showModal({
            title: result.code === "ACCOUNT_INACTIVE"
              ? "会员账号不可用"
              : "请登录少年会员",
            content: result.message || "提交读后感前，请先登录少年会员。",
            confirmText: "去少年我",
            success: (modalResult) => {
              if (this.pageDestroyed) {
                return;
              }

              if (modalResult.confirm) {
                rememberCatalogCommentIntent(content.id);
                wx.switchTab({ url: "/pages/member/member" });
              }
            }
          });
          return;
        }

        if (result.code === "READ_REQUIRED") {
          const contents = this.data.contents.map((item) =>
            item.id === content.id ? { ...item, viewed: false } : item
          );
          this.setData({
            contents,
            selectedContentViewed: false
          });
          wx.showModal({
            title: "请先阅读正文",
            content: result.message || "提交前需要先打开当前版本正文。",
            showCancel: false
          });
          return;
        }

        if (result.code === "COMMENT_NOT_ALLOWED") {
          this.setData({
            submitted: false,
            needsRevision: true
          });
        }

        wx.showToast({
          title: result.message || "提交失败",
          icon: "none"
        });
        return;
      }

      this.setData({
        comment: "",
        commentLength: 0,
        submitted: !result.requiresReview,
        needsRevision: false,
        reviewPending: Boolean(result.requiresReview)
      });
      clearCatalogDraft();

      if (result.requiresReview) {
        wx.showModal({
          title: "需要人工复审",
          content: "读后感已保存并进入人工复审，复审通过前不会发放红五星或开放全本。",
          showCancel: false
        });
        return;
      }

      wx.showModal({
        title: "提交成功",
        content: result.starAwarded
          ? "阅读记录已保存，已获得50颗红五星，可在“少年我”查看。"
          : "读后感已更新，可在“少年我”查看。",
        showCancel: false
      });
    } catch (error) {
      if (this.pageDestroyed || requestId !== this.submitRequestId) {
        return;
      }

      console.error("submitCatalogComment error:", error);
      wx.showToast({
        title: "提交请求失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
      if (!this.pageDestroyed && requestId === this.submitRequestId) {
        this.setData({ submitting: false });
      }
    }
  },

  openFullBook() {
    const bookId = this.data.selectedBookId;

    if (!bookId) {
      wx.showToast({
        title: "完整书稿尚未配置",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/fullBook/fullBook?bookId=${encodeURIComponent(bookId)}`,
      fail: () => {
        wx.showToast({
          title: "全本阅读页面尚未完成配置",
          icon: "none"
        });
      }
    });
  }
});
