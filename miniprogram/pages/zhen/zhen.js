const DEFAULT_LIMIT = 20;

function normalizeTopic(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const id = String(source.id || "").trim();
  const title = String(source.title || "").trim();
  const unlockCostStars = Number(source.unlockCostStars);

  if (
    !id ||
    !title ||
    !Number.isInteger(unlockCostStars) ||
    unlockCostStars <= 0
  ) {
    return null;
  }

  return {
    id,
    title,
    summary: String(source.summary || "").trim(),
    producer: String(source.producer || "").trim(),
    previewCover: String(source.previewCover || "").trim(),
    unlockCostStars,
    unlocked: Boolean(source.unlocked),
    statusText: source.unlocked ? "已解锁" : `${unlockCostStars}颗红五星`
  };
}

Page({
  data: {
    topics: [],
    loading: true,
    loadingMore: false,
    loadError: "",
    sourceUnavailable: false,
    memberLoggedIn: false,
    membershipStatus: "checking",
    hasMore: false
  },

  onShow() {
    this.pageVisible = true;
    this.pageDestroyed = false;
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 3 });
    }

    this.refreshTopics();
  },

  onHide() {
    this.pageVisible = false;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestPending = false;
    this.openingTopic = false;
    this.setData({
      loading: false,
      loadingMore: false
    });
  },

  onUnload() {
    this.pageVisible = false;
    this.pageDestroyed = true;
    this.catalogRequestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestPending = false;
    this.openingTopic = false;
  },

  onReachBottom() {
    this.loadMoreTopics();
  },

  async refreshTopics() {
    if (
      this.catalogRequestPending ||
      !this.pageVisible ||
      this.pageDestroyed
    ) {
      return;
    }

    const requestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestId = requestId;
    this.catalogRequestPending = true;
    this.catalogNextOffset = 0;
    this.setData({
      loading: true,
      loadError: "",
      sourceUnavailable: false,
      membershipStatus: "checking"
    });

    try {
      const result = await this.requestCatalog(0);

      if (
        requestId !== this.catalogRequestId ||
        !this.pageVisible ||
        this.pageDestroyed
      ) {
        return;
      }

      if (!result.success) {
        this.setData({
          topics: [],
          memberLoggedIn: false,
          membershipStatus: "guest",
          hasMore: false,
          loadError: result.message || "小专题目录读取失败"
        });
        return;
      }

      const topics = (result.topics || [])
        .map(normalizeTopic)
        .filter(Boolean)
        .map((topic, index) => ({
          ...topic,
          displayNumber: String(index + 1).padStart(3, "0")
        }));
      this.catalogNextOffset = result.hasMore ? result.nextOffset : null;
      this.setData({
        topics,
        memberLoggedIn: Boolean(result.memberLoggedIn),
        membershipStatus: result.memberLoggedIn ? "member" : "guest",
        hasMore: Boolean(result.hasMore),
        sourceUnavailable: result.source === "unavailable"
      });
    } catch (error) {
      if (
        requestId !== this.catalogRequestId ||
        !this.pageVisible ||
        this.pageDestroyed
      ) {
        return;
      }

      console.error("special topic catalog error:", error);
      this.setData({
        topics: [],
        memberLoggedIn: false,
        membershipStatus: "guest",
        hasMore: false,
        loadError: "网络异常，请稍后重试"
      });
    } finally {
      if (
        requestId === this.catalogRequestId &&
        this.pageVisible &&
        !this.pageDestroyed
      ) {
        this.catalogRequestPending = false;
        this.setData({ loading: false });
      }
    }
  },

  async loadMoreTopics() {
    if (
      this.catalogRequestPending ||
      this.data.loadingMore ||
      !this.pageVisible ||
      this.pageDestroyed ||
      !this.data.hasMore ||
      !Number.isInteger(this.catalogNextOffset)
    ) {
      return;
    }

    const requestId = (this.catalogRequestId || 0) + 1;
    this.catalogRequestId = requestId;
    this.catalogRequestPending = true;
    this.setData({ loadingMore: true });

    try {
      const result = await this.requestCatalog(this.catalogNextOffset);

      if (
        requestId !== this.catalogRequestId ||
        !this.pageVisible ||
        this.pageDestroyed
      ) {
        return;
      }

      if (!result.success) {
        wx.showToast({
          title: result.message || "更多专题读取失败",
          icon: "none"
        });
        return;
      }

      const existingIds = new Set(this.data.topics.map((topic) => topic.id));
      const additions = (result.topics || [])
        .map(normalizeTopic)
        .filter((topic) => topic && !existingIds.has(topic.id))
        .map((topic, index) => ({
          ...topic,
          displayNumber: String(this.data.topics.length + index + 1).padStart(3, "0")
        }));
      this.catalogNextOffset = result.hasMore ? result.nextOffset : null;
      this.setData({
        topics: this.data.topics.concat(additions),
        memberLoggedIn: Boolean(result.memberLoggedIn),
        membershipStatus: result.memberLoggedIn ? "member" : "guest",
        hasMore: Boolean(result.hasMore)
      });
    } catch (error) {
      if (
        requestId !== this.catalogRequestId ||
        !this.pageVisible ||
        this.pageDestroyed
      ) {
        return;
      }

      console.error("load more special topics error:", error);
      wx.showToast({ title: "更多专题读取失败", icon: "none" });
    } finally {
      if (
        requestId === this.catalogRequestId &&
        this.pageVisible &&
        !this.pageDestroyed
      ) {
        this.catalogRequestPending = false;
        this.setData({ loadingMore: false });
      }
    }
  },

  async requestCatalog(offset) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      return {
        success: false,
        message: "云服务暂不可用"
      };
    }

    const response = await wx.cloud.callFunction({
      name: "specialTopicCenter",
      data: {
        action: "list",
        offset,
        limit: DEFAULT_LIMIT
      }
    });

    return response.result || {
      success: false,
      message: "小专题目录读取失败"
    };
  },

  openTopic(event) {
    const topicId = event.currentTarget.dataset.id;
    const topic = this.data.topics.find((item) => item.id === topicId);

    if (
      !topic ||
      this.openingTopic ||
      !this.pageVisible ||
      this.pageDestroyed
    ) {
      return;
    }

    if (!this.data.memberLoggedIn) {
      this.requestMemberLogin(topic);
      return;
    }

    this.openingTopic = true;
    wx.navigateTo({
      url: `/pages/specialTopicDetail/specialTopicDetail?id=${encodeURIComponent(
        topic.id
      )}`,
      complete: () => {
        this.openingTopic = false;
      }
    });
  },

  requestMemberLogin(topic) {
    wx.showModal({
      title: "请先登录少年会员",
      content: `登录后可使用红五星解锁《${topic.title}》。同一专题只在第一次解锁时扣取。`,
      cancelText: "稍后再说",
      confirmText: "去少年我",
      success: (result) => {
        if (!result.confirm) {
          return;
        }

        if (typeof wx.setStorageSync === "function") {
          wx.setStorageSync("pendingMemberIntent", {
            type: "special-topic",
            topicId: topic.id,
            createdAt: Date.now()
          });
        }

        wx.switchTab({ url: "/pages/member/member" });
      }
    });
  }
});
