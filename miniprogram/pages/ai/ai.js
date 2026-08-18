const PENDING_QUIZ_FOCUS_KEY = "pendingQuizFocus";
const PENDING_QUIZ_FOCUS_TTL_MS = 30 * 60 * 1000;

function normalizeQuestion(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const rawId = String(source.id || source.questionId || "").trim();
  const id = rawId;
  const revision = String(source.revision || "").trim();
  const question = String(source.question || "").trim();
  const options = Array.isArray(source.options)
    ? source.options
        .map((option) => ({
          key: String(option && option.key || "").trim(),
          label: String(option && option.label || "").trim(),
          text: String(option && option.text || "").trim()
        }))
        .filter((option) => option.key && option.text)
    : [];

  if (!id || !revision || !question || options.length < 2) {
    return null;
  }

  return {
    id,
    revision,
    topic: String(source.topic || "").trim(),
    department: String(source.department || "").trim(),
    source: String(source.source || "").trim(),
    question,
    options,
    explanation: String(source.explanation || "").trim(),
    selectedKey: "",
    answered: false,
    isCorrect: false,
    feedback: "",
    showExplanation: false,
    saving: false,
    saveError: "",
    pendingAttemptId: "",
    pendingSelectedKey: ""
  };
}

function createQuestions(source = []) {
  return Array.isArray(source)
    ? source.map(normalizeQuestion).filter(Boolean)
    : [];
}

function createAttemptId(questionId) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `${questionId}:${timestamp}:${random}`;
}

function getCurrentMemberUserId() {
  try {
    const app = getApp();
    const profile = app && app.globalData && app.globalData.memberProfile;
    return profile && typeof profile.userId === "string" ? profile.userId : "";
  } catch (error) {
    return "";
  }
}

function clearAnswerState(question) {
  return {
    ...question,
    selectedKey: "",
    answered: false,
    isCorrect: false,
    feedback: "",
    showExplanation: false,
    saving: false,
    saveError: "",
    pendingAttemptId: "",
    pendingSelectedKey: ""
  };
}

function getNavigationMetrics() {
  const fallbackStatusBarHeight = 20;
  const fallbackNavigationBarHeight = 44;

  try {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : {};
    const menuButton = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : null;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || fallbackStatusBarHeight;
    const navigationBarHeight = menuButton && menuButton.height
      ? (menuButton.top - statusBarHeight) * 2 + menuButton.height
      : fallbackNavigationBarHeight;

    return {
      statusBarHeight,
      navigationBarHeight,
      navigationTotalHeight: statusBarHeight + navigationBarHeight
    };
  } catch (error) {
    return {
      statusBarHeight: fallbackStatusBarHeight,
      navigationBarHeight: fallbackNavigationBarHeight,
      navigationTotalHeight: fallbackStatusBarHeight + fallbackNavigationBarHeight
    };
  }
}

