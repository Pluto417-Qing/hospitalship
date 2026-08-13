const HOME_BANNER_KEYS = [
  "banner02",
  "banner03",
  "banner04",
  "banner05",
  "banner06",
  "banner07",
  "banner08",
  "banner09",
  "banner10",
  "banner11",
  "banner12",
  "banner13",
  "banner14"
];

function normalizeAssetUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";

  return /^(https|cloud):\/\//i.test(url) ? url : "";
}

function createBannerSlots(assets = {}) {
  return HOME_BANNER_KEYS.map((assetKey) => ({
    assetKey,
    url: normalizeAssetUrl(assets[assetKey])
  }));
}

function createHomeAssetState(assets = {}, revision = "") {
  return {
    banners: createBannerSlots(assets),
    bookCovers: {
      rehab: normalizeAssetUrl(assets.bookRehab),
      summary: normalizeAssetUrl(assets.bookSummary)
    },
    homeAssetsRevision: String(revision || "").trim().slice(0, 128)
  };
}

function hasCompleteHomeAssets(state) {
  const banners = state && Array.isArray(state.banners) ? state.banners : [];
  const bookCovers = state && state.bookCovers ? state.bookCovers : {};

  return (
    banners.length === HOME_BANNER_KEYS.length &&
    banners.every((item) => Boolean(item && item.url)) &&
    Boolean(bookCovers.rehab) &&
    Boolean(bookCovers.summary)
  );
}

function getNavigationMetrics() {
  const fallback = {
    statusBarHeight: 20,
    navBarHeight: 44
  };

  try {
    const windowInfo =
      typeof wx.getWindowInfo === "function"
        ? wx.getWindowInfo()
        : typeof wx.getSystemInfoSync === "function"
          ? wx.getSystemInfoSync()
          : {};
    const menuRect =
      typeof wx.getMenuButtonBoundingClientRect === "function"
        ? wx.getMenuButtonBoundingClientRect()
        : null;
    const rawStatusBarHeight = Number(windowInfo.statusBarHeight);
    const statusBarHeight =
      Number.isFinite(rawStatusBarHeight) && rawStatusBarHeight >= 0
        ? rawStatusBarHeight
        : fallback.statusBarHeight;
    const calculatedNavBarHeight =
      menuRect && Number(menuRect.height) > 0
        ? (Number(menuRect.top) - statusBarHeight) * 2 + Number(menuRect.height)
        : fallback.navBarHeight;
    const navBarHeight =
      Number.isFinite(calculatedNavBarHeight) && calculatedNavBarHeight > 0
        ? calculatedNavBarHeight
        : fallback.navBarHeight;

    return {
      statusBarHeight,
      navBarHeight
    };
  } catch (error) {
    console.warn("读取首页导航栏尺寸失败，使用兼容尺寸：", error);
    return fallback;
  }
}

Page({
  data: Object.assign({
    statusBarHeight: 20,
    navBarHeight: 44,
    currentBanner: 0,
    indicators: HOME_BANNER_KEYS.map((_, index) => index)
  }, createHomeAssetState()),

  onLoad() {
    this._homeAssetsLoading = false;
    this._homeAssetsLoaded = false;
    this.setData(getNavigationMetrics());
    this.loadHomeAssets();
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 0 });
    }

    if (!this._homeAssetsLoaded) {
      this.loadHomeAssets();
    }
  },

  onBannerChange(event) {
    this.setData({ currentBanner: event.detail.current });
  },

  async loadHomeAssets() {
    if (
      this._homeAssetsLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }

    this._homeAssetsLoading = true;

    try {
      const response = await wx.cloud.callFunction({
        name: "getContentCatalog",
        data: { action: "homeAssets" }
      });
      const result = response.result || {};

      if (
        !result.success ||
        result.complete !== true ||
        !result.assets ||
        typeof result.assets !== "object"
      ) {
        throw new Error(String(result.message || "首页图片数据不可用"));
      }

      const homeAssetState = createHomeAssetState(result.assets, result.revision);

      if (!hasCompleteHomeAssets(homeAssetState)) {
        throw new Error("首页图片尚未全部就绪");
      }

      this.setData(homeAssetState);
      this._homeAssetsLoaded = true;
    } catch (error) {
      this._homeAssetsLoaded = false;
      console.warn("首页云图片加载失败，暂时显示图片占位：", error);
    } finally {
      this._homeAssetsLoading = false;
    }
  },

  onHeroImageError(event) {
    const index = Number(event.currentTarget.dataset.index);

    if (!Number.isInteger(index) || index < 0 || index >= HOME_BANNER_KEYS.length) {
      return;
    }

    const update = {};
    update[`banners[${index}].url`] = "";
    this._homeAssetsLoaded = false;
    this.setData(update);
  },

  onBookCoverError(event) {
    const key = String(event.currentTarget.dataset.key || "");

    if (key !== "rehab" && key !== "summary") {
      return;
    }

    const update = {};
    update[`bookCovers.${key}`] = "";
    this._homeAssetsLoaded = false;
    this.setData(update);
  },

  openBookCatalog() {
    wx.navigateTo({
      url: "/pages/bookCatalog/bookCatalog"
    });
  },

  openSummary() {
    wx.navigateTo({
      url: "/pages/summary/summary"
    });
  }
});
