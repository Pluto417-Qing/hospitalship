const DEFAULT_LIMIT = 20;

// 强制使用测试数据（开发调试用）
const FORCE_USE_TEST_DATA = true;

// 测试数据
const TEST_TOPICS = [
  {
    id: "test-001",
    title: "《118个元素的发现故事》",
    summary: "从氢到钚，探索元素发现的历史",
    producer: "清华大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-002",
    title: "《中国古代天文学简史》",
    summary: "解读古人观测天象的智慧",
    producer: "北京大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-003",
    title: "《生物多样性保护指南》",
    summary: "了解地球生命的珍贵多样性",
    producer: "复旦大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: true
  },
  {
    id: "test-004",
    title: "《编程入门：从零开始》",
    summary: "计算机编程基础知识普及",
    producer: "浙江大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-005",
    title: "《世界文明简史》",
    summary: "探索人类文明发展的轨迹",
    producer: "南京大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-006",
    title: "《音乐欣赏入门》",
    summary: "感受音乐艺术的魅力",
    producer: "中央音乐学院xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-007",
    title: "《地理大发现的故事》",
    summary: "跟随探险家的脚步看世界",
    producer: "中国人民大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  },
  {
    id: "test-008",
    title: "《数学之美》",
    summary: "发现数学中的美学规律",
    producer: "上海交通大学xxx学生联合编撰",
    unlockCostStars: 10,
    unlocked: false
  }
];

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
    statusText: source.unlocked ? "已下载" : "未下载"
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
      console.log("使用本地测试数据");

      // 使用本地测试数据
      const topics = TEST_TOPICS
        .map(normalizeTopic)
        .filter(Boolean)
        .map((topic, index) => ({
          ...topic,
          displayNumber: String(index + 1).padStart(3, "0")
        }));

      this.setData({
        topics,
        memberLoggedIn: true,
        membershipStatus: "member",
        hasMore: false,
        loadError: "",
        sourceUnavailable: false
      });

      wx.showToast({
        title: "已加载测试数据",
        icon: "none"
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
    // 强制使用测试数据
    if (FORCE_USE_TEST_DATA) {
      throw new Error("使用测试数据（开发模式）");
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      throw new Error("云服务暂不可用");
    }

    try {
      const response = await wx.cloud.callFunction({
        name: "specialTopicCenter",
        data: {
          action: "list",
          offset,
          limit: DEFAULT_LIMIT
        }
      });

      const result = response.result || {};

      // 如果云函数返回失败或空数据，抛出错误以触发测试数据加载
      if (!result.success) {
        throw new Error(result.message || "小专题目录读取失败");
      }

      // 如果返回成功但没有数据，也抛出错误
      if (!result.topics || result.topics.length === 0) {
        throw new Error("暂无专题数据");
      }

      return result;
    } catch (error) {
      throw error;
    }
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
