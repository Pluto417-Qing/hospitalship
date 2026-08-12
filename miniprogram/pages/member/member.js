const adminContent = require("../../utils/adminContent");

function createBadgeSlots(badges) {
  const slots = Array.from({ length: 12 }, (_, index) => ({
    id: `badge-slot-${index}`,
    title: ""
  }));

  badges.slice(0, 12).forEach((badge, index) => {
    slots[index] = {
      ...badge,
      id: badge.id || `badge-earned-${index}`
    };
  });

  return slots;
}

const FAMILY_INVITE_CACHE_KEY = "familyInviteCache";
const PENDING_FAMILY_INVITE_KEY = "pendingFamilyInvite";
const PENDING_MEMBER_INTENT_KEY = "pendingMemberIntent";
const PENDING_QUIZ_FOCUS_KEY = "pendingQuizFocus";
const MEMBER_INTENT_TTL_MS = 30 * 60 * 1000;
const NOTES_PAGE_LIMIT = 20;
const TERMINAL_INVITE_CODES = new Set([
  "INVALID_INVITE",
  "INVITE_EXPIRED",
  "INVITE_USED",
  "SELF_INVITE",
  "INVITE_REISSUE_REQUIRED",
  "INVITER_UNAVAILABLE",
  "FAMILY_LIMIT_REACHED"
]);

function isValidInviteToken(token) {
  return /^[a-f0-9]{64}$/.test(String(token || "").toLowerCase());
}

function readFamilyInviteCache(userId) {
  const expectedUserId = String(userId || "").trim();

  if (!expectedUserId) {
    return null;
  }

  try {
    const cache = wx.getStorageSync(FAMILY_INVITE_CACHE_KEY) || {};
    const token = String(cache.token || "").toLowerCase();
    const expiresAtMs = Number(cache.expiresAtMs || 0);
    const cachedUserId = String(cache.userId || "").trim();

    if (
      cachedUserId === expectedUserId &&
      isValidInviteToken(token) &&
      expiresAtMs > Date.now() + 60 * 1000
    ) {
      return { token, expiresAtMs, userId: cachedUserId };
    }

    clearFamilyInviteCache();
  } catch (error) {
    console.warn("readFamilyInviteCache error:", error);
  }

  return null;
}

function saveFamilyInviteCache(token, expiresAtMs, userId) {
  const normalizedUserId = String(userId || "").trim();

  if (!normalizedUserId) {
    return;
  }

  try {
    wx.setStorageSync(FAMILY_INVITE_CACHE_KEY, {
      token,
      expiresAtMs,
      userId: normalizedUserId
    });
  } catch (error) {
    console.warn("saveFamilyInviteCache error:", error);
  }
}

function clearFamilyInviteCache() {
  try {
    wx.removeStorageSync(FAMILY_INVITE_CACHE_KEY);
  } catch (error) {
    console.warn("clearFamilyInviteCache error:", error);
  }
}

function readPendingFamilyInvite() {
  try {
    const stored = wx.getStorageSync(PENDING_FAMILY_INVITE_KEY);
    if (!stored) {
      return "";
    }

    const token = String(
      stored && typeof stored === "object" ? stored.token || "" : stored || ""
    )
      .trim()
      .toLowerCase();

    if (!isValidInviteToken(token)) {
      clearPendingFamilyInvite();
      return "";
    }

    return token;
  } catch (error) {
    console.warn("readPendingFamilyInvite error:", error);
    return "";
  }
}

function savePendingFamilyInvite(token) {
  if (!isValidInviteToken(token)) {
    return;
  }

  try {
    wx.setStorageSync(PENDING_FAMILY_INVITE_KEY, {
      token: String(token).toLowerCase()
    });
  } catch (error) {
    console.warn("savePendingFamilyInvite error:", error);
  }
}

function clearPendingFamilyInvite() {
  try {
    wx.removeStorageSync(PENDING_FAMILY_INVITE_KEY);
  } catch (error) {
    console.warn("clearPendingFamilyInvite error:", error);
  }
}

function readInviteFromOptions(options) {
  const rawToken = String((options && options.familyInvite) || "");

  try {
    return decodeURIComponent(rawToken).trim().toLowerCase();
  } catch (error) {
    return rawToken.trim().toLowerCase();
  }
}

function normalizeIntentId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : "";
}

