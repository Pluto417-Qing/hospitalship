const {
  READER_RULES_VERSION,
  REGISTRATION_NOTICE_VERSION
} = require("../../utils/policies");

const RETURN_TARGETS = new Set(["article", "catalog"]);

function normalizeReturnTo(value) {
  return RETURN_TARGETS.has(value) ? value : "";
}

function normalizeMode(value) {
  return value === "addMember" ? "addMember" : "";
}

function withContext(url, returnTo, mode) {
  const parts = [];

  if (returnTo) {
    parts.push(`returnTo=${encodeURIComponent(returnTo)}`);
  }

  if (mode) {
    parts.push(`mode=${encodeURIComponent(mode)}`);
  }

  return parts.length ? `${url}?${parts.join("&")}` : url;
}

Page({
  data: {
    agreed: false,
    returnTo: "",
    mode: ""
  },

  onLoad(options = {}) {
    const returnTo = normalizeReturnTo(options.returnTo);
    const mode = normalizeMode(options.mode);

    this.setData({
      returnTo,
      mode
    });

    const app = getApp();
    const consent = app.globalData.registrationConsent || {};

    if (consent.noticeVersion !== REGISTRATION_NOTICE_VERSION) {
      wx.showToast({
        title: "请从注册第一步开始",
        icon: "none"
      });
      this.returnToFirstStep(returnTo, mode);
    }
  },

  returnToFirstStep(
    returnTo = this.data.returnTo,
    mode = this.data.mode
  ) {
    const url = withContext("/pages/register1/register1", returnTo, mode);

    wx.redirectTo({
      url,
      fail: (error) => {
        console.error("返回注册第一步失败：", error);
        wx.switchTab({
          url: "/pages/index/index"
        });
      }
    });
  },

  toggleAgree() {
    this.setData({
      agreed: !this.data.agreed
    });
  },

  goPrev() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => this.returnToFirstStep()
      });
      return;
    }

    this.returnToFirstStep();
  },

  goNext() {
    if (!this.data.agreed) {
      wx.showToast({
        title: "请先阅读并勾选同意",
        icon: "none"
      });
      return;
    }

    const app = getApp();
    app.globalData.registrationConsent = {
      ...(app.globalData.registrationConsent || {}),
      rulesVersion: READER_RULES_VERSION,
      rulesAgreedAt: Date.now()
    };

    wx.navigateTo({
      url: withContext(
        "/pages/register3/register3",
        this.data.returnTo,
        this.data.mode
      ),
      fail: (error) => {
        console.error("进入注册第三页失败：", error);

        wx.showToast({
          title: "页面跳转失败",
          icon: "none"
        });
      }
    });
  }
});
