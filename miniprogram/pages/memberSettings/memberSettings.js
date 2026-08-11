const adminContent = require("../../utils/adminContent");

function normalizeInboxMessages(source) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((item) => {
      const message = item && typeof item === "object" ? item : {};
      const id = typeof message.id === "string" ? message.id.trim() : "";
      const title = typeof message.title === "string" ? message.title.trim() : "";
      const content =
        typeof message.content === "string" ? message.content.trim() : "";

      if (!id || (!title && !content)) {
        return null;
      }

      return {
        id,
        title: title || "会员消息",
        content: content || "暂无消息正文",
        isRead: Boolean(message.isRead)
      };
    })
    .filter(Boolean);
}

function createActionLabel(message) {
  const prefix = message.isRead ? "已读" : "未读";
  const title = Array.from(message.title).slice(0, 24).join("");
  return `${prefix}｜${title}`;
}

function isActionSheetCancel(error) {
  const message = String(error && (error.errMsg || error.message || ""));
  return /cancel/i.test(message);
}

Page({
  data: {
    phone: "",
    canAddMember: true,
    canManageUploads: false,
    adminAccessLoading: false
  },

  onShow() {
    this.isPageVisible = true;
    const app = getApp();
    const memberProfile = app.globalData.memberProfile;

    this.setData({
      phone: memberProfile ? memberProfile.phoneMasked || "" : "",
      canAddMember: app.globalData.canAddMember !== false,
      canManageUploads: false
    });
    this.checkAdminUploadAccess();
  },

  onHide() {
    this.isPageVisible = false;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
    this.setData({
      phone: "",
      canManageUploads: false,
      adminAccessLoading: false
    });
  },

  onUnload() {
    this.isPageVisible = false;
    this.adminAccessRequestId = (this.adminAccessRequestId || 0) + 1;
  },

  async checkAdminUploadAccess() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      return;
    }

    const requestId = (this.adminAccessRequestId || 0) + 1;
    this.adminAccessRequestId = requestId;
    this.setData({ adminAccessLoading: true, canManageUploads: false });

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
            capabilities.publish)
      );

      if (requestId !== this.adminAccessRequestId || !this.isPageVisible) {
        return;
      }

      this.setData({ canManageUploads: authorized });
    } catch (error) {
      console.error("check admin upload access error:", error);
    } finally {
      if (requestId === this.adminAccessRequestId && this.isPageVisible) {
        this.setData({ adminAccessLoading: false });
      }
    }
  },

  showPending(event) {
    const name = event.currentTarget.dataset.name || "该功能";

    if (name === "会员消息") {
      this.openMemberMessages();
      return;
    }

    wx.showToast({
      title: `${name}暂未开放`,
      icon: "none"
    });
  },

  goProfile() {
    wx.navigateTo({
      url: "/pages/memberProfile/memberProfile"
    });
  },

  goAddMember() {
    wx.navigateTo({
      url: "/pages/register1/register1?mode=addMember"
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

  async openMemberMessages({ offset = 0 } = {}) {
    if (this.inboxLoading) {
      wx.showToast({
        title: "会员消息正在加载",
        icon: "none"
      });
      return;
    }

    this.inboxLoading = true;
    wx.showLoading({
      title: "正在读取消息",
      mask: true
    });

    let result = null;
    let requestError = null;

    try {
      const response = await wx.cloud.callFunction({
        name: "memberInbox",
        data: {
          action: "list",
          limit: 5,
          offset
        }
      });
      result = response.result || {};
    } catch (error) {
      console.error("load member inbox error:", error);
      requestError = error;
    } finally {
      this.inboxLoading = false;
      wx.hideLoading();
    }

    if (!this.isPageVisible) {
      return;
    }

    if (requestError || !result || !result.success) {
      wx.showModal({
        title: "会员消息暂不可用",
        content:
          (result && result.message) || "消息读取失败，请检查网络后重试。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    const messages = normalizeInboxMessages(result.messages);
    const nextOffset = Number(result.nextOffset);
    const hasMore = Number.isInteger(nextOffset) && nextOffset > offset;

    if (messages.length === 0) {
      if (hasMore) {
        this.openMemberMessages({ offset: nextOffset });
        return;
      }

      wx.showModal({
        title: "会员消息",
        content: "暂时没有新的会员消息。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    wx.showActionSheet({
      itemList: messages
        .map(createActionLabel)
        .concat(hasMore ? ["查看更多消息"] : []),
      success: (actionResult) => {
        const message = messages[Number(actionResult.tapIndex)];

        if (message) {
          this.openMemberMessage(message);
        } else if (hasMore) {
          this.openMemberMessages({ offset: nextOffset });
        }
      },
      fail: (error) => {
        if (!isActionSheetCancel(error)) {
          console.error("open member inbox action sheet error:", error);
          wx.showToast({
            title: "消息列表打开失败",
            icon: "none"
          });
        }
      }
    });
  },

  async openMemberMessage(message) {
    wx.showLoading({
      title: "正在打开消息",
      mask: true
    });

    let markReadWarning = "";

    try {
      const response = await wx.cloud.callFunction({
        name: "memberInbox",
        data: {
          action: "markRead",
          messageId: message.id
        }
      });
      const result = response.result || {};

      if (!result.success) {
        markReadWarning = result.message || "未能同步已读状态";
      }
    } catch (error) {
      console.error("mark member message read error:", error);
      markReadWarning = "未能同步已读状态";
    } finally {
      wx.hideLoading();
    }

    if (!this.isPageVisible) {
      return;
    }

    wx.showModal({
      title: message.title,
      content: markReadWarning
        ? `${message.content}\n\n（${markReadWarning}）`
        : message.content,
      showCancel: false,
      confirmText: "知道了"
    });
  },

  switchMember() {
    wx.showModal({
      title: "切换少年会员",
      content:
        "继续后将退出当前少年会员，清除本机已解锁内容和临时资料，再选择另一位会员并输入密码登录。",
      confirmText: "退出并切换",
      cancelText: "留在此页",
      success: async (result) => {
        if (result.confirm) {
          await this.performMemberSwitch();
        }
      }
    });
  },

  logout() {
    this.switchMember();
  },

  async performMemberSwitch() {
    wx.showLoading({
      title: "正在退出",
      mask: true
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "login",
        data: {
          action: "logout"
        }
      });
      const result = response.result || {};

      if (!result.success) {
        wx.showToast({
          title: result.message || "退出失败，请稍后重试",
          icon: "none"
        });
        return;
      }

      this.clearLocalSensitiveState();
      wx.redirectTo({
        url: "/pages/memberLogin/memberLogin",
        fail: () => this.returnMember()
      });
    } catch (error) {
      console.error("switch member error:", error);
      wx.showToast({
        title: "退出失败，请检查网络",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  },

  clearLocalSensitiveState() {
    const app = getApp();

    if (app && app.globalData) {
      app.globalData.memberProfile = null;
      app.globalData.readerNotes = [];
      app.globalData.registrationConsent = null;
      app.globalData.memberProfiles = [];
      app.globalData.canAddMember = true;
    }

    try {
      wx.removeStorageSync("familyInviteCache");
      wx.removeStorageSync("pendingFamilyInvite");
      wx.removeStorageSync("pendingMemberIntent");
      wx.removeStorageSync("pendingQuizFocus");
      wx.removeStorageSync("bookCatalogCommentDraft");
      wx.removeStorageSync("summaryReadContentIds");
    } catch (error) {
      console.warn("清除本地临时资料失败：", error);
    }

    this.setData({
      phone: ""
    });
  },

  returnHome() {
    wx.switchTab({
      url: "/pages/index/index"
    });
  },

  returnMember() {
    wx.switchTab({
      url: "/pages/member/member"
    });
  }
});
