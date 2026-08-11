function normalizeMemberId(value) {
  return String(value || "").trim().toUpperCase().slice(0, 40);
}

Page({
  data: {
    memberId: "",
    phone: "",
    newPassword: "",
    confirmPassword: "",
    submitting: false
  },

  onLoad(options = {}) {
    this.isPageVisible = true;
    this.setData({
      memberId: normalizeMemberId(options.memberId)
    });
  },

  onShow() {
    this.isPageVisible = true;
  },

  onHide() {
    if (this.data.submitting) {
      wx.hideLoading();
    }

    this.isPageVisible = false;
    this.resetRequestId = (this.resetRequestId || 0) + 1;
    this.clearPasswords();
  },

  onUnload() {
    if (this.data.submitting) {
      wx.hideLoading();
    }

    this.isPageVisible = false;
    this.resetRequestId = (this.resetRequestId || 0) + 1;
    this.data.phone = "";
    this.data.newPassword = "";
    this.data.confirmPassword = "";
    this.data.submitting = false;
  },

  onMemberIdInput(event) {
    this.setData({ memberId: normalizeMemberId(event.detail.value) });
  },

  onPhoneInput(event) {
    this.setData({ phone: String(event.detail.value || "").slice(0, 11) });
  },

  onNewPasswordInput(event) {
    this.setData({
      newPassword: String(event.detail.value || "").slice(0, 6)
    });
  },

  onConfirmPasswordInput(event) {
    this.setData({
      confirmPassword: String(event.detail.value || "").slice(0, 6)
    });
  },

  clearPasswords() {
    this.setData({
      phone: "",
      newPassword: "",
      confirmPassword: "",
      submitting: false
    });
  },

  validate() {
    if (!this.data.memberId) {
      return "请输入完整会员编号";
    }

    if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
      return "请输入登记的监护人手机号";
    }

    if (!/^\d{6}$/.test(this.data.newPassword)) {
      return "新密码应为6位数字";
    }

    if (this.data.newPassword !== this.data.confirmPassword) {
      return "两次输入的新密码不一致";
    }

    return "";
  },

  async submitReset() {
    if (this.data.submitting) {
      return;
    }

    const validationError = this.validate();

    if (validationError) {
      wx.showToast({ title: validationError, icon: "none" });
      return;
    }

    const requestId = (this.resetRequestId || 0) + 1;
    const memberId = this.data.memberId;
    const phone = this.data.phone;
    const newPassword = this.data.newPassword;
    this.resetRequestId = requestId;
    this.setData({ submitting: true });
    wx.showLoading({ title: "正在重置", mask: true });

    try {
      const response = await wx.cloud.callFunction({
        name: "login",
        data: {
          action: "resetPassword",
          memberId,
          phone,
          newPassword
        }
      });
      const result = response.result || {};

      if (
        !this.isPageVisible ||
        requestId !== this.resetRequestId
      ) {
        return;
      }

      if (!result.success) {
        wx.showToast({
          title: result.message || "密码重置失败",
          icon: "none"
        });
        return;
      }

      const app = getApp();
      app.globalData.memberProfile = null;
      app.globalData.readerNotes = [];
      try {
        wx.removeStorageSync("familyInviteCache");
        wx.removeStorageSync("bookCatalogCommentDraft");
        wx.removeStorageSync("summaryReadContentIds");
      } catch (error) {
        console.warn("clear reset member cache error:", error);
      }
      this.clearPasswords();
      wx.showModal({
        title: "密码已重置",
        content: "请使用新密码重新登录少年会员。",
        showCancel: false,
        confirmText: "去登录",
        success: () => {
          if (
            this.isPageVisible &&
            requestId === this.resetRequestId
          ) {
            wx.redirectTo({
              url: `/pages/memberLogin/memberLogin?memberId=${encodeURIComponent(
                memberId
              )}`
            });
          }
        }
      });
    } catch (error) {
      if (
        !this.isPageVisible ||
        requestId !== this.resetRequestId
      ) {
        return;
      }

      console.error("reset member password error:", error);
      wx.showToast({ title: "密码重置失败，请检查网络", icon: "none" });
    } finally {
      if (requestId === this.resetRequestId) {
        wx.hideLoading();
      }

      if (
        this.isPageVisible &&
        requestId === this.resetRequestId
      ) {
        this.setData({ submitting: false });
      }
    }
  }
});