Page({
  data: {
    questions: [],
    loadingQuestions: false,
    questionSource: "cloud",
    sourceNotice: "",
    ...getNavigationMetrics()
  },

  onLoad() {
    this.visibleMemberUserId = getCurrentMemberUserId();
    this.memberEpoch = 0;
    this.loadQuestions();
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 2 });
    }

    const memberUserId = getCurrentMemberUserId();

    if (memberUserId !== this.visibleMemberUserId) {
      this.visibleMemberUserId = memberUserId;
      this.memberEpoch = (this.memberEpoch || 0) + 1;
      this.setData({
        questions: this.data.questions.map(clearAnswerState)
      });
    }

    this.focusPendingQuizQuestion();
  },

  focusPendingQuizQuestion() {
    if (
      typeof wx.getStorageSync !== "function" ||
      typeof wx.removeStorageSync !== "function"
    ) {
      return;
    }

    let focus = null;

    try {
      focus = wx.getStorageSync(PENDING_QUIZ_FOCUS_KEY);
    } catch (error) {
      return;
    }

    const questionId = String(focus && focus.questionId || "").trim();
    const userId = String(focus && focus.userId || "").trim();
    const createdAt = Number(focus && focus.createdAt || 0);
    const currentUserId = getCurrentMemberUserId();
    const valid =
      /^[A-Za-z0-9_-]{1,100}$/.test(questionId) &&
      userId &&
      userId === currentUserId &&
      Number.isFinite(createdAt) &&
      createdAt > 0 &&
      Date.now() - createdAt <= PENDING_QUIZ_FOCUS_TTL_MS &&
      this.data.questions.some((question) => question.id === questionId);

    if (!valid) {
      try {
        wx.removeStorageSync(PENDING_QUIZ_FOCUS_KEY);
      } catch (error) {
        console.warn("清理答题定位失败：", error);
      }
      return;
    }

    try {
      wx.removeStorageSync(PENDING_QUIZ_FOCUS_KEY);
    } catch (error) {
      console.warn("清理答题定位失败：", error);
    }

    const scrollToQuestion = () => {
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: `#question-${questionId}`,
          duration: 250
        });
      }
    };

    if (typeof wx.nextTick === "function") {
      wx.nextTick(scrollToQuestion);
    } else {
      setTimeout(scrollToQuestion, 0);
    }
  },

  async loadQuestions() {
    if (this.questionRequestPending) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        questions: [],
        questionSource: "cloud",
        sourceNotice: "当前无法读取已开放题目，请联网后重试。"
      });
      return;
    }

    this.questionRequestPending = true;
    this.setData({ loadingQuestions: true, sourceNotice: "" });

    try {
      const response = await wx.cloud.callFunction({
        name: "quizCenter",
        data: { action: "list", limit: 50 }
      });
      const result = response.result || {};
      const questions = result.success && Array.isArray(result.questions)
        ? createQuestions(result.questions)
        : [];

      this.setData({
        questions,
        questionSource: "cloud",
        sourceNotice: questions.length === 0
          ? "暂时没有已开放的题目。"
          : ""
      });
    } catch (error) {
      console.error("quiz question list error:", error);
      this.setData({
        questions: [],
        questionSource: "cloud",
        sourceNotice: "题目加载失败，请检查网络后重试。"
      });
    } finally {
      this.questionRequestPending = false;
      this.setData({ loadingQuestions: false });
    }
  },

  goBack() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }

    wx.switchTab({ url: "/pages/index/index" });
  },

  openArticle() {
    wx.navigateTo({
      url: "/pages/article/article?id=esophageal-cancer-story",
      fail: (error) => {
        console.error("进入《食管癌的故事》失败：", error);
        wx.showToast({ title: "文章暂时无法打开", icon: "none" });
      }
    });
  },

  chooseAnswer(event) {
    const { questionId, optionKey } = event.currentTarget.dataset;
    this.submitAnswer(questionId, optionKey);
  },

  retryAnswer(event) {
    const { questionId, optionKey } = event.currentTarget.dataset;
    this.submitAnswer(questionId, optionKey);
  },

  async submitAnswer(questionId, optionKey) {
    const question = this.data.questions.find((item) => item.id === questionId);

    if (!question || question.saving || question.isCorrect) {
      return;
    }

    if (!question.options.some((option) => option.key === optionKey)) {
      return;
    }

    const attemptId =
      question.pendingSelectedKey === optionKey && question.pendingAttemptId
        ? question.pendingAttemptId
        : createAttemptId(question.id);
    const memberEpoch = this.memberEpoch || 0;
    this.updateQuestion(questionId, {
      saving: true,
      saveError: "",
      pendingAttemptId: attemptId,
      pendingSelectedKey: optionKey
    });

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.updateQuestion(questionId, {
        saving: false,
        saveError: "当前无法联网保存，点击这里重试"
      });
      return;
    }

    try {
      const response = await wx.cloud.callFunction({
        name: "quizCenter",
        data: {
          action: "submitAttempt",
          questionId: question.id,
          revision: question.revision,
          selectedKey: optionKey,
          attemptId
        }
      });
      const result = response.result || {};

      if (memberEpoch !== (this.memberEpoch || 0)) {
        return;
      }

      if (!result.success) {
        if (result.code === "MEMBER_LOGIN_REQUIRED") {
          this.updateQuestion(questionId, { saving: false });
          this.requestMemberLogin(questionId);
          return;
        }

        if (
          result.code === "QUESTION_REVISION_CHANGED" ||
          result.code === "QUESTION_NOT_AVAILABLE"
        ) {
          this.updateQuestion(questionId, {
            saving: false,
            saveError: "",
            pendingAttemptId: "",
            pendingSelectedKey: ""
          });
          wx.showToast({
            title: result.message || "题目已更新，正在重新加载",
            icon: "none"
          });
          this.loadQuestions();
          return;
        }

        this.updateQuestion(questionId, {
          saving: false,
          saveError: result.message || "答题记录未保存，点击重试"
        });
        return;
      }

      const isCorrect = Boolean(result.attempt && result.attempt.isCorrect);
      this.updateQuestion(questionId, {
        selectedKey: optionKey,
        answered: true,
        isCorrect,
        feedback: String(result.feedback || ""),
        explanation: String(result.explanation || question.explanation || ""),
        saving: false,
        saveError: "",
        pendingAttemptId: "",
        pendingSelectedKey: ""
      });
    } catch (error) {
      if (memberEpoch !== (this.memberEpoch || 0)) {
        return;
      }

      console.error("quiz attempt save error:", error);
      this.updateQuestion(questionId, {
        saving: false,
        saveError: "网络异常，答题记录未保存，点击重试"
      });
    }
  },

  updateQuestion(questionId, patch) {
    this.setData({
      questions: this.data.questions.map((question) =>
        question.id === questionId ? { ...question, ...patch } : question
      )
    });
  },

  resetAnswer(event) {
    const { questionId } = event.currentTarget.dataset;
    const question = this.data.questions.find((item) => item.id === questionId);

    if (!question || question.isCorrect) {
      return;
    }

    this.updateQuestion(questionId, {
      selectedKey: "",
      answered: false,
      isCorrect: false,
      feedback: ""
    });
  },

  toggleExplanation(event) {
    const { questionId } = event.currentTarget.dataset;
    const question = this.data.questions.find((item) => item.id === questionId);

    if (question) {
      this.updateQuestion(questionId, {
        showExplanation: !question.showExplanation
      });
    }
  },

  requestMemberLogin(questionId) {
    if (this.memberLoginPromptVisible) {
      return;
    }

    this.memberLoginPromptVisible = true;
    wx.showModal({
      title: "请先登录少年会员",
      content: "登录后才能保存每次答题记录。答题不统计总成绩，也不会发放红五星。",
      cancelText: "稍后再说",
      confirmText: "去少年我",
      success: (result) => {
        this.memberLoginPromptVisible = false;

        if (!result.confirm) {
          return;
        }

        if (typeof wx.setStorageSync === "function") {
          wx.setStorageSync("pendingMemberIntent", {
            type: "quiz",
            questionId,
            createdAt: Date.now()
          });
        }

        wx.switchTab({ url: "/pages/member/member" });
      },
      fail: () => {
        this.memberLoginPromptVisible = false;
      }
    });
  }
});
