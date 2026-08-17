const {
  READER_RULES_VERSION,
  REGISTRATION_NOTICE_VERSION
} = require("../../utils/policies");

const RETURN_ROUTES = Object.freeze({
  article: "pages/article/article",
  catalog: "pages/bookCatalog/bookCatalog"
});
const MEMBER_PASSWORD_PATTERN = /^[\u4e00-\u9fa5]{3,5}$/;
const MIN_MEMBER_BIRTH_YEAR = 1949;
const MAX_MEMBER_BIRTH_YEAR = 2049;

function normalizeReturnTo(value) {
  return Object.prototype.hasOwnProperty.call(RETURN_ROUTES, value) ? value : "";
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

function getDestinationCopy(returnTo) {
  if (returnTo === "article") {
    return {
      alreadyRegistered: "当前微信已经注册，是否返回阅读页继续提交？",
      confirmText: "返回阅读"
    };
  }

  if (returnTo === "catalog") {
    return {
      alreadyRegistered: "当前微信已经注册，是否返回书目页继续提交？",
      confirmText: "返回书目"
    };
  }

  return {
    alreadyRegistered: "当前微信已经注册，是否进入会员页面？",
    confirmText: "进入会员"
  };
}

Page({
  data: {
    nickname: "",
    birthYear: "",
    city: "",
    region: [],
    password: "",
    phone: "",
    yearOptions: [],
    submitting: false,
    returnTo: "",
    mode: ""
  },

  onLoad(options = {}) {
    this.pageUnloaded = false;
    const yearOptions = [];

    for (
      let year = MIN_MEMBER_BIRTH_YEAR;
      year <= MAX_MEMBER_BIRTH_YEAR;
      year += 1
    ) {
      yearOptions.push(String(year));
    }

    const returnTo = normalizeReturnTo(options.returnTo);
    const mode = normalizeMode(options.mode);

    this.setData({
      yearOptions,
      returnTo,
      mode
    });

    const app = getApp();
    const consent = app.globalData.registrationConsent || {};

    if (
      consent.noticeVersion !== REGISTRATION_NOTICE_VERSION ||
      consent.rulesVersion !== READER_RULES_VERSION
    ) {
      wx.showToast({
        title: "请从注册第一步开始",
        icon: "none"
      });
      this.returnToFirstStep(returnTo, mode);
    }
  },

  onUnload() {
    this.pageUnloaded = true;
    this.submitRequestId = (this.submitRequestId || 0) + 1;
  },

  returnHome() {
    wx.switchTab({
      url: "/pages/index/index"
    });
  },

  returnToFirstStep(
    returnTo = this.data.returnTo,
    mode = this.data.mode
  ) {
    wx.redirectTo({
      url: withContext("/pages/register1/register1", returnTo, mode),
      fail: (error) => {
        console.error("返回注册第一步失败：", error);
        this.returnHome();
      }
    });
  },

  returnToSecondStep() {
    wx.redirectTo({
      url: withContext(
        "/pages/register2/register2",
        this.data.returnTo,
        this.data.mode
      ),
      fail: (error) => {
        console.error("返回注册第二步失败：", error);
        this.returnToFirstStep();
      }
    });
  },

  finishRegistration() {
    const targetRoute = RETURN_ROUTES[this.data.returnTo];

    if (targetRoute) {
      const pages = getCurrentPages();
      const targetIndex = pages
        .map((page) => page.route)
        .lastIndexOf(targetRoute);
      const delta = pages.length - targetIndex - 1;

      if (targetIndex >= 0 && delta > 0) {
        wx.navigateBack({
          delta,
          fail: () => this.finishRegistrationFallback()
        });
        return;
      }

      this.finishRegistrationFallback();
      return;
    }

    wx.switchTab({
      url: "/pages/member/member"
    });
  },

  finishRegistrationFallback() {
    if (this.data.returnTo === "catalog") {
      wx.redirectTo({
        url: "/pages/bookCatalog/bookCatalog",
        fail: () => this.returnHome()
      });
      return;
    }

    this.returnHome();
  },

  onNicknameInput(event) {
    this.setData({
      nickname: String(event.detail.value || "").replace(/\s+/g, "").slice(0, 5)
    });
  },

  onYearChange(event) {
    const index = Number(event.detail.value);

    this.setData({
      birthYear: this.data.yearOptions[index]
    });
  },

  onRegionChange(event) {
    const region = Array.isArray(event.detail.value) ? event.detail.value : [];

    this.setData({
      region,
      city: region.join(" ")
    });
  },

  onPasswordInput(event) {
    this.setData({
      password: event.detail.value
    });
  },

  onPhoneInput(event) {
    this.setData({
      phone: String(event.detail.value || "").slice(0, 11)
    });
  },

  goPrev() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => this.returnToSecondStep()
      });
      return;
    }

    this.returnToSecondStep();
  },

  validateForm() {
    const {
      nickname,
      birthYear,
      city,
      password,
      phone
    } = this.data;

    if (!/^[\u4e00-\u9fa5]{3,5}$/.test(nickname)) {
      return "会员代号应为3至5位汉字";
    }

    if (!birthYear) {
      return "请选择出生年份";
    }

    if (!city.trim()) {
      return "请选择注册县域";
    }

    if (!MEMBER_PASSWORD_PATTERN.test(password)) {
      return "会员密码应为3至5位汉字";
    }

    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return "请输入正确的监护人手机号";
    }

    return "";
  },

  async submitRegister() {
    if (this.data.submitting || this.pageUnloaded) {
      return;
    }

    const errorMessage = this.validateForm();

    if (errorMessage) {
      wx.showToast({
        title: errorMessage,
        icon: "none"
      });
      return;
    }

    this.setData({
      submitting: true
    });
    const requestId = (this.submitRequestId || 0) + 1;
    this.submitRequestId = requestId;

    wx.showLoading({
      title: "正在注册",
      mask: true
    });

    try {
      const app = getApp();
      const registrationConsent = app.globalData.registrationConsent || {};
      const response = await wx.cloud.callFunction({
        name: "register",
        data: {
          nickname: this.data.nickname,
          birthYear: this.data.birthYear,
          city: this.data.city,
          password: this.data.password,
          phone: this.data.phone,
          addMember: this.data.mode === "addMember",
          consents: {
            noticeVersion: registrationConsent.noticeVersion || "",
            rulesVersion: registrationConsent.rulesVersion || ""
          }
        }
      });

      const result = response.result || {};

      if (this.pageUnloaded || requestId !== this.submitRequestId) {
        return;
      }

      if (!result.success) {
        if (result.code === "ALREADY_REGISTERED") {
          const destinationCopy = getDestinationCopy(this.data.returnTo);

          wx.showModal({
            title: "提示",
            content: destinationCopy.alreadyRegistered,
            confirmText: destinationCopy.confirmText,
            success: (modalResult) => {
              if (this.pageUnloaded) {
                return;
              }

              if (modalResult.confirm) {
                app.globalData.registrationConsent = null;
                this.finishRegistration();
              }
            }
          });
          return;
        }

        wx.showToast({
          title: result.message || "注册失败",
          icon: "none"
        });
        return;
      }

      app.globalData.memberProfile = result.user;
      app.globalData.readerNotes = [];
      app.globalData.registrationConsent = null;

      if (this.data.mode === "addMember") {
        try {
          wx.removeStorageSync("familyInviteCache");
          wx.removeStorageSync("bookCatalogCommentDraft");
          wx.removeStorageSync("summaryReadContentIds");
        } catch (error) {
          console.warn("清除上一会员本机缓存失败：", error);
        }
      }

      const destinationCopy = getDestinationCopy(this.data.returnTo);

      wx.showModal({
        title: "注册成功",
        content: "请妥善保管会员密码。完整会员编号可在“少年我—个人信息”中查看。",
        showCancel: false,
        confirmText: destinationCopy.confirmText,
        success: () => {
          if (!this.pageUnloaded) {
            this.finishRegistration();
          }
        }
      });
    } catch (error) {
      if (this.pageUnloaded || requestId !== this.submitRequestId) {
        return;
      }

      console.error("submitRegister error:", error);

      wx.showToast({
        title: "注册请求失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();

      if (!this.pageUnloaded && requestId === this.submitRequestId) {
        this.setData({
          submitting: false
        });
      }
    }
  }
});
