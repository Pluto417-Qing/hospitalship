const TOPIC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

Page({
  data: {
    topic: null,
    entries: [],
    loading: true,
    errorCode: "",
    errorMessage: "",
    unlockNotice: "",
    contentLoading: false,
    contentErrorCode: "",
    contentErrorMessage: "",
    hasMore: false,
    nextCursor: null,
    topicRevision: ""
  },

  onLoad(options = {}) {
    this.pageUnloaded = false;
    let topicId = "";

    try {
      topicId = decodeURIComponent(options.id || "").trim();
    } catch (error) {
      topicId = "";
    }

    this.topicId = TOPIC_ID_PATTERN.test(topicId) ? topicId : "";

    if (!this.topicId) {
      this.setData({
        loading: false,
        errorCode: "INVALID_TOPIC_ID",
        errorMessage: "专题编号无效"
      });
      return;
    }

    if (String(options.resume || "") === "1") {
      this.confirmResumedOpen();
    } else {
      this.openTopic();
    }
  },

  onUnload() {
    this.pageUnloaded = true;
    this.openRequestId = (this.openRequestId || 0) + 1;
    this.contentRequestId = (this.contentRequestId || 0) + 1;
    this.openRequestPending = false;
    this.contentRequestPending = false;
    this.memberLoginPromptVisible = false;
  },

  confirmResumedOpen() {
    wx.showModal({
      title: "确认使用当前会员解锁",
      content: "继续后将按专题标价从当前登录会员的红五星中扣取；同一专题只有第一次解锁会扣星。",
      confirmText: "确认打开",
      cancelText: "暂不打开",
      success: (result) => {
        if (this.pageUnloaded) {
          return;
        }

        if (result.confirm) {
          this.openTopic();
        } else {
          this.goBack();
        }
      },
      fail: () => this.goBack()
    });
  },

  async openTopic() {
    if (this.openRequestPending || !this.topicId || this.pageUnloaded) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        loading: false,
        errorCode: "CLOUD_UNAVAILABLE",
        errorMessage: "云服务暂不可用，请稍后重试"
      });
      return;
    }

    const requestId = (this.openRequestId || 0) + 1;
    this.openRequestId = requestId;
    this.openRequestPending = true;
    this.setData({
      loading: true,
      errorCode: "",
      errorMessage: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "specialTopicCenter",
        data: {
          action: "open",
          topicId: this.topicId
        }
      });
      const result = response.result || {};

      if (
        this.pageUnloaded ||
        requestId !== this.openRequestId
      ) {
        return;
      }

      if (!result.success) {
        this.handleOpenFailure(result);
        return;
      }

      const chargedStars = Number(result.chargedStars || 0);
      const topicRevision = String(
        result.topicRevision ||
        (result.topic && result.topic.currentRevision) ||
        ""
      ).trim();

      if (!topicRevision) {
        this.handleOpenFailure({
          code: "TOPIC_REVISION_MISSING",
          message: "专题版本信息缺失，请稍后重试"
        });
        return;
      }

      const unlockNotice = result.firstUnlock
        ? `首次解锁已扣取${chargedStars}颗红五星`
        : "本专题已解锁，本次未扣取红五星";
      const nextCursor = result.nextCursor || {
        entryOffset: 0,
        blockOffset: 0
      };
      this.setData({
        topic: result.topic || null,
        entries: [],
        unlockNotice,
        loading: false,
        contentErrorCode: "",
        contentErrorMessage: "",
        hasMore: result.hasMore !== false,
        nextCursor,
        topicRevision
      });
      wx.showToast({
        title: result.firstUnlock ? `已扣${chargedStars}颗红五星` : "已解锁，本次不扣星",
        icon: "none",
        duration: 2200
      });
      await this.loadContentPage({
        reset: true,
        cursor: nextCursor
      });
    } catch (error) {
      if (
        this.pageUnloaded ||
        requestId !== this.openRequestId
      ) {
        return;
      }

      console.error("open special topic error:", error);
      this.setData({
        errorCode: "TOPIC_REQUEST_FAILED",
        errorMessage: "网络异常，未能打开专题。若刚完成解锁，重试不会再次扣星。"
      });
    } finally {
      if (
        !this.pageUnloaded &&
        requestId === this.openRequestId
      ) {
        this.openRequestPending = false;
        this.setData({ loading: false });
      }
    }
  },

  handleOpenFailure(result) {
    const code = String(result.code || "TOPIC_OPEN_FAILED");

    if (code === "MEMBER_LOGIN_REQUIRED") {
      this.setData({
        errorCode: code,
        errorMessage: result.message || "请先登录少年会员"
      });
      this.requestMemberLogin();
      return;
    }

    if (code === "INSUFFICIENT_STARS") {
      const requiredStars = Number(result.requiredStars || 0);
      const starRemain = Number(result.starRemain || 0);
      this.setData({
        errorCode: code,
        errorMessage: `解锁需要${requiredStars}颗红五星，当前剩余${starRemain}颗。`
      });
      return;
    }

    this.setData({
      errorCode: code,
      errorMessage: result.message || "小专题暂时无法打开"
    });
  },

  async loadContentPage(options = {}) {
    const reset = Boolean(options.reset);
    const cursor = options.cursor || this.data.nextCursor;

    if (
      this.contentRequestPending ||
      this.pageUnloaded ||
      !this.topicId ||
      !this.data.topic ||
      !this.data.topicRevision ||
      (!reset && !this.data.hasMore) ||
      !cursor
    ) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        contentErrorCode: "CLOUD_UNAVAILABLE",
        contentErrorMessage: "云服务暂不可用，请稍后重试"
      });
      return;
    }

    const requestId = (this.contentRequestId || 0) + 1;
    this.contentRequestId = requestId;
    this.contentRequestPending = true;
    this.setData({
      entries: reset ? [] : this.data.entries,
      contentLoading: true,
      contentErrorCode: "",
      contentErrorMessage: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "specialTopicCenter",
        data: {
          action: "readPage",
          topicId: this.topicId,
          expectedRevision: this.data.topicRevision,
          cursor
        }
      });
      const result = response.result || {};

      if (
        this.pageUnloaded ||
        requestId !== this.contentRequestId
      ) {
        return;
      }

      if (!result.success) {
        this.handleContentFailure(result);
        return;
      }

      if (String(result.topicRevision || "") !== this.data.topicRevision) {
        this.handleContentFailure({
          code: "TOPIC_CHANGED_RELOAD",
          message: "专题内容已更新，请重新打开"
        });
        return;
      }

      const pageEntries = Array.isArray(result.entries) ? result.entries : [];
      const previousEntries = reset ? [] : this.data.entries;
      const seen = new Set(previousEntries.map((entry) => entry.id));
      const appendedEntries = pageEntries.filter((entry) => {
        if (!entry || !entry.id || seen.has(entry.id)) {
          return false;
        }

        seen.add(entry.id);
        return true;
      });

      this.setData({
        entries: previousEntries.concat(appendedEntries),
        hasMore: Boolean(result.hasMore),
        nextCursor: result.nextCursor || null
      });
    } catch (error) {
      if (
        this.pageUnloaded ||
        requestId !== this.contentRequestId
      ) {
        return;
      }

      console.error("read special topic page error:", error);
      this.setData({
        contentErrorCode: "TOPIC_PAGE_REQUEST_FAILED",
        contentErrorMessage: "正文加载中断，请重试当前一页。"
      });
    } finally {
      if (
        !this.pageUnloaded &&
        requestId === this.contentRequestId
      ) {
        this.contentRequestPending = false;
        this.setData({ contentLoading: false });
      }
    }
  },

  handleContentFailure(result) {
    const code = String(result.code || "TOPIC_PAGE_LOAD_FAILED");

    if (code === "TOPIC_CHANGED_RELOAD") {
      this.setData({
        entries: [],
        hasMore: false,
        nextCursor: null,
        topicRevision: "",
        contentErrorCode: code,
        contentErrorMessage: "专题内容已更新，请重新打开"
      });
      return;
    }

    this.setData({
      contentErrorCode: code,
      contentErrorMessage: result.message || "专题正文暂时无法加载"
    });

    if (code === "MEMBER_LOGIN_REQUIRED") {
      this.requestMemberLogin();
    }
  },

  requestMemberLogin() {
    if (this.memberLoginPromptVisible || this.pageUnloaded) {
      return;
    }

    this.memberLoginPromptVisible = true;
    wx.showModal({
      title: "请先登录少年会员",
      content: "登录后可继续解锁当前小专题。",
      cancelText: "返回",
      confirmText: "去少年我",
      success: (result) => {
        this.memberLoginPromptVisible = false;

        if (this.pageUnloaded) {
          return;
        }

        if (!result.confirm) {
          this.goBack();
          return;
        }

        if (typeof wx.setStorageSync === "function") {
          wx.setStorageSync("pendingMemberIntent", {
            type: "special-topic",
            topicId: this.topicId,
            createdAt: Date.now()
          });
        }

        wx.switchTab({
          url: "/pages/member/member",
          fail: () => this.goBack()
        });
      },
      fail: () => {
        this.memberLoginPromptVisible = false;
      }
    });
  },

  retryOpen() {
    this.openTopic();
  },

  retryContent() {
    if (this.data.contentErrorCode === "TOPIC_CHANGED_RELOAD") {
      this.setData({
        topic: null,
        entries: [],
        hasMore: false,
        nextCursor: null,
        topicRevision: "",
        contentErrorCode: "",
        contentErrorMessage: "",
        loading: true
      });
      this.openTopic();
      return;
    }

    this.loadContentPage();
  },

  loadMore() {
    this.loadContentPage();
  },

  onReachBottom() {
    this.loadContentPage();
  },

  goBack() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }

    wx.switchTab({ url: "/pages/zhen/zhen" });
  }
});