function readPendingMemberIntent() {
  try {
    const intent = wx.getStorageSync(PENDING_MEMBER_INTENT_KEY);

    if (!intent || typeof intent !== "object") {
      return null;
    }

    const createdAt = Number(intent.createdAt || 0);

    if (
      !Number.isFinite(createdAt) ||
      createdAt <= 0 ||
      createdAt > Date.now() + 60 * 1000 ||
      Date.now() - createdAt > MEMBER_INTENT_TTL_MS
    ) {
      clearPendingMemberIntent();
      return null;
    }

    return intent;
  } catch (error) {
    console.warn("readPendingMemberIntent error:", error);
    return null;
  }
}

function clearPendingMemberIntent() {
  try {
    wx.removeStorageSync(PENDING_MEMBER_INTENT_KEY);
  } catch (error) {
    console.warn("clearPendingMemberIntent error:", error);
  }
}

Page({
  data: {
    loading: true,
    loadError: "",
    registered: false,
    loggedIn: false,
    profiles: [],
    canAddMember: true,
    user: {},
    badgeSlots: createBadgeSlots([]),
    notePassword: "",
    notesLoading: false,
    familyDialogVisible: false,
    familyLoading: false,
    familyMembers: [],
    familyInviteToken: "",
    familyInviteUserId: "",
    notesUnlocked: false,
    readerNotes: [],
    visibleReaderNotes: [],
    notesExpanded: false,
    canManageUploads: false,
    adminAccessLoading: false
  },

  onLoad(options = {}) {
    this.isPageVisible = true;
    const incomingInvite = readInviteFromOptions(options);

    if (isValidInviteToken(incomingInvite)) {
      savePendingFamilyInvite(incomingInvite);
    } else {
      // Validate and discard a malformed cache even before a member logs in.
      readPendingFamilyInvite();
    }
  },

  onShow() {
    this.isPageVisible = true;
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 4 });
    }

    this.loadMember();
    this.checkAdminUploadAccess();
  },

  onHide() {
    this.isPageVisible = false;
    this.memberRequestId = (this.memberRequestId || 0) + 1;
    this.familyRequestId = (this.familyRequestId || 0) + 1;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
    this.setData({
      canManageUploads: false,
      adminAccessLoading: false
    });
    this.clearSensitiveViewState();
  },

  onUnload() {
    this.isPageVisible = false;
    this.memberRequestId = (this.memberRequestId || 0) + 1;
    this.familyRequestId = (this.familyRequestId || 0) + 1;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
    this.data.canManageUploads = false;
    this.data.adminAccessLoading = false;
    this.clearSensitiveViewState({ updatePage: false });
  },

  onPullDownRefresh() {
    this.loadMember().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  async loadMember() {
    const requestId = (this.memberRequestId || 0) + 1;
    this.memberRequestId = requestId;
    this.clearReaderNotesState();
    this.setData({
      loading: true,
      loadError: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "getUser"
      });

      const result = response.result || {};

      if (requestId !== this.memberRequestId || !this.isPageVisible) {
        return;
      }

      if (!result.success) {
        wx.showToast({
          title: result.message || "读取失败",
          icon: "none"
        });

        this.setData({
          loading: false,
          loadError: result.message || "会员信息读取失败"
        });

        return;
      }

      if (!result.registered) {
        const app = getApp();
        app.globalData.memberProfile = null;
        app.globalData.readerNotes = [];
        app.globalData.memberProfiles = [];
        app.globalData.canAddMember = true;
        clearFamilyInviteCache();

        this.setData({
          loading: false,
          registered: false,
          loggedIn: false,
          profiles: [],
          canAddMember: true,
          user: {},
          badgeSlots: createBadgeSlots([]),
          familyMembers: [],
          familyInviteToken: "",
          familyInviteUserId: "",
          notesUnlocked: false,
          readerNotes: [],
          visibleReaderNotes: [],
          notesExpanded: false
        });

        return;
      }

      const memberLoggedIn =
        result.loggedIn === true ||
        (!Object.prototype.hasOwnProperty.call(result, "loggedIn") &&
          result.user &&
          typeof result.user === "object");

      if (!memberLoggedIn) {
        const app = getApp();
        app.globalData.memberProfile = null;
        app.globalData.readerNotes = [];
        app.globalData.memberProfiles = Array.isArray(result.profiles)
          ? result.profiles
          : [];
        app.globalData.canAddMember = result.canAddMember === true;
        clearFamilyInviteCache();

        this.setData({
          loading: false,
          loadError: "",
          registered: true,
          loggedIn: false,
          profiles: Array.isArray(result.profiles) ? result.profiles : [],
          canAddMember: result.canAddMember === true,
          user: {},
          badgeSlots: createBadgeSlots([]),
          familyMembers: [],
          familyInviteToken: "",
          familyInviteUserId: "",
          notesUnlocked: false,
          readerNotes: [],
          visibleReaderNotes: [],
          notesExpanded: false
        });
        return;
      }

      const app = getApp();
      app.globalData.memberProfile = result.user;
      app.globalData.memberProfiles = Array.isArray(result.profiles)
        ? result.profiles
        : [];
      app.globalData.canAddMember = result.canAddMember === true;

      this.setData({
        loading: false,
        loadError: "",
        registered: true,
        loggedIn: true,
        profiles: Array.isArray(result.profiles) ? result.profiles : [],
        canAddMember: result.canAddMember === true,
        user: result.user,
        badgeSlots: createBadgeSlots(result.user.badges || [])
      });
      this.prepareFamilyInvite({ userId: result.user.userId });
      this.retryPendingFamilyInvite();
      this.consumePendingMemberIntent();
    } catch (error) {
      if (requestId !== this.memberRequestId || !this.isPageVisible) {
        return;
      }

      console.error("loadMember error:", error);

      wx.showToast({
        title: "云函数调用失败",
        icon: "none"
      });

      this.setData({
        loading: false,
        loadError: "云函数调用失败，请检查网络后重试"
      });
    }
  },

  retryLoad() {
    this.loadMember();
    this.checkAdminUploadAccess();
  },

  async checkAdminUploadAccess() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      return;
    }

    const requestId = (this.adminAccessRequestId || 0) + 1;
    this.adminAccessRequestId = requestId;
    this.setData({
      adminAccessLoading: true,
      canManageUploads: false
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "status" }
      });
      const result = response.result || {};
      const capabilities = adminContent.normalizeCapabilities(result);
      const authorized = Boolean(
        result.success &&
          result.authorized === true &&
          (capabilities.upload ||
            capabilities.drafts ||
            capabilities.review ||
            capabilities.moderation ||
            capabilities.publish)
      );

      if (!this.isPageVisible || requestId !== this.adminAccessRequestId) {
        return;
      }

      this.setData({ canManageUploads: authorized });
    } catch (error) {
      console.error("check member page admin access error:", error);
    } finally {
      if (this.isPageVisible && requestId === this.adminAccessRequestId) {
        this.setData({ adminAccessLoading: false });
      }
    }
  },

  goRegister() {
    wx.navigateTo({
      url: "/pages/register1/register1"
    });
  },

  goLogin() {
    wx.navigateTo({
      url: "/pages/memberLogin/memberLogin"
    });
  },

  goAdminUploads() {
    if (!this.data.canManageUploads) {
      return;
    }

    wx.navigateTo({
      url: "/pages/adminUploads/adminUploads"
    });
  },

  goAddMember() {
    if (!this.data.canAddMember) {
      wx.showToast({
        title: "当前微信已管理两位少年会员",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/register1/register1?mode=addMember"
    });
  },

  goProfile() {
    wx.navigateTo({
      url: "/pages/memberProfile/memberProfile"
    });
  },

  goSettings() {
    wx.navigateTo({
      url: "/pages/memberSettings/memberSettings"
    });
  },

  showSearchPending() {
    wx.showToast({
      title: "搜索功能待接入",
      icon: "none"
    });
  },

  consumePendingMemberIntent() {
    if (this.pendingIntentConsuming || !this.data.loggedIn) {
      return;
    }

    const intent = readPendingMemberIntent();

    if (!intent) {
      return;
    }

    let navigation = null;

    if (intent.type === "audio") {
      const page = ["bookAudio", "articleAudio"].includes(intent.page)
        ? intent.page
        : "";
      const contentId = normalizeIntentId(intent.contentId);

      if (page && contentId) {
        navigation = {
          type: "navigateTo",
          url: `/pages/${page}/${page}?id=${encodeURIComponent(contentId)}`
        };
      }
    } else if (intent.type === "text") {
      const page = ["article", "bookText"].includes(intent.page)
        ? intent.page
        : "";
      const contentId = normalizeIntentId(intent.contentId);

      if (page && contentId) {
        navigation = {
          type: "navigateTo",
          url: `/pages/${page}/${page}?id=${encodeURIComponent(contentId)}`
        };
      }
    } else if (intent.type === "special-topic") {
      const topicId = normalizeIntentId(intent.topicId);

      if (topicId) {
        navigation = {
          type: "navigateTo",
          url: `/pages/specialTopicDetail/specialTopicDetail?id=${encodeURIComponent(
            topicId
          )}&resume=1`
        };
      }
    } else if (intent.type === "full-book") {
      const bookId = normalizeIntentId(intent.bookId);

      if (bookId) {
        navigation = {
          type: "navigateTo",
          url: `/pages/fullBook/fullBook?bookId=${encodeURIComponent(bookId)}`
        };
      }
    } else if (intent.type === "quiz") {
      const questionId = normalizeIntentId(intent.questionId);

      navigation = {
        type: "switchTab",
        url: "/pages/ai/ai",
        questionId
      };
    } else if (intent.type === "catalog-comment") {
      const contentId = normalizeIntentId(intent.contentId);

      navigation = {
        type: "navigateTo",
        url: contentId
          ? `/pages/bookCatalog/bookCatalog?contentId=${encodeURIComponent(
              contentId
            )}`
          : "/pages/bookCatalog/bookCatalog"
      };
    }

    if (!navigation) {
      clearPendingMemberIntent();
      return;
    }

    if (navigation.questionId) {
      try {
        wx.setStorageSync(PENDING_QUIZ_FOCUS_KEY, {
          questionId: navigation.questionId,
          userId: normalizeIntentId(this.data.user && this.data.user.userId),
          createdAt: Date.now()
        });
      } catch (error) {
        console.warn("保存答题定位失败：", error);
      }
    }

    this.pendingIntentConsuming = true;
    wx[navigation.type]({
      url: navigation.url,
      success: () => {
        clearPendingMemberIntent();
      },
      fail: (error) => {
        console.error("恢复会员操作失败：", error);
        wx.showToast({
          title: "页面打开失败，请稍后重试",
          icon: "none"
        });
      },
      complete: () => {
        this.pendingIntentConsuming = false;
      }
    });
  },

  onNotePasswordInput(event) {
    this.setData({
      notePassword: event.detail.value
    });
  },

  async openReaderNotes() {
    if (!/^\d{8}$/.test(this.data.notePassword)) {
      wx.showToast({
        title: "请输入6位会员密码",
        icon: "none"
      });
      return;
    }

    if (this.data.notesLoading) {
      return;
    }

    const requestId = (this.notesRequestId || 0) + 1;
    this.notesRequestId = requestId;
    const password = this.data.notePassword;

    this.setData({
      notesLoading: true
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "getNotes",
        data: {
          password,
          offset: 0,
          limit: NOTES_PAGE_LIMIT
        }
      });

      const result = response.result || {};

      if (requestId !== this.notesRequestId || !this.isPageVisible) {
        return;
      }

      if (!result.success) {
        wx.showToast({
          title: result.message || "读取失败",
          icon: "none"
        });
        return;
      }

      const app = getApp();
      const readerNotes = Array.isArray(result.notes) ? result.notes : [];
      const nextOffset = Number(result.nextOffset);
      const notesHasMore =
        result.hasMore === true &&
        Number.isInteger(nextOffset) &&
        nextOffset === readerNotes.length &&
        nextOffset > 0 &&
        nextOffset <= 10000;
      this.noteAccessPassword = notesHasMore ? password : "";
      this.notesNextOffset = notesHasMore ? nextOffset : null;
      this.notesTotal = Number.isInteger(Number(result.total))
        ? Math.max(readerNotes.length, Number(result.total))
        : readerNotes.length;
      app.globalData.readerNotes = [];

      this.setData({
        notePassword: "",
        notesUnlocked: true,
        readerNotes,
        visibleReaderNotes: readerNotes.slice(0, 3),
        notesExpanded: false
      });
    } catch (error) {
      if (requestId !== this.notesRequestId || !this.isPageVisible) {
        return;
      }

      console.error("openReaderNotes error:", error);

      wx.showToast({
        title: "读后感读取失败",
        icon: "none"
      });
    } finally {
      if (requestId === this.notesRequestId && this.isPageVisible) {
        this.setData({
          notesLoading: false
        });
      }
    }
  },

  clearReaderNotesState({ updatePage = true } = {}) {
    this.notesRequestId = (this.notesRequestId || 0) + 1;
    this.noteAccessPassword = "";
    this.notesNextOffset = null;
    this.notesTotal = 0;
    const app = getApp();

    if (app && app.globalData) {
      app.globalData.readerNotes = [];
    }

    const clearedState = {
      notePassword: "",
      notesLoading: false,
      notesUnlocked: false,
      readerNotes: [],
      visibleReaderNotes: [],
      notesExpanded: false
    };

    if (updatePage) {
      this.setData(clearedState);
    } else {
      Object.assign(this.data, clearedState);
    }
  },

  clearSensitiveViewState({ updatePage = true } = {}) {
    this.clearReaderNotesState({ updatePage });
    const clearedState = {
      familyDialogVisible: false,
      familyLoading: false,
      familyMembers: [],
      familyInviteToken: "",
      familyInviteUserId: ""
    };

    if (updatePage) {
      this.setData(clearedState);
    } else {
      Object.assign(this.data, clearedState);
    }
  },

  hideReaderNotes() {
    this.clearReaderNotesState();
  },

  openAllReaderNotes() {
    const readerNotes = this.data.readerNotes.slice();

    if (readerNotes.length === 0) {
      return;
    }

    const notesPayload = {
      notes: readerNotes,
      password: this.noteAccessPassword,
      hasMore:
        Number.isInteger(this.notesNextOffset) &&
        /^\d{8}$/.test(String(this.noteAccessPassword || "")),
      nextOffset: this.notesNextOffset,
      total: this.notesTotal
    };

    wx.navigateTo({
      url: "/pages/readerNotes/readerNotes",
      success: (navigationResult) => {
        const eventChannel = navigationResult.eventChannel;

        if (eventChannel && typeof eventChannel.emit === "function") {
          eventChannel.emit("readerNotes", notesPayload);
        }
      },
      fail: (error) => {
        console.error("打开全部读后感失败：", error);
        wx.showToast({
          title: "读后感页面打开失败",
          icon: "none"
        });
      }
    });
  },

  async prepareFamilyInvite({
    force = false,
    userId = this.data.user && this.data.user.userId
  } = {}) {
    const expectedUserId = String(userId || "").trim();

    if (!expectedUserId) {
      return "";
    }

    if (
      this.familyInvitePromise &&
      this.familyInvitePromiseUserId === expectedUserId
    ) {
      return this.familyInvitePromise;
    }

    if (!force) {
      const cache = readFamilyInviteCache(expectedUserId);

      if (cache) {
        if (
          this.isPageVisible &&
          this.data.user &&
          this.data.user.userId === expectedUserId
        ) {
          this.setData({
            familyInviteToken: cache.token,
            familyInviteUserId: expectedUserId
          });
        }
        return cache.token;
      }
    }

    const invitePromise = wx.cloud
      .callFunction({
        name: "familyCenter",
        data: {
          action: "createInvite"
        }
      })
      .then((response) => {
        const result = response.result || {};
        const inviteToken = String(result.inviteToken || "").toLowerCase();
        const expiresAtMs = Number(result.expiresAtMs || 0);

        if (
          !result.success ||
          !isValidInviteToken(inviteToken) ||
          expiresAtMs <= Date.now() + 60 * 1000
        ) {
          throw new Error(result.message || "亲友邀请生成失败");
        }

        if (
          !this.data.user ||
          this.data.user.userId !== expectedUserId
        ) {
          return "";
        }

        saveFamilyInviteCache(inviteToken, expiresAtMs, expectedUserId);

        if (this.isPageVisible) {
          this.setData({
            familyInviteToken: inviteToken,
            familyInviteUserId: expectedUserId
          });
        }
        return inviteToken;
      })
      .catch((error) => {
        console.error("prepareFamilyInvite error:", error);
        return "";
      });
    this.familyInvitePromise = invitePromise;
    this.familyInvitePromiseUserId = expectedUserId;
    invitePromise.finally(() => {
      if (this.familyInvitePromise === invitePromise) {
        this.familyInvitePromise = null;
        this.familyInvitePromiseUserId = "";
      }
    });

    return invitePromise;
  },

  retryPendingFamilyInvite() {
    const inviteToken = readPendingFamilyInvite();

    if (!inviteToken) {
      return Promise.resolve(null);
    }

    if (this.pendingInvitePromise) {
      return this.pendingInvitePromise;
    }

    this.pendingInvitePromise = this.acceptFamilyInvite(inviteToken).finally(() => {
      this.pendingInvitePromise = null;
    });

    return this.pendingInvitePromise;
  },

  async acceptFamilyInvite(inviteToken) {
    try {
      const response = await wx.cloud.callFunction({
        name: "familyCenter",
        data: {
          action: "acceptInvite",
          inviteToken
        }
      });
      const result = response.result || {};

      if (!result.success) {
        if (TERMINAL_INVITE_CODES.has(result.code)) {
          clearPendingFamilyInvite();
        }

        if (this.isPageVisible) {
          wx.showToast({
            title: result.message || "亲友邀请接受失败",
            icon: "none"
          });
        }
        return result;
      }

      clearPendingFamilyInvite();

      if (this.isPageVisible) {
        wx.showToast({
          title: result.alreadyAccepted ? "已加入该亲友关系" : "亲友关系已建立",
          icon: "none"
        });
      }

      if (this.isPageVisible && this.data.registered) {
        this.loadFamilyMembers();
      }

      return result;
    } catch (error) {
      console.error("acceptFamilyInvite error:", error);

      if (this.isPageVisible) {
        wx.showToast({
          title: "亲友邀请接受失败，请稍后重试",
          icon: "none"
        });
      }

      return {
        success: false,
        code: "INVITE_RETRY_PENDING"
      };
    }
  },

  async loadFamilyMembers() {
    const requestId = (this.familyRequestId || 0) + 1;
    this.familyRequestId = requestId;
    this.setData({
      familyLoading: true
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "familyCenter",
        data: {
          action: "list"
        }
      });
      const result = response.result || {};

      if (requestId !== this.familyRequestId || !this.isPageVisible) {
        return;
      }

      if (!result.success) {
        this.setData({
          familyMembers: []
        });
        wx.showToast({
          title: result.message || "亲友状态读取失败",
          icon: "none"
        });
        return;
      }

      this.setData({
        familyMembers: Array.isArray(result.familyMembers)
          ? result.familyMembers
          : []
      });
    } catch (error) {
      if (requestId !== this.familyRequestId || !this.isPageVisible) {
        return;
      }

      console.error("loadFamilyMembers error:", error);
      this.setData({
        familyMembers: []
      });
      wx.showToast({
        title: "亲友状态读取失败，请稍后重试",
        icon: "none"
      });
    } finally {
      if (requestId === this.familyRequestId && this.isPageVisible) {
        this.setData({
          familyLoading: false
        });
      }
    }
  },

  showFamilyStatus() {
    this.setData({
      familyDialogVisible: true
    });
    this.loadFamilyMembers();
  },

  hideFamilyStatus() {
    this.setData({
      familyDialogVisible: false
    });
  },

  stopPropagation() {},

  onShareAppMessage() {
    const userId = String(
      (this.data.user && this.data.user.userId) || ""
    ).trim();
    const cache = readFamilyInviteCache(userId);
    const inviteToken =
      this.data.familyInviteUserId === userId &&
      isValidInviteToken(this.data.familyInviteToken)
      ? this.data.familyInviteToken
      : cache && cache.token;

    if (!inviteToken) {
      this.prepareFamilyInvite();
      wx.showToast({
        title: "邀请正在准备，请稍后再试",
        icon: "none"
      });
    }

    const shareConfig = {
      title: "邀请你加入《中国医院船》少年会员",
      path: inviteToken
        ? `/pages/member/member?familyInvite=${encodeURIComponent(inviteToken)}`
        : "/pages/member/member"
    };

    if (inviteToken) {
      clearFamilyInviteCache();
      this.setData({ familyInviteToken: "", familyInviteUserId: "" });
      this.prepareFamilyInvite({ force: true, userId });
    }

    return shareConfig;
  }
});
