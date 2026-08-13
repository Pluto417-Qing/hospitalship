const { registrationRules } = require("../../utils/policies");

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
    loading: true,
    loadError: "",
    user: null,
    registrationRules,
    memberRulesVisible: false
  },

  onShow() {
    this.isPageVisible = true;
    this.loadProfile();
  },

  onHide() {
    this.isPageVisible = false;
    this.requestId = (this.requestId || 0) + 1;
  },

  onUnload() {
    this.isPageVisible = false;
    this.requestId = (this.requestId || 0) + 1;
  },

  async loadProfile() {
    const requestId = (this.requestId || 0) + 1;
    this.requestId = requestId;
    this.setData({ loading: true, loadError: "" });

    try {
      const response = await wx.cloud.callFunction({ name: "getUser" });
      const result = response.result || {};

      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      if (!result.success) {
        this.setData({
          loading: false,
          loadError: result.message || "个人信息读取失败"
        });
        return;
      }

      if (!result.loggedIn || !result.user) {
        wx.showToast({ title: "请先登录少年会员", icon: "none" });
        wx.switchTab({ url: "/pages/member/member" });
        return;
      }

      const app = getApp();
      app.globalData.memberProfile = result.user;
      this.setData({
        loading: false,
        user: result.user,
        memberRulesVisible: false
      });
    } catch (error) {
      if (!this.isPageVisible || requestId !== this.requestId) {
        return;
      }

      console.error("load member profile error:", error);
      this.setData({
        loading: false,
        loadError: "个人信息读取失败，请检查网络后重试"
      });
    }
  },

  retryLoad() {
    this.loadProfile();
  },

  goSettings() {
    wx.navigateTo({
      url: "/pages/memberSettings/memberSettings"
    });
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

  async openMemberMessages({ offset = 0 } = {}) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      wx.showToast({
        title: "会员消息暂不可用",
        icon: "none"
      });
      return;
    }

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

  showMemberRules() {
    this.setData({
      memberRulesVisible: true
    });
  },

  hideMemberRules() {
    this.setData({
      memberRulesVisible: false
    });
  },

  handleLogout() {
    wx.showModal({
      title: "退出登录",
      content: "确定要退出当前账号吗？",
      confirmText: "退出",
      cancelText: "取消",
      success: (res) => {
        if (res.confirm) {
          this.performLogout();
        }
      }
    });
  },

  async performLogout() {
    wx.showLoading({
      title: "正在退出...",
      mask: true
    });

    try {
      // 调用云函数退出登录
      if (wx.cloud && typeof wx.cloud.callFunction === "function") {
        await wx.cloud.callFunction({
          name: "logout"
        });
      }

      // 清除本地缓存
      wx.clearStorageSync();

      wx.hideLoading();

      wx.showToast({
        title: "已退出登录",
        icon: "success",
        duration: 2000
      });

      // 延迟返回并刷新
      setTimeout(() => {
        wx.reLaunch({
          url: "/pages/member/member"
        });
      }, 2000);
    } catch (error) {
      console.error("logout error:", error);
      wx.hideLoading();
      wx.showToast({
        title: "退出失败，请重试",
        icon: "none"
      });
    }
  },

  stopPropagation() {}
});
