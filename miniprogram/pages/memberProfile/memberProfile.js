Page({
  data: {
    loading: true,
    loadError: "",
    user: null
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
      this.setData({ loading: false, user: result.user });
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
  }
});
