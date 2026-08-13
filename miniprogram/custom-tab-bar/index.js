Component({
  data: {
    selected: 0,
    list: [
  {
    pagePath: "/pages/index/index",
    text: "首页",
    iconPath: "/images/tabbar/home.png",
    color: "#8A5A44",
    flex: 1, //修改
    iconWidth: 56,
    iconHeight: 72,
    textSize: 25,
    lineWidth: 60
  },
  {
    pagePath: "/pages/zhi/zhi",
    text: "少年志",
    iconPath: "/images/tabbar/zhi.png",
    color: "#7C36C6",
    flex: 1, //修改
    iconWidth: 60,
    iconHeight: 70,
    textSize: 23,
    lineWidth: 54
  },
  {
    pagePath: "/pages/ai/ai",
    text: "少年爱",
    iconPath: "/images/tabbar/ai.png",
    color: "#267EB2",
    flex: 1, //修改
    iconWidth: 50,
    iconHeight: 64,
    textSize: 23,
    lineWidth: 52
  },
  {
    pagePath: "/pages/zhen/zhen",
    text: "少年真",
    iconPath: "/images/tabbar/zhen.png",
    color: "#D94432",
    flex: 1, //修改
    iconWidth: 50,
    iconHeight: 66,
    textSize: 23,
    lineWidth: 54
  },
  {
    pagePath: "/pages/member/member",
    text: "少年我",
    iconPath: "/images/tabbar/wo.png",
    color: "#008867",
    flex: 1, //修改
    iconWidth: 54,
    iconHeight: 70,
    textSize: 25,
    lineWidth: 58
  }
]
  },

  methods: {
    switchTab(event) {
      const { index, path } = event.currentTarget.dataset;

      if (index === this.data.selected) {
        return;
      }

      wx.switchTab({
        url: path,
        success: () => {
          this.setData({ selected: index });
        }
      });
    }
  }
});
