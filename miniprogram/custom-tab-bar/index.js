Component({
  data: {
    selected: 0,
    list: [
  {
    pagePath: "/pages/index/index",
    text: "首页",
    iconPath: "/images/tabbar/home-figma.svg",
    color: "#714739",
    flex: 1,
    iconWidth: 54,
    iconHeight: 54,
    iconTop: 16,
    iconScaleX: 1,
    textSize: 20,
    lineWidth: 60
  },
  {
    pagePath: "/pages/zhi/zhi",
    text: "少年志",
    iconPath: "/images/tabbar/zhi-figma.svg",
    color: "#7530AD",
    flex: 1,
    iconWidth: 62,
    iconHeight: 62,
    iconTop: 14,
    iconScaleX: -1,
    textSize: 20,
    lineWidth: 60
  },
  {
    pagePath: "/pages/ai/ai",
    text: "少年爱",
    iconPath: "/images/tabbar/ai-figma.svg",
    color: "#2975A9",
    flex: 1,
    iconWidth: 54,
    iconHeight: 54,
    iconTop: 16,
    iconScaleX: 1,
    textSize: 20,
    lineWidth: 60
  },
  {
    pagePath: "/pages/zhen/zhen",
    text: "少年真",
    iconPath: "/images/tabbar/zhen-figma.svg",
    color: "#C13C33",
    flex: 1,
    iconWidth: 54,
    iconHeight: 54,
    iconTop: 16,
    iconScaleX: 1,
    textSize: 20,
    lineWidth: 60
  },
  {
    pagePath: "/pages/member/member",
    text: "少年我",
    iconPath: "/images/tabbar/wo-figma.svg",
    color: "#037A5A",
    flex: 1,
    iconWidth: 54,
    iconHeight: 54,
    iconTop: 16,
    iconScaleX: 1,
    textSize: 20,
    lineWidth: 60
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
