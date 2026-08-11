const { CLOUD_ENV_ID } = require("./config/cloud");

App({
  globalData: {
    memberProfile: null,
    memberProfiles: [],
    canAddMember: true,
    readerNotes: [],
    registrationConsent: null
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("当前基础库不支持云开发");
      return;
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    });
  }
});
