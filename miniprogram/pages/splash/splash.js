Page({
  onLoad() {
    this.timer = setTimeout(() => {
      wx.switchTab({
        url: "/pages/index/index"
      });
    }, 1500);
  },

  skip() {
    clearTimeout(this.timer);
    wx.switchTab({
      url: "/pages/index/index"
    });
  },

  onUnload() {
    clearTimeout(this.timer);
  }
});
