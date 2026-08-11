const {
  REGISTRATION_NOTICE_VERSION,
  registrationNotice
} = require("../../utils/policies");

const RETURN_TARGETS = new Set(["article", "catalog"]);

function normalizeReturnTo(value) {
  return RETURN_TARGETS.has(value) ? value : "";
}

function normalizeMode(value) {
  return value === "addMember" ? "addMember" : "";
}

function buildQuery(returnTo, mode) {
  const parts = [];

  if (returnTo) {
    parts.push(`returnTo=${encodeURIComponent(returnTo)}`);
  }

  if (mode) {
    parts.push(`mode=${encodeURIComponent(mode)}`);
  }

  return parts.length ? `?${parts.join("&")}` : "";
}

Page({
  data: {
    agreed: false,
    returnTo: "",
    mode: "",
    registrationNotice
  },

  onLoad(options = {}) {
    this.setData({
      returnTo: normalizeReturnTo(options.returnTo),
      mode: normalizeMode(options.mode)
    });
  },

  toggleAgree() {
    this.setData({
      agreed: !this.data.agreed
    })
  },

  goNext() {
    if (!this.data.agreed) {
      wx.showToast({
        title: '请先阅读并勾选同意',
        icon: 'none'
      })
      return
    }

    const app = getApp();
    app.globalData.registrationConsent = {
      ...(app.globalData.registrationConsent || {}),
      noticeVersion: REGISTRATION_NOTICE_VERSION,
      noticeAgreedAt: Date.now()
    };

    const returnQuery = buildQuery(this.data.returnTo, this.data.mode);

    wx.navigateTo({
      url: `/pages/register2/register2${returnQuery}`,
      fail: (error) => {
        console.error("进入注册第二页失败：", error);
        wx.showToast({
          title: "页面跳转失败",
          icon: "none"
        });
      }
    })
  }
})
