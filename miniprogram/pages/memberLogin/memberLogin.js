const adminContent = require("../../utils/adminContent");

function normalizeMemberId(value) {
  return String(value || "").trim().toUpperCase().slice(0, 40);
}

function shouldPreserveCatalogDraft() {
  try {
    const intent = wx.getStorageSync("pendingMemberIntent");
    const draft = wx.getStorageSync("bookCatalogCommentDraft");
    const contentId = String(
      intent && intent.type === "catalog-comment" ? intent.contentId || "" : ""
    ).trim();

    return Boolean(
      /^[A-Za-z0-9_-]{1,100}$/.test(contentId) &&
        draft &&
        typeof draft === "object" &&
        draft.selectedContentId === contentId &&
        typeof draft.comment === "string" &&
        draft.comment.trim().length > 0 &&
        Array.from(draft.comment.trim()).length <= 2000
    );
  } catch (error) {
    console.warn("inspect catalog draft error:", error);
    return false;
  }
}

function hasAdminUploadAccess(result) {
  const capabilities = adminContent.normalizeCapabilities(result);

  return Boolean(
    result &&
      result.success &&
      result.authorized === true &&
      (capabilities.upload ||
        capabilities.drafts ||
        capabilities.review ||
        capabilities.moderation ||
        capabilities.publish)
  );
}

Page({
  data: {
    loading: true,
    loadError: "",
    profiles: [],
    selectedMemberId: "",
    password: "",
    submitting: false,
    canAddMember: false,
    canManageUploads: false
  },

  onLoad(options = {}) {
    this.isPageVisible = true;
    this.preselectedMemberId = normalizeMemberId(options.memberId);
  },

  onShow() {
    this.isPageVisible = true;
    this.loadProfiles();
    this.checkAdminUploadAccess();
  },

  onHide() {
    this.isPageVisible = false;
    this.requestId = (this.requestId || 0) + 1;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
    this.setData({
      password: "",
      submitting: false,
      canManageUploads: false
    });
  },

  onUnload() {
    this.isPageVisible = false;
    this.requestId = (this.requestId || 0) + 1;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
    this.data.password = "";
    this.data.canManageUploads = false;
  },

  async checkAdminUploadAccess() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      return;
    }

    const requestId = (this.adminAccessRequestId || 0) + 1;
    this.adminAccessRequestId = requestId;
    this.setData({ canManageUploads: false });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "status" }
      });
      const result = response.result || {};

      if (!this.isPageVisible || requestId !== this.adminAccessRequestId) {
        return;
      }

      this.setData({ canManageUploads: hasAdminUploadAccess(result) });
    } catch (error) {
      console.error("check login page admin access error:", error);
    }
  },

  async loadProfiles() {
    const requestId = (this.requestId || 0) + 1;
    this.requestId = requestId;
    this.setData({ loading: true, loadError: "" });

    try {
      const response = await wx.cloud.callFunction({
        name: "login",
        data: { action: "list" }
      });
      const result = response.result || {};

      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      if (!result.success) {
        this.setData({
          loading: false,
          loadError: result.message || "会员列表读取失败"
        });
        return;
      }

      const profiles = Array.isArray(result.profiles) ? result.profiles : [];
      const preselected = profiles.find(
        (profile) => profile.memberId === this.preselectedMemberId
      );
      const currentSelected = profiles.find(
        (profile) => profile.memberId === this.data.selectedMemberId
      );
      const selected = preselected || currentSelected || profiles[0] || null;

      this.setData({
        loading: false,
        profiles,
        selectedMemberId: selected ? selected.memberId : "",
        canAddMember: result.canAddMember === true
      });
    } catch (error) {
      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      console.error("load member profiles error:", error);
      this.setData({
        loading: false,
        loadError: "会员列表读取失败，请检查网络后重试"
      });
    }
  },

  retryLoad() {
    this.loadProfiles();
  },

  selectProfile(event) {
    const memberId = normalizeMemberId(event.currentTarget.dataset.memberId);

    if (this.data.profiles.some((profile) => profile.memberId === memberId)) {
      this.setData({ selectedMemberId: memberId, password: "" });
    }
  },

  onPasswordInput(event) {
    this.setData({ password: String(event.detail.value || "").slice(0, 6) });
  },

  async submitLogin() {
    if (this.data.submitting) {
      return;
    }

    if (!this.data.selectedMemberId) {
      wx.showToast({ title: "请选择少年会员", icon: "none" });
      return;
    }

    if (!/^\d{6}$/.test(this.data.password)) {
      wx.showToast({ title: "请输入6位会员密码", icon: "none" });
      return;
    }

    const requestId = (this.requestId || 0) + 1;
    this.requestId = requestId;
    this.setData({ submitting: true });
    wx.showLoading({ title: "正在登录", mask: true });

    try {
      const response = await wx.cloud.callFunction({
        name: "login",
        data: {
          action: "login",
          memberId: this.data.selectedMemberId,
          password: this.data.password
        }
      });
      const result = response.result || {};

      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      if (!result.success) {
        wx.showToast({
          title: result.message || "会员登录失败",
          icon: "none"
        });
        return;
      }

      const app = getApp();
      app.globalData.memberProfile = result.user || null;
      app.globalData.readerNotes = [];
      try {
        const preserveCatalogDraft = shouldPreserveCatalogDraft();
        wx.removeStorageSync("familyInviteCache");

        if (!preserveCatalogDraft) {
          wx.removeStorageSync("bookCatalogCommentDraft");
        }

        wx.removeStorageSync("summaryReadContentIds");
      } catch (error) {
        console.warn("clear previous member cache error:", error);
      }
      this.setData({ password: "" });

      wx.switchTab({
        url: "/pages/member/member"
      });
    } catch (error) {
      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      console.error("member login error:", error);
      wx.showToast({ title: "登录失败，请检查网络", icon: "none" });
    } finally {
      wx.hideLoading();

      if (this.isPageVisible && requestId === this.requestId) {
        this.setData({ submitting: false });
      }
    }
  },

  goRecovery() {
    const memberId = normalizeMemberId(this.data.selectedMemberId);

    wx.navigateTo({
      url: memberId
        ? `/pages/memberRecovery/memberRecovery?memberId=${encodeURIComponent(
            memberId
          )}`
        : "/pages/memberRecovery/memberRecovery"
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

  goRegister() {
    wx.navigateTo({
      url: "/pages/register1/register1"
    });
  }
});
