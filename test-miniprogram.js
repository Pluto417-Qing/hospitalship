const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");
const {
  validateAndConvertClientManifest
} = require("./cloudfunctions/adminContentCenter/clientManifest");

const root = __dirname;
const quietConsole = {
  error() {},
  log() {},
  warn() {}
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createEventChannel() {
  const handlers = new Map();

  return {
    emit(name, payload) {
      const handler = handlers.get(name);
      if (handler) {
        handler(payload);
      }
    },
    on(name, handler) {
      handlers.set(name, handler);
    }
  };
}

function createAudioContext() {
  const handlers = {};

  return {
    autoplay: false,
    currentTime: 0,
    destroyed: false,
    duration: 0,
    paused: true,
    playbackRate: 1,
    seekTarget: null,
    destroy() {
      this.destroyed = true;
    },
    onCanplay(handler) {
      handlers.canplay = handler;
    },
    onEnded(handler) {
      handlers.ended = handler;
    },
    onError(handler) {
      handlers.error = handler;
    },
    onPause(handler) {
      handlers.pause = handler;
    },
    onPlay(handler) {
      handlers.play = handler;
    },
    onTimeUpdate(handler) {
      handlers.timeupdate = handler;
    },
    pause() {
      this.paused = true;
      if (handlers.pause) {
        handlers.pause();
      }
    },
    play() {
      this.paused = false;
      if (handlers.play) {
        handlers.play();
      }
    },
    seek(value) {
      this.seekTarget = value;
      this.currentTime = value;
    }
  };
}

function createDurationProbeContext(durationSeconds, { auto = true } = {}) {
  const handlers = {};
  let source = "";
  const context = {
    autoplay: false,
    destroyed: false,
    duration: 0,
    destroy() {
      this.destroyed = true;
    },
    onCanplay(handler) {
      handlers.canplay = handler;
    },
    onError(handler) {
      handlers.error = handler;
    },
    triggerCanplay() {
      this.duration = durationSeconds;
      if (handlers.canplay) {
        handlers.canplay();
      }
    },
    triggerError() {
      if (handlers.error) {
        handlers.error({ errMsg: "audio metadata failed" });
      }
    }
  };
  Object.defineProperty(context, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return source;
    },
    set(value) {
      source = value;
      if (auto) {
        setImmediate(() => context.triggerCanplay());
      }
    }
  });
  return context;
}

function createWx(options = {}) {
  const storage = options.storage || new Map();
  const calls = {
    cloud: [],
    cloudUploadFile: [],
    chooseMessageFile: [],
    hideLoading: 0,
    modals: [],
    navigateBack: [],
    navigateTo: [],
    redirects: [],
    showActionSheet: [],
    showLoading: [],
    switchTab: [],
    toasts: [],
    uploadFile: []
  };
  const createdAudioContexts = [];
  const eventChannel = options.eventChannel || createEventChannel();
  const wx = {
    cloud: {
      async callFunction(request) {
        calls.cloud.push(request);
        if (options.callFunction) {
          return options.callFunction(request);
        }
        return { result: { success: true } };
      },
      uploadFile(request) {
        calls.cloudUploadFile.push(request);
        if (options.cloudUploadFile) {
          return options.cloudUploadFile(request);
        }

        const task = {
          onProgressUpdate(handler) {
            handler({ progress: 100 });
          }
        };
        setImmediate(() => {
          if (request.fail) {
            request.fail({ errMsg: "cloud.uploadFile must not be used" });
          }
        });
        return task;
      }
    },
    chooseMessageFile(request) {
      calls.chooseMessageFile.push(request);
      if (options.chooseMessageFile) {
        return options.chooseMessageFile(request);
      }
      if (request.fail) {
        request.fail({ errMsg: "chooseMessageFile:fail cancel" });
      }
    },
    uploadFile(request) {
      calls.uploadFile.push(request);
      if (options.uploadFile) {
        return options.uploadFile(request);
      }

      const task = {
        onProgressUpdate(handler) {
          handler({ progress: 100 });
        }
      };
      setImmediate(() => {
        if (request.success) {
          request.success({
            statusCode: 200,
            data: JSON.stringify({
              success: true,
              uploadId: "a".repeat(32),
              status: "uploaded"
            })
          });
        }
      });
      return task;
    },
    createInnerAudioContext() {
      const context = options.createInnerAudioContext
        ? options.createInnerAudioContext()
        : createAudioContext();
      createdAudioContexts.push(context);
      return context;
    },
    getMenuButtonBoundingClientRect:
      options.getMenuButtonBoundingClientRect || (() => ({ height: 32, top: 28 })),
    getStorageSync(key) {
      return storage.get(key);
    },
    getSystemInfoSync: options.getSystemInfoSync,
    getWindowInfo: options.getWindowInfo,
    hideLoading() {
      calls.hideLoading += 1;
    },
    navigateBack(request = {}) {
      calls.navigateBack.push(request);
      if (options.navigateBackFail && request.fail) {
        request.fail(new Error("navigateBack failed"));
      } else if (request.success) {
        request.success({});
      }
    },
    navigateTo(request = {}) {
      calls.navigateTo.push(request);
      if (options.navigateToFail && request.fail) {
        request.fail(new Error("navigateTo failed"));
      } else if (request.success) {
        request.success({ eventChannel });
      }
    },
    redirectTo(request = {}) {
      calls.redirects.push(request);
      if (options.redirectToFail && request.fail) {
        request.fail(new Error("redirectTo failed"));
      } else if (request.success) {
        request.success({});
      }
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    showActionSheet(request = {}) {
      calls.showActionSheet.push(request);
      if (options.actionSheetCancel) {
        if (request.fail) {
          request.fail({ errMsg: "showActionSheet:fail cancel" });
        }
      } else if (request.success) {
        request.success({ tapIndex: options.actionSheetIndex || 0 });
      }
    },
    showLoading(request = {}) {
      calls.showLoading.push(request);
    },
    showModal(request = {}) {
      calls.modals.push(request);
      if (request.success && options.autoConfirmModals !== false) {
        request.success({ cancel: false, confirm: true });
      }
    },
    showToast(request = {}) {
      calls.toasts.push(request);
    },
    stopPullDownRefresh() {},
    switchTab(request = {}) {
      calls.switchTab.push(request);
      if (request.success) {
        request.success({});
      }
    }
  };

  return { calls, createdAudioContexts, eventChannel, storage, wx };
}

function loadPage(relativePath, options = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const localRequire = Module.createRequire(filename);
  let definition = null;
  const sandbox = {
    clearTimeout,
    console: quietConsole,
    decodeURIComponent,
    encodeURIComponent,
    getApp: () => options.app || { globalData: {} },
    getCurrentPages: () =>
      typeof options.getCurrentPages === "function"
        ? options.getCurrentPages()
        : options.pages || [],
    Page(config) {
      definition = config;
    },
    require(request) {
      if (
        options.requireMap &&
        Object.prototype.hasOwnProperty.call(options.requireMap, request)
      ) {
        return options.requireMap[request];
      }
      return localRequire(request);
    },
    setTimeout,
    wx: options.wx
  };

  vm.runInNewContext(source, sandbox, { filename });
  assert(definition, `${relativePath} did not call Page()`);

  const page = { ...definition };
  page.data = JSON.parse(JSON.stringify(definition.data || {}));
  page.getTabBar = page.getTabBar || (() => null);
  page.getOpenerEventChannel =
    options.getOpenerEventChannel || (() => options.eventChannel || null);
  page.setData = function setData(update, callback) {
    Object.assign(this.data, update);
    if (typeof callback === "function") {
      callback();
    }
  };

  return page;
}

const tests = [];

function test(name, handler) {
  tests.push({ handler, name });
}

test("custom tab bar stays declared when component lazy loading is enabled", () => {
  const appConfig = JSON.parse(
    fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8")
  );
  const tabPages = ["index", "zhi", "ai", "zhen", "member"];

  assert.strictEqual(appConfig.lazyCodeLoading, "requiredComponents");
  assert.strictEqual(appConfig.tabBar.custom, true);
  tabPages.forEach((pageName) => {
    const pageConfig = JSON.parse(
      fs.readFileSync(
        path.join(root, `miniprogram/pages/${pageName}/${pageName}.json`),
        "utf8"
      )
    );
    assert.deepStrictEqual(pageConfig.usingComponents, {});
  });
});

test("品牌字样使用设计稿提取的透明书法图片", () => {
  const assetDirectory = path.join(root, "miniprogram/images/brand");
  const expectedAssets = [
    ["china-hospital-ship-vertical.png", 123, 650],
    ["china-hospital-ship-horizontal.png", 257, 62],
    ["china-hospital-ship-horizontal-bracketed.png", 340, 62]
  ];

  expectedAssets.forEach(([fileName, width, height]) => {
    const png = fs.readFileSync(path.join(assetDirectory, fileName));
    assert.strictEqual(png.toString("ascii", 1, 4), "PNG");
    assert.strictEqual(png.readUInt32BE(16), width);
    assert.strictEqual(png.readUInt32BE(20), height);
    assert.strictEqual(png[25], 6, `${fileName} 必须保留 RGBA 透明通道`);
  });

  const splash = fs.readFileSync(
    path.join(root, "miniprogram/pages/splash/splash.wxml"),
    "utf8"
  );
  const index = fs.readFileSync(
    path.join(root, "miniprogram/pages/index/index.wxml"),
    "utf8"
  );
  const catalog = fs.readFileSync(
    path.join(root, "miniprogram/pages/bookCatalog/bookCatalog.wxml"),
    "utf8"
  );

  assert(splash.includes("china-hospital-ship-vertical.png"));
  assert(!splash.includes("wx:for=\"{{characters}}\""));
  assert(index.includes("china-hospital-ship-horizontal.png"));
  assert(catalog.includes("china-hospital-ship-horizontal-bracketed.png"));
  assert(!catalog.includes("《 中 国 医 院 船 》"));
});

test("首页使用安全导航尺寸且指示点数量跟随 banner", () => {
  const harness = createWx({
    getWindowInfo() {
      throw new Error("unsupported");
    }
  });
  const page = loadPage("miniprogram/pages/index/index.js", {
    wx: harness.wx
  });

  page.onLoad();
  assert.strictEqual(page.data.statusBarHeight, 20);
  assert.strictEqual(page.data.navBarHeight, 44);
  assert.strictEqual(page.data.indicators.length, page.data.banners.length);
  assert.deepStrictEqual(
    Array.from(page.data.banners, (banner) => banner.assetKey),
    [
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
    ]
  );
});

test("书目页保存草稿、同步音频目标并记录会员登录回跳意图", async () => {
  const contents = [
    { audioAvailable: true, available: true, id: "content-a", title: "A" },
    {
      audioAvailable: true,
      available: true,
      id: "content-b",
      title: "B",
      viewed: true
    }
  ];
  let submittedData = null;
  const harness = createWx({
    async callFunction(request) {
      submittedData = request.data;
      return {
        result: {
          code: "NOT_REGISTERED",
          message: "请先注册",
          success: false
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/bookCatalog/bookCatalog.js", {
    requireMap: {
      "../../utils/contents": {
        bookContentList: contents,
        loadContentCatalogResult: async () => ({
          hasMore: false,
          items: contents,
          nextOffset: null,
          success: true
        })
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  await flush();
  page.openAudio({ currentTarget: { dataset: { id: "content-b" } } });
  const draft = "读".repeat(100);
  page.onCommentInput({ detail: { value: draft } });
  await page.submitComment();

  assert.strictEqual(page.data.selectedContentId, "content-b");
  assert.strictEqual(submittedData.contentId, "content-b");
  assert.strictEqual(
    harness.storage.get("bookCatalogCommentDraft").comment,
    draft
  );
  const pendingIntent = harness.storage.get("pendingMemberIntent");
  assert.strictEqual(pendingIntent.type, "catalog-comment");
  assert.strictEqual(pendingIntent.contentId, "content-b");
  assert.strictEqual(Number.isFinite(pendingIntent.createdAt), true);
  assert.strictEqual(
    harness.calls.switchTab.some(
      (request) => request.url === "/pages/member/member"
    ),
    true
  );
});

test("正文页和书目页允许2000字读后感并在2001字时本地拒绝", async () => {
  const maximumComment = "读".repeat(2000);
  const tooLongComment = `${maximumComment}读`;
  const successfulResult = {
    requiresReview: false,
    starAwarded: 50,
    success: true
  };

  const articleHarness = createWx({
    async callFunction() {
      return { result: successfulResult };
    }
  });
  const articlePage = loadPage("miniprogram/pages/article/article.js", {
    requireMap: {
      "../../utils/contents": {
        loadContentDetail: async () => null,
        markContentRead: async () => ({ success: true })
      }
    },
    wx: articleHarness.wx
  });
  articlePage.pageUnloaded = false;
  articlePage.setData({
    content: { id: "content-a" },
    readRecorded: true
  });
  articlePage.onCommentInput({ detail: { value: maximumComment } });
  await articlePage.submitComment();

  assert.strictEqual(articleHarness.calls.cloud.length, 1);
  assert.strictEqual(
    Array.from(articleHarness.calls.cloud[0].data.comment).length,
    2000
  );

  articlePage.onCommentInput({ detail: { value: tooLongComment } });
  await articlePage.submitComment();
  assert.strictEqual(articleHarness.calls.cloud.length, 1);
  assert.strictEqual(
    articleHarness.calls.toasts.at(-1).title,
    "读后感需为100至2000字"
  );

  const catalogContent = {
    available: true,
    id: "content-a",
    title: "A",
    viewed: true
  };
  const catalogHarness = createWx({
    async callFunction() {
      return { result: successfulResult };
    }
  });
  const catalogPage = loadPage(
    "miniprogram/pages/bookCatalog/bookCatalog.js",
    {
      requireMap: {
        "../../utils/contents": {
          bookContentList: [catalogContent],
          loadContentCatalogResult: async () => ({
            hasMore: false,
            items: [catalogContent],
            nextOffset: null,
            success: true
          })
        }
      },
      wx: catalogHarness.wx
    }
  );
  catalogPage.pageDestroyed = false;
  catalogPage.onCommentInput({ detail: { value: maximumComment } });
  await catalogPage.submitComment();

  assert.strictEqual(catalogHarness.calls.cloud.length, 1);
  assert.strictEqual(
    Array.from(catalogHarness.calls.cloud[0].data.comment).length,
    2000
  );

  catalogPage.onCommentInput({ detail: { value: tooLongComment } });
  await catalogPage.submitComment();
  assert.strictEqual(catalogHarness.calls.cloud.length, 1);
  assert.strictEqual(
    catalogHarness.calls.toasts.at(-1).title,
    "读后感需为100至2000字"
  );

  for (const relativePath of [
    "miniprogram/pages/article/article.wxml",
    "miniprogram/pages/bookCatalog/bookCatalog.wxml"
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert(source.includes('maxlength="2000"'));
    assert(source.includes("100-2000字"));
  }
});

test("完整书稿登录失效后记录意图并在会员登录后回跳", async () => {
  const storage = new Map();
  const fullBookHarness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "getFullBookAccess");
      return {
        result: {
          code: "MEMBER_SESSION_EXPIRED",
          message: "会员登录已过期",
          success: false
        }
      };
    },
    storage
  });
  const fullBookPage = loadPage("miniprogram/pages/fullBook/fullBook.js", {
    wx: fullBookHarness.wx
  });

  fullBookPage.onLoad({ bookId: "book-one" });
  await flush();
  const pendingIntent = storage.get("pendingMemberIntent");

  assert.strictEqual(pendingIntent.type, "full-book");
  assert.strictEqual(pendingIntent.bookId, "book-one");
  assert.strictEqual(Number.isFinite(pendingIntent.createdAt), true);
  assert.strictEqual(
    fullBookHarness.calls.switchTab.some(
      (request) => request.url === "/pages/member/member"
    ),
    true
  );

  const memberHarness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            loggedIn: true,
            registered: true,
            success: true,
            user: { badges: [], userId: "full-book-member" }
          }
        };
      }

      return { result: { success: true } };
    },
    storage
  });
  const memberPage = loadPage("miniprogram/pages/member/member.js", {
    app: { globalData: { memberProfile: null, readerNotes: [] } },
    wx: memberHarness.wx
  });

  memberPage.onLoad();
  memberPage.onShow();
  await flush();
  await flush();

  assert.strictEqual(
    memberHarness.calls.navigateTo.some(
      (request) => request.url === "/pages/fullBook/fullBook?bookId=book-one"
    ),
    true
  );
  assert.strictEqual(storage.has("pendingMemberIntent"), false);
});

test("个人信息仅在服务端确认管理权限后显示上传入口", async () => {
  const wxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/memberProfile/memberProfile.wxml"),
    "utf8"
  );
  const phoneRowIndex = wxml.indexOf("手机号码");
  const adminEntryIndex = wxml.indexOf("管理员上传界面");

  assert(phoneRowIndex >= 0);
  assert(adminEntryIndex > phoneRowIndex);
  assert(
    wxml.includes(
      'wx:if="{{canManageUploads}}" class="menu-item" bindtap="goAdminUploads"'
    )
  );

  const authorizedStatus = deferred();
  const authorizedHarness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            loggedIn: true,
            success: true,
            user: { phoneMasked: "138****0000" }
          }
        };
      }

      assert.strictEqual(request.name, "adminContentCenter");
      assert.strictEqual(request.data.action, "status");
      return authorizedStatus.promise;
    }
  });
  const authorizedPage = loadPage(
    "miniprogram/pages/memberProfile/memberProfile.js",
    {
      app: { globalData: {} },
      wx: authorizedHarness.wx
    }
  );

  authorizedPage.onShow();
  assert.strictEqual(authorizedPage.data.canManageUploads, false);
  authorizedStatus.resolve({
    result: {
      authorized: true,
      success: true,
      capabilities: { upload: true }
    }
  });
  await flush();
  assert.strictEqual(authorizedPage.data.canManageUploads, true);
  authorizedPage.goAdminUploads();
  assert.strictEqual(
    authorizedHarness.calls.navigateTo.some(
      (request) => request.url === "/pages/adminUploads/adminUploads"
    ),
    true
  );

  const deniedHarness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            loggedIn: true,
            success: true,
            user: { phoneMasked: "138****0000" }
          }
        };
      }

      return {
        result: {
          authorized: false,
          success: true,
          capabilities: { upload: true }
        }
      };
    }
  });
  const deniedPage = loadPage(
    "miniprogram/pages/memberProfile/memberProfile.js",
    {
      app: { globalData: {} },
      wx: deniedHarness.wx
    }
  );

  deniedPage.onShow();
  await flush();
  deniedPage.goAdminUploads();
  assert.strictEqual(deniedPage.data.canManageUploads, false);
  assert.strictEqual(deniedHarness.calls.navigateTo.length, 0);

  const lateStatus = deferred();
  const hiddenHarness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            loggedIn: true,
            success: true,
            user: { phoneMasked: "138****0000" }
          }
        };
      }

      return lateStatus.promise;
    }
  });
  const hiddenPage = loadPage(
    "miniprogram/pages/memberProfile/memberProfile.js",
    {
      app: { globalData: {} },
      wx: hiddenHarness.wx
    }
  );

  hiddenPage.onShow();
  hiddenPage.onHide();
  lateStatus.resolve({
    result: {
      authorized: true,
      success: true,
      capabilities: { upload: true }
    }
  });
  await flush();
  assert.strictEqual(hiddenPage.data.canManageUploads, false);
});

test("会员设置仅在服务端确认管理权限后显示上传入口", async () => {
  const authorizedStatus = deferred();
  const authorizedHarness = createWx({
    callFunction(request) {
      assert.strictEqual(request.name, "adminContentCenter");
      assert.strictEqual(request.data.action, "status");
      return authorizedStatus.promise;
    }
  });
  const authorizedPage = loadPage(
    "miniprogram/pages/memberSettings/memberSettings.js",
    {
      app: {
        globalData: {
          canAddMember: true,
          memberProfile: { phoneMasked: "138****0000" }
        }
      },
      wx: authorizedHarness.wx
    }
  );

  authorizedPage.onShow();
  assert.strictEqual(authorizedPage.data.canManageUploads, false);
  authorizedStatus.resolve({
    result: {
      authorized: true,
      role: "uploader",
      success: true,
      capabilities: {
        drafts: true,
        upload: true,
        transportMode: "https-broker"
      }
    }
  });
  await flush();
  assert.strictEqual(authorizedPage.data.canManageUploads, true);
  authorizedPage.goAdminUploads();
  assert.strictEqual(
    authorizedHarness.calls.navigateTo.some(
      (request) => request.url === "/pages/adminUploads/adminUploads"
    ),
    true
  );

  const deniedHarness = createWx({
    async callFunction() {
      return {
        result: { authorized: false, role: "member", success: true }
      };
    }
  });
  const deniedPage = loadPage("miniprogram/pages/memberSettings/memberSettings.js", {
    app: { globalData: { canAddMember: true, memberProfile: {} } },
    wx: deniedHarness.wx
  });

  deniedPage.onShow();
  await flush();
  deniedPage.goAdminUploads();
  assert.strictEqual(deniedPage.data.canManageUploads, false);
  assert.strictEqual(deniedHarness.calls.navigateTo.length, 0);
});

test("纯管理员无需注册少年会员即可从少年我进入内容中心", async () => {
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            registered: false,
            success: true
          }
        };
      }

      assert.strictEqual(request.name, "adminContentCenter");
      assert.strictEqual(request.data.action, "status");
      return {
        result: {
          authorized: true,
          roles: ["uploader"],
          success: true,
          capabilities: {
            drafts: true,
            upload: false,
            transportMode: "disabled"
          }
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app: {
      globalData: {
        memberProfile: null,
        memberProfiles: [],
        readerNotes: []
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();

  assert.strictEqual(page.data.registered, false);
  assert.strictEqual(page.data.canManageUploads, true);
  page.goAdminUploads();
  assert.strictEqual(
    harness.calls.navigateTo.some(
      (request) => request.url === "/pages/adminUploads/adminUploads"
    ),
    true
  );
});

test("微信管理员可从少年会员登录页直接进入内容上传", async () => {
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "login") {
        assert.strictEqual(request.data.action, "list");
        return {
          result: {
            success: true,
            profiles: [],
            canAddMember: true
          }
        };
      }

      assert.strictEqual(request.name, "adminContentCenter");
      assert.strictEqual(request.data.action, "status");
      return {
        result: {
          authorized: true,
          roles: ["admin"],
          success: true,
          capabilities: {
            drafts: true,
            upload: true,
            transportMode: "https-broker"
          }
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/memberLogin/memberLogin.js", {
    app: { globalData: {} },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();

  assert.deepStrictEqual(Array.from(page.data.profiles), []);
  assert.strictEqual(page.data.canManageUploads, true);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) =>
        request.name === "login" && request.data.action === "login"
    ),
    false
  );
  page.goAdminUploads();
  assert.strictEqual(
    harness.calls.navigateTo.some(
      (request) => request.url === "/pages/adminUploads/adminUploads"
    ),
    true
  );
});

test("少年会员登录页隐藏后忽略晚到的管理员权限响应", async () => {
  const adminStatus = deferred();
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "login") {
        return { result: { success: true, profiles: [] } };
      }

      return adminStatus.promise;
    }
  });
  const page = loadPage("miniprogram/pages/memberLogin/memberLogin.js", {
    app: { globalData: {} },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  page.onHide();
  adminStatus.resolve({
    result: { authorized: true, roles: ["uploader"], success: true }
  });
  await flush();

  assert.strictEqual(page.data.canManageUploads, false);
  page.goAdminUploads();
  assert.strictEqual(harness.calls.navigateTo.length, 0);
});

test("管理员内容入口使用五个业务名称并隐藏全部内部编号", async () => {
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "listUploadTargets") {
        return { result: { success: true, targets: [] } };
      }
      return { result: { success: true } };
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });
  const wxml = fs.readFileSync(
    path.join(root, "miniprogram/pages/adminUploads/adminUploads.wxml"),
    "utf8"
  );

  page.onLoad();
  assert.deepStrictEqual(
    Array.from(page.data.entryCards, (item) => item.title),
    [
      "首页书稿",
      "首页配音",
      "少年志消息",
      "少年爱题目",
      "少年真小专题（Word）"
    ]
  );
  assert.match(page.data.relatedId, /^content-[a-f0-9]{32}$/);

  page.onEntryTap({
    currentTarget: { dataset: { entryId: "zhi-entry" } }
  });
  page.onEntryTap({
    currentTarget: { dataset: { entryId: "quiz-question" } }
  });
  assert.deepStrictEqual(
    harness.calls.navigateTo.map((request) => request.url),
    [
      "/pages/adminEditorial/adminEditorial?type=zhi-entry",
      "/pages/adminEditorial/adminEditorial?type=quiz-question"
    ]
  );

  page.setData({
    authorized: true,
    capabilities: { ...page.data.capabilities, upload: true }
  });
  page.isPageVisible = true;
  page.activateFileEntry("audio");
  await flush();
  await flush();
  assert.strictEqual(page.data.targetSelectionRequired, true);
  assert.strictEqual(
    page.data.emptyTargetMessage,
    "还没有可配音的文章，请先上传并发布首页书稿。"
  );

  page.activateFileEntry("special-topic");
  assert.match(page.data.relatedId, /^topic-[a-f0-9]{32}$/);
  page.activateFileEntry("manuscript");
  page.onManuscriptStepTap({
    currentTarget: { dataset: { step: "pdf" } }
  });
  assert.strictEqual(page.data.entryCards.length, 5);
  assert.strictEqual(page.data.selectedEntryId, "manuscript");
  assert.strictEqual(page.data.selectedAssetType, "full-book-pdf");
  assert.strictEqual(page.data.manuscriptStep, "pdf");
  assert.strictEqual(page.data.relatedId, "china-hospital-ship");
  assert.strictEqual(page.data.selectedTargetTitle, "《中国医院船》");
  assert.strictEqual(page.data.fileDisplayType, "PDF 文档");
  assert.strictEqual(page.data.fileFormatHint, "仅支持 PDF 格式");
  assert.strictEqual(wxml.includes("Word 正文"), true);
  assert.strictEqual(wxml.includes("下载版 PDF"), true);
  assert.strictEqual(wxml.includes("{{item.relatedId}}"), false);
  assert.strictEqual(wxml.includes("{{item.targetId}}"), false);
  assert.strictEqual(wxml.includes("bookId"), false);
  assert.strictEqual(wxml.includes("contentId"), false);
  assert.strictEqual(wxml.includes("mimeType"), false);
  assert.strictEqual(wxml.includes("cloudPath"), false);
});

test("首页书稿同卡上传下载版 PDF 并沿用既有草稿发布流程", async () => {
  const uploadId = "9".repeat(32);
  const publishedDraftId = "8".repeat(32);
  const ownerKey = "7".repeat(24);
  const cloudPath =
    `admin-direct-staging/${ownerKey}/${uploadId}/source.pdf`;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  const uploads = [];
  const harness = createWx({
    async callFunction(request) {
      const action = request.data.action;
      if (action === "status") {
        return {
          result: {
            authorized: true,
            role: "admin",
            success: true,
            capabilities: {
              directClientUpload: true,
              drafts: true,
              upload: true,
              transportMode: "cloud-storage-direct"
            }
          }
        };
      }
      if (action === "listUploads") {
        return {
          result: {
            success: true,
            uploads: uploads.slice(),
            hasMore: false
          }
        };
      }
      if (action === "listDrafts") {
        return {
          result: {
            success: true,
            drafts: [{
              id: publishedDraftId,
              assetType: "full-book-pdf",
              targetId: "china-hospital-ship",
              state: "published",
              payload: { title: "中国医院船" }
            }],
            hasMore: false
          }
        };
      }
      if (action === "createUpload") {
        assert.strictEqual(request.data.assetType, "full-book-pdf");
        assert.strictEqual(request.data.relatedId, "china-hospital-ship");
        assert.strictEqual(request.data.fileName, "中国医院船下载版.pdf");
        assert.strictEqual(request.data.mimeType, "application/pdf");
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(
            request.data,
            "clientDurationSeconds"
          ),
          false
        );
        return {
          result: {
            success: true,
            upload: { id: uploadId },
            uploadTransport: {
              cloudPath,
              directClientUploadAllowed: true,
              mode: "cloud-storage-direct"
            }
          }
        };
      }
      if (action === "confirmUpload") {
        uploads.unshift({
          uploadId,
          fileName: "中国医院船下载版.pdf",
          assetType: "full-book-pdf",
          relatedId: "china-hospital-ship",
          status: "uploaded",
          validationStatus: "admin_attested_unverified"
        });
        return {
          result: {
            success: true,
            canCreateDraft: true,
            upload: {
              id: uploadId,
              status: "uploaded",
              validationStatus: "admin_attested_unverified"
            }
          }
        };
      }
      if (action === "createDraftFromUpload") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "requestId", "uploadId"]
        );
        return {
          result: {
            success: true,
            draft: {
              id: uploadId,
              assetType: "full-book-pdf",
              targetId: "china-hospital-ship",
              state: "editing",
              payload: {
                title: "中国医院船",
                structureMode: "reuse-current"
              }
            }
          }
        };
      }
      throw new Error(`unexpected PDF action: ${action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "中国医院船下载版.pdf",
          path: "wxfile://tmp/china-hospital-ship.pdf",
          size: 1024 * 1024,
          type: "application/pdf"
        }]
      });
    },
    cloudUploadFile(request) {
      assert.strictEqual(request.cloudPath, cloudPath);
      setImmediate(() => request.success({ fileID }));
      return {
        abort() {},
        onProgressUpdate(handler) {
          handler({ progress: 100 });
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  assert.strictEqual(page.data.pdfReadinessTone, "ready");
  assert.strictEqual(page.data.pdfReadinessTitle, "下载版 PDF 已就绪");

  page.onManuscriptStepTap({
    currentTarget: { dataset: { step: "pdf" } }
  });
  assert.strictEqual(page.data.selectedTargetTitle, "《中国医院船》");
  page.chooseFile();
  assert.strictEqual(page.data.selectedFile.fileName, "中国医院船下载版.pdf");
  await page.startUpload();

  assert.strictEqual(page.data.selectedFile, null);
  assert.strictEqual(
    page.data.uploadStageLabel,
    "下载版 PDF 上传完成，可创建草稿"
  );
  assert.strictEqual(page.data.uploadSuccess.includes("不会自动发布"), true);
  assert.strictEqual(
    harness.calls.cloud.some((request) => request.data.action === "publishDraft"),
    false
  );
  assert.strictEqual(
    harness.calls.cloud.some((request) =>
      ["attachClientManifest", "confirmClientImages"].includes(
        request.data.action
      )
    ),
    false
  );

  await page.createOrOpenDraft({
    currentTarget: { dataset: { uploadId } }
  });
  assert.strictEqual(
    harness.calls.navigateTo[harness.calls.navigateTo.length - 1].url,
    `/pages/adminDraft/adminDraft?id=${uploadId}`
  );
});

test("管理员切换书稿步骤后忽略迟到的文件选择响应", () => {
  let chooser = null;
  const harness = createWx({
    chooseMessageFile(request) {
      chooser = request;
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    authorized: true,
    uploadAvailable: true,
    capabilities: { ...page.data.capabilities, upload: true }
  });
  page.chooseFile();
  assert.strictEqual(page.data.fileChoosing, true);
  page.onManuscriptStepTap({
    currentTarget: { dataset: { step: "pdf" } }
  });
  assert.strictEqual(page.data.fileChoosing, false);
  chooser.success({
    tempFiles: [{
      name: "迟到正文.docx",
      path: "wxfile://tmp/late.docx",
      size: 2048
    }]
  });
  assert.strictEqual(page.data.selectedAssetType, "full-book-pdf");
  assert.strictEqual(page.data.selectedFile, null);
});

test("管理员打开系统文件窗口导致页面隐藏后仍接收选择结果", () => {
  let chooser = null;
  const harness = createWx({
    chooseMessageFile(request) {
      chooser = request;
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    authorized: true,
    uploadAvailable: true,
    capabilities: { ...page.data.capabilities, upload: true }
  });
  page.onManuscriptStepTap({
    currentTarget: { dataset: { step: "pdf" } }
  });
  page.chooseFile();
  assert.strictEqual(page.data.fileChoosing, true);

  page.onHide();
  assert.strictEqual(page.data.fileChoosing, true);
  chooser.success({
    tempFiles: [{
      name: "中国医院船下载版.pdf",
      path: "wxfile://tmp/china-hospital-ship.pdf",
      size: 1024,
      type: "application/pdf"
    }]
  });

  assert.strictEqual(page.data.fileChoosing, false);
  assert.strictEqual(page.data.selectedFile.fileName, "中国医院船下载版.pdf");
});

test("管理员选择 Word 返回时即使权限正在刷新也继续本地读取", async () => {
  let chooser = null;
  let parseCalls = 0;
  const statusGate = deferred();
  const harness = createWx({
    chooseMessageFile(request) {
      chooser = request;
    },
    async callFunction(request) {
      if (request.data.action === "status") {
        return statusGate.promise;
      }
      throw new Error(`unexpected action: ${request.data.action}`);
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        async analyzeDocx(filePath, options) {
          parseCalls += 1;
          assert.strictEqual(filePath, "wxfile://tmp/race.docx");
          assert.strictEqual(options.maximumCharacters, 150000);
          return {
            blocks: [{ type: "paragraph", text: "竞态测试正文" }],
            images: [],
            schemaVersion: 1,
            sourceType: "docx",
            stats: {
              extractedBlocks: 1,
              extractedCharacters: 6,
              imageCount: 0,
              totalParagraphs: 1,
              truncated: false
            },
            title: "竞态测试",
            warnings: []
          };
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    authorized: true,
    uploadAvailable: true,
    uploadMode: "cloud-storage-direct",
    capabilities: {
      ...page.data.capabilities,
      directClientUpload: true,
      upload: true,
      transportMode: "cloud-storage-direct"
    }
  });
  page.chooseFile();
  assert.strictEqual(page.data.fileChoosing, true);

  page.onHide();
  page.onShow();
  assert.strictEqual(page.data.uploadMode, "");

  chooser.success({
    tempFiles: [{
      name: "竞态测试.docx",
      path: "wxfile://tmp/race.docx",
      size: 4096,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }]
  });
  await flush();

  assert.strictEqual(parseCalls, 1);
  assert.strictEqual(page.data.fileChoosing, false);
  assert.strictEqual(page.data.localDocumentReady, true);
  assert.ok(page.localDocumentManifest);

  statusGate.resolve({
    result: {
      authorized: true,
      success: true,
      capabilities: {
        directClientUpload: true,
        upload: true,
        transportMode: "cloud-storage-direct"
      }
    }
  });
  await flush();
  await flush();
  assert.strictEqual(page.data.uploadMode, "cloud-storage-direct");
});

test("管理员读取 Word 时页面暂时隐藏不会永久卡在读取中", async () => {
  const parseGate = deferred();
  const harness = createWx({
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "后台读取测试.docx",
          path: "wxfile://tmp/background.docx",
          size: 4096
        }]
      });
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        analyzeDocx() {
          return parseGate.promise;
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    authorized: true,
    uploadAvailable: true,
    uploadMode: "cloud-storage-direct",
    capabilities: {
      ...page.data.capabilities,
      directClientUpload: true,
      upload: true,
      transportMode: "cloud-storage-direct"
    }
  });
  page.chooseFile();
  assert.strictEqual(page.data.localParseLoading, true);

  page.onHide();
  parseGate.resolve({
    blocks: [{ type: "paragraph", text: "后台读取测试正文" }],
    images: [],
    schemaVersion: 1,
    sourceType: "docx",
    stats: {
      extractedBlocks: 1,
      extractedCharacters: 8,
      imageCount: 0,
      totalParagraphs: 1,
      truncated: false
    },
    title: "后台读取测试",
    warnings: []
  });
  await flush();

  assert.strictEqual(page.data.localParseLoading, false);
  assert.strictEqual(page.data.localDocumentReady, true);
  assert.ok(page.localDocumentManifest);
});

test("管理员上传使用无路径契约、失败可重试并确认后仍不自动发布", async () => {
  const history = [
    {
      uploadId: "upload-old",
      fileName: "旧书稿.docx",
      assetType: "manuscript",
      status: "confirmed"
    }
  ];
  const uploadId = "a".repeat(32);
  const brokerUrl = `https://upload.example.com/v1/admin/uploads/${uploadId}`;
  const brokerTicket = "t".repeat(40);
  let uploadAttempts = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            role: "admin",
            success: true,
            capabilities: {
              drafts: true,
              upload: true,
              transportMode: "https-broker"
            }
          }
        };
      }

      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: history.slice() } };
      }

      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }

      if (request.data.action === "createUpload") {
        assert.strictEqual(request.data.assetType, "audio");
        assert.strictEqual(request.data.relatedId, "story-one");
        assert.strictEqual(request.data.fileName, "示范配音.mp3");
        assert.strictEqual(request.data.declaredBytes, 2048);
        assert.strictEqual(request.data.clientDurationSeconds, 95.25);
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(request.data, "size"),
          false
        );
        assert.strictEqual(request.data.mimeType, "audio/mpeg");
        return {
          result: {
            success: true,
            upload: {
              id: uploadId
            },
            uploadTransport: {
              mode: "https-broker",
              url: brokerUrl,
              ticket: brokerTicket,
              fieldName: "contentFile"
            }
          }
        };
      }

      if (request.data.action === "confirmUpload") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "uploadId"]
        );
        assert.strictEqual(request.data.uploadId, uploadId);
        history.unshift({
          uploadId,
          fileName: "示范配音.mp3",
          assetType: "audio",
          relatedId: "story-one",
          status: "confirmed"
        });
        return { result: { success: true } };
      }

      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [
          {
            name: "示范配音.mp3",
            path: "wxfile://tmp/demo.mp3",
            size: 2048,
            type: "audio/mpeg"
          }
        ]
      });
    },
    createInnerAudioContext() {
      return createDurationProbeContext(95.25);
    },
    uploadFile(request) {
      uploadAttempts += 1;
      const attempt = uploadAttempts;
      const task = {
        onProgressUpdate(handler) {
          handler({ progress: attempt === 1 ? 35 : 82 });
        }
      };

      setImmediate(() => {
        if (attempt === 1) {
          request.fail({ errMsg: "uploadFile:fail network down" });
        } else {
          request.success({
            statusCode: 200,
            data: JSON.stringify({
              success: true,
              uploadId,
              status: "uploaded"
            })
          });
        }
      });
      return task;
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  assert.strictEqual(page.data.authorized, true);
  assert.deepStrictEqual(
    Array.from(page.data.uploads, (item) => item.uploadId),
    ["upload-old"]
  );

  page.onAssetTypeChange({ detail: { value: "1" } });
  page.onRelatedIdInput({ detail: { value: "story-one" } });
  page.chooseFile();
  await flush();
  assert.strictEqual(page.data.selectedFile.fileName, "示范配音.mp3");
  assert.strictEqual(page.data.selectedFile.durationSeconds, 95.25);

  const firstAttempt = page.startUpload();
  page.startUpload();
  await firstAttempt;
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(uploadAttempts, 1);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "createUpload"
    ).length,
    1
  );

  await page.retryUpload();
  assert.strictEqual(uploadAttempts, 2);
  assert.strictEqual(page.data.canRetry, false);
  assert.strictEqual(page.data.selectedFile, null);
  assert.strictEqual(page.data.uploadSuccess.includes("不会自动发布"), true);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "createUpload"
    ).length,
    1
  );
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "confirmUpload"
    ).length,
    1
  );
  assert.strictEqual(
    harness.calls.cloud.some((request) => request.data.action === "publish"),
    false
  );
  assert.strictEqual(
    harness.calls.uploadFile[0].url,
    brokerUrl
  );
  assert.strictEqual(harness.calls.uploadFile[0].filePath, "wxfile://tmp/demo.mp3");
  assert.strictEqual(harness.calls.uploadFile[0].name, "contentFile");
  assert.strictEqual(
    harness.calls.uploadFile[0].header.Authorization,
    `Bearer ${brokerTicket}`
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(harness.calls.uploadFile[0], "formData"),
    false
  );
  assert.strictEqual(harness.calls.cloudUploadFile.length, 0);
  assert.strictEqual(page.data.uploads[0].uploadId, uploadId);
});

test("管理员免费直传专题 Word 后上传内嵌图片，全部确认后才可建稿", async () => {
  const uploadId = "b".repeat(32);
  const ownerKey = "c".repeat(24);
  const cloudPath = `admin-direct-staging/${ownerKey}/${uploadId}/source.docx`;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  const imageCloudPath =
    `protected/special-topics/hospital-ship-story/assets/${uploadId}/embedded/0001.png`;
  const imageFileID = `cloud://test-env.bucket/${imageCloudPath}`;
  const history = [];
  let parseOptions = null;
  let imageTransferCalls = 0;
  const attachRequestIds = [];
  const imageTransferGate = deferred();
  const confirmImageRequestIds = [];
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            roles: ["admin"],
            success: true,
            capabilities: {
              directClientUpload: true,
              drafts: true,
              upload: true,
              transportMode: "cloud-storage-direct"
            }
          }
        };
      }

      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: history.slice() } };
      }

      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }

      if (request.data.action === "createUpload") {
        assert.strictEqual(request.data.assetType, "special-topic");
        assert.strictEqual(request.data.fileName, "医院船故事.docx");
        return {
          result: {
            success: true,
            upload: { id: uploadId },
            uploadTransport: {
              directClientUploadAllowed: true,
              mode: "cloud-storage-direct",
              originalFileUploadRequired: false,
              requiresClientManifest: true,
              sourceMode: "client-manifest-only"
            }
          }
        };
      }

      if (request.data.action === "confirmUpload") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "fileID", "uploadId"]
        );
        assert.strictEqual(request.data.uploadId, uploadId);
        assert.strictEqual(request.data.fileID, fileID);
        return {
          result: {
            success: true,
            requiresClientManifest: true,
            upload: {
              id: uploadId,
              status: "uploaded_unverified",
              validationStatus: "awaiting_client_manifest"
            }
          }
        };
      }

      if (request.data.action === "attachClientManifest") {
        assert.strictEqual(request.data.uploadId, uploadId);
        assert.match(request.data.requestId, /^attach-manifest-/);
        attachRequestIds.push(request.data.requestId);
        assert.deepStrictEqual(
          Object.keys(request.data.manifest).sort(),
          ["blocks", "images", "schemaVersion", "sourceType", "stats", "title", "warnings"]
        );
        assert.strictEqual(request.data.manifest.stats.truncated, false);
        assert.strictEqual(
          request.data.manifest.stats.skippedTableOfContentsParagraphs,
          3
        );
        assert.strictEqual(request.data.manifest.images[0].packagePath, "word/media/image1.png");
        assert.strictEqual(
          JSON.stringify(request.data.manifest).includes("imageData"),
          false
        );
        assert.doesNotThrow(() =>
          validateAndConvertClientManifest(
            "special-topic",
            JSON.parse(JSON.stringify(request.data.manifest))
          )
        );
        if (attachRequestIds.length === 1) {
          return {
            result: {
              success: false,
              code: "MANIFEST_RETRY",
              message: "正文清单暂未写入，请重试"
            }
          };
        }
        return {
          result: {
            success: true,
            canCreateDraft: false,
            requiresClientManifest: false,
            requiresClientImages: true,
            imageUploadPlan: [{
              imageOrder: 1,
              packagePath: "word/media/image1.png",
              extension: ".png",
              cloudPath: imageCloudPath
            }],
            upload: {
              id: uploadId,
              status: "uploaded_unverified",
              validationStatus: "awaiting_client_images",
              requiresClientImages: true,
              canCreateDraft: false
            }
          }
        };
      }

      if (request.data.action === "confirmClientImages") {
        assert.deepStrictEqual(
          Object.keys(request.data).sort(),
          ["action", "files", "requestId", "uploadId"]
        );
        assert.strictEqual(request.data.uploadId, uploadId);
        assert.match(request.data.requestId, /^confirm-images-/);
        confirmImageRequestIds.push(request.data.requestId);
        assert.strictEqual(request.data.files.length, 1);
        assert.deepStrictEqual(
          Object.keys(request.data.files[0]).sort(),
          ["cloudPath", "extension", "fileID", "imageOrder", "packagePath"]
        );
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(request.data.files[0])),
          {
            imageOrder: 1,
            packagePath: "word/media/image1.png",
            extension: ".png",
            cloudPath: imageCloudPath,
            fileID: imageFileID
          }
        );
        history.unshift({
          uploadId,
          fileName: "医院船故事.docx",
          assetType: "special-topic",
          relatedId: "hospital-ship-story",
          status: "uploaded",
          validationStatus: "client_manifest_validated"
        });
        return {
          result: {
            success: true,
            alreadyApplied: false,
            confirmedCount: 1,
            totalCount: 1,
            remainingCount: 0,
            complete: true,
            requiresClientImages: false,
            canCreateDraft: true,
            upload: {
              id: uploadId,
              status: "uploaded",
              validationStatus: "client_manifest_validated",
              canCreateDraft: true
            }
          }
        };
      }

      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "医院船故事.docx",
          path: "wxfile://tmp/story.docx",
          size: 4096
        }]
      });
    },
    cloudUploadFile(request) {
      const task = {
        abort() {},
        onProgressUpdate(handler) {
          handler({ progress: 61 });
        }
      };
      setImmediate(() => request.success({ fileID }));
      return task;
    },
    uploadFile() {
      throw new Error("direct cloud mode must not call wx.uploadFile");
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        async analyzeDocx(filePath, options) {
          assert.strictEqual(filePath, "wxfile://tmp/story.docx");
          parseOptions = options;
          return {
            blocks: [
              { type: "heading", level: 1, text: "医院船故事" },
              { type: "paragraph", text: "第一段正文", images: [1] }
            ],
            images: [{
              relationId: "rId5",
              packagePath: "word/media/image1.png",
              extension: ".png",
              order: 1,
              imageData: "must-not-be-forwarded"
            }],
            schemaVersion: 1,
            sourceType: "docx",
            stats: {
              extractedBlocks: 2,
              extractedCharacters: 10,
              imageCount: 1,
              imageReferenceCount: 1,
              inferredHeadingCount: 0,
              omittedImageReferences: 0,
              skippedTableOfContentsParagraphs: 3,
              totalParagraphs: 5,
              unsupportedImageReferences: 0,
              truncated: false
            },
            title: "医院船故事",
            warnings: []
          };
        }
      },
      "./docxImageTransfer": {
        chunkDocxImageFiles(files) {
          return [files];
        },
        createCancellationController() {
          return {
            cancel() {},
            token: { cancelled: false }
          };
        },
        async transferDocxImages(options) {
          imageTransferCalls += 1;
          assert.strictEqual(options.filePath, "wxfile://tmp/story.docx");
          assert.strictEqual(options.concurrency, 2);
          assert.deepStrictEqual(
            JSON.parse(JSON.stringify(options.uploadPlan)),
            [{
              imageOrder: 1,
              packagePath: "word/media/image1.png",
              extension: ".png",
              cloudPath: imageCloudPath
            }]
          );
          const files = [{
            imageOrder: 1,
            packagePath: "word/media/image1.png",
            extension: ".png",
            cloudPath: imageCloudPath,
            fileID: imageFileID
          }];
          if (imageTransferCalls > 1) {
            assert.deepStrictEqual(
              JSON.parse(JSON.stringify(options.existingFiles)),
              files
            );
            options.onProgress({
              phase: "complete",
              completed: 1,
              total: 1,
              percent: 100
            });
            return {
              files,
              total: 1,
              confirmationBatches: [files]
            };
          }
          assert.strictEqual(options.existingFiles.length, 0);
          options.onProgress({
            phase: "uploading",
            completed: 0,
            total: 1,
            percent: 35
          });
          await imageTransferGate.promise;
          const error = new Error("图片网络中断，请重试");
          error.uploadedFiles = files;
          throw error;
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  assert.strictEqual(page.data.uploadAvailable, true);
  assert.strictEqual(page.data.uploadMode, "cloud-storage-direct");

  page.onAssetTypeChange({ detail: { value: "2" } });
  page.onRelatedIdInput({ detail: { value: "hospital-ship-story" } });
  page.chooseFile();
  await flush();
  assert.strictEqual(parseOptions.maximumBlocks, 2000);
  assert.strictEqual(parseOptions.maximumCharacters, 200000);
  assert.strictEqual(page.data.localDocumentReady, true);
  assert.strictEqual(page.data.localParsePreview[0], "医院船故事");
  assert.strictEqual(page.data.localParseWarning.includes("1 张内嵌图片"), true);
  assert.ok(page.localDocumentManifest);
  await page.startUpload();
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(page.data.uploadStageLabel, "Word 正文校验未完成");
  assert.strictEqual(page.data.uploadError, "正文清单暂未写入，请重试");
  const retryPromise = page.retryUpload();
  await flush();
  await flush();
  assert.strictEqual(
    page.data.uploading,
    true,
    JSON.stringify({
      uploadError: page.data.uploadError,
      uploadStageLabel: page.data.uploadStageLabel
    })
  );
  assert.strictEqual(page.data.canRetry, false);
  assert.strictEqual(
    page.data.uploadStageLabel,
    "正在上传内嵌图片（0/1）"
  );
  assert.strictEqual(page.data.uploadError, "");
  assert.ok(page.data.selectedFile);
  assert.strictEqual(page.data.uploads.length, 0);
  assert.strictEqual(imageTransferCalls, 1);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) =>
        ["confirmClientImages", "createDraft", "publishDraft"].includes(
          request.data.action
        )
    ),
    false
  );

  imageTransferGate.resolve();
  await retryPromise;
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(page.data.uploadStageLabel, "内嵌图片上传未完成");
  assert.strictEqual(page.data.uploadError, "图片网络中断，请重试");
  assert.ok(page.data.selectedFile);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => request.data.action === "confirmClientImages"
    ),
    false
  );

  await page.retryUpload();

  assert.strictEqual(
    harness.calls.cloudUploadFile.length,
    0,
    "Word 结构化导入不应重复上传原始 DOCX"
  );
  assert.strictEqual(harness.calls.uploadFile.length, 0);
  assert.strictEqual(
    page.data.uploadStageLabel,
    "正文结构校验完成，可创建内容草稿"
  );
  assert.strictEqual(
    page.data.uploadSuccess.includes("正文及 1 张内嵌图片已校验"),
    true
  );
  assert.strictEqual(
    page.data.uploadSuccess.includes("仍需后续确认"),
    false
  );
  assert.strictEqual(page.data.uploadSuccess.includes("不会自动发布"), true);
  assert.strictEqual(page.data.uploads[0].statusLabel, "已上传，可建草稿");
  assert.strictEqual(page.data.uploads[0].canCreateDraft, true);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "attachClientManifest"
    ).length,
    2
  );
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "confirmUpload"
    ).length,
    0
  );
  assert.strictEqual(attachRequestIds[0], attachRequestIds[1]);
  assert.strictEqual(imageTransferCalls, 2);
  assert.strictEqual(confirmImageRequestIds.length, 1);
  assert.strictEqual(
    harness.calls.cloud.some((request) => request.data.action === "publishDraft"),
    false
  );
});

test("小专题 Word 超过本地导入上限时要求拆分且不创建上传任务", async () => {
  let parseOptions = null;
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            success: true,
            capabilities: {
              directClientUpload: true,
              drafts: true,
              upload: true,
              transportMode: "cloud-storage-direct"
            }
          }
        };
      }
      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: [] } };
      }
      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }
      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "大型专题.docx",
          path: "wxfile://tmp/large-topic.docx",
          size: 4096
        }]
      });
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        async analyzeDocx(filePath, options) {
          assert.strictEqual(filePath, "wxfile://tmp/large-topic.docx");
          parseOptions = options;
          return {
            blocks: [{ type: "paragraph", text: "已截取的专题正文" }],
            images: [],
            schemaVersion: 1,
            sourceType: "docx",
            stats: {
              extractedBlocks: 2000,
              extractedCharacters: 200000,
              imageCount: 0,
              totalParagraphs: 1001,
              truncated: true
            },
            title: "大型专题",
            warnings: ["文稿内容超过单篇导入上限"]
          };
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  page.onAssetTypeChange({ detail: { value: "2" } });
  page.onRelatedIdInput({ detail: { value: "large-topic" } });
  page.chooseFile();
  await flush();

  assert.strictEqual(parseOptions.maximumBlocks, 2000);
  assert.strictEqual(parseOptions.maximumCharacters, 200000);
  assert.strictEqual(page.data.localDocumentReady, false);
  assert.strictEqual(
    page.data.localParseError,
    "这份 Word 内容较多，请拆成两个小专题后分别上传"
  );
  await page.startUpload();
  assert.strictEqual(harness.calls.cloudUploadFile.length, 0);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => request.data.action === "createUpload"
    ),
    false
  );
  assert.strictEqual(
    harness.calls.toasts[harness.calls.toasts.length - 1].title,
    "请先重试读取 Word 文件"
  );
});

test("管理员配音直传失败可重试且严格匹配预留云路径", async () => {
  const uploadId = "d".repeat(32);
  const cloudPath =
    `published/audio/article-one/assets/${uploadId}/primary.mp3`;
  const fileID = `cloud://test-env.bucket/${cloudPath}`;
  let attempts = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            role: "admin",
            success: true,
            capabilities: {
              directCloud: true,
              drafts: true,
              upload: true,
              uploadMode: "directCloud"
            }
          }
        };
      }
      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: [] } };
      }
      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }
      if (request.data.action === "listUploadTargets") {
        assert.strictEqual(request.data.targetType, "content");
        return {
          result: {
            success: true,
            targets: [{
              id: "article-one",
              title: "测试文章",
              subtitle: "首页已发布"
            }]
          }
        };
      }
      if (request.data.action === "createUpload") {
        assert.strictEqual(request.data.assetType, "audio");
        assert.strictEqual(request.data.relatedId, "article-one");
        assert.strictEqual(request.data.clientDurationSeconds, 78.5);
        return {
          result: {
            success: true,
            upload: { id: uploadId },
            uploadMode: "directCloud",
            cloudPath
          }
        };
      }
      if (request.data.action === "confirmUpload") {
        return {
          result: {
            success: true,
            upload: {
              id: uploadId,
              status: "uploaded",
              validationStatus: "admin_attested_unverified"
            },
            canCreateDraft: true,
            requiresClientManifest: false
          }
        };
      }
      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "示范配音.mp3",
          path: "wxfile://tmp/example.mp3",
          size: 8192,
          type: "audio/mpeg"
        }]
      });
    },
    createInnerAudioContext() {
      return createDurationProbeContext(78.5);
    },
    cloudUploadFile(request) {
      attempts += 1;
      const attempt = attempts;
      const task = {
        abort() {},
        onProgressUpdate(handler) {
          handler({ progress: attempt === 1 ? 22 : 100 });
        }
      };
      setImmediate(() => {
        if (attempt === 1) {
          request.fail({
            errCode: "STORAGE_REQUEST_FAIL",
            errMsg: "uploadFile:fail request rejected before transfer"
          });
        } else {
          request.success({ fileID });
        }
      });
      return task;
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  page.onAssetTypeChange({ detail: { value: "1" } });
  await flush();
  await flush();
  page.onUploadTargetChange({ detail: { value: "0" } });
  page.chooseFile();
  await flush();

  await page.startUpload();
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(
    page.data.uploadError,
    "云存储没有接收文件，请重试（STORAGE_REQUEST_FAIL）"
  );
  await page.retryUpload();

  assert.strictEqual(attempts, 2);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "createUpload"
    ).length,
    1
  );
  assert.strictEqual(
    page.data.uploadStageLabel,
    "配音上传完成，可创建内容草稿"
  );
  assert.strictEqual(
    harness.calls.cloudUploadFile[1].cloudPath,
    cloudPath
  );
  assert.strictEqual(page.data.uploadSuccess.includes("不会自动发布"), true);
});

test("配音时长读取失败给中文提示且切换入口会销毁并忽略迟到回调", async () => {
  const contexts = [
    createDurationProbeContext(41, { auto: false }),
    createDurationProbeContext(52, { auto: false })
  ];
  const harness = createWx({
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "待检测配音.mp3",
          path: "wxfile://tmp/probe.mp3",
          size: 4096,
          type: "audio/mpeg"
        }]
      });
    },
    createInnerAudioContext() {
      return contexts.shift();
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    authorized: true,
    uploadAvailable: true,
    capabilities: { ...page.data.capabilities, upload: true }
  });
  page.activateFileEntry("audio");
  page.onRelatedIdInput({ detail: { value: "audio-story" } });
  page.chooseFile();
  const staleContext = harness.createdAudioContexts[0];
  assert.strictEqual(page.data.audioDurationLoading, true);

  page.activateFileEntry("manuscript");
  assert.strictEqual(staleContext.destroyed, true);
  staleContext.triggerCanplay();
  await flush();
  assert.strictEqual(page.data.selectedAssetType, "manuscript");
  assert.strictEqual(page.data.selectedFile, null);
  assert.strictEqual(page.data.audioDurationLabel, "");

  page.activateFileEntry("audio");
  page.onRelatedIdInput({ detail: { value: "audio-story" } });
  page.chooseFile();
  const failedContext = harness.createdAudioContexts[1];
  failedContext.triggerError();
  await flush();
  assert.strictEqual(failedContext.destroyed, true);
  assert.strictEqual(page.data.audioDurationLoading, false);
  assert.strictEqual(
    page.data.audioDurationError,
    "无法读取这段配音的时长，请重新选择音频文件。"
  );
  await page.startUpload();
  assert.strictEqual(
    harness.calls.toasts[harness.calls.toasts.length - 1].title,
    "请重新选择能够正常播放的音频文件"
  );
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => request.data.action === "createUpload"
    ),
    false
  );
});

test("取消建票后忽略迟到响应并释放旧预约", async () => {
  const oldUploadId = "1".repeat(32);
  const newUploadId = "2".repeat(32);
  const oldCreate = deferred();
  const newCreate = deferred();
  let createCount = 0;
  const manifestUploadIds = [];
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            roles: ["admin"],
            success: true,
            capabilities: {
              directClientUpload: true,
              drafts: true,
              upload: true,
              transportMode: "cloud-storage-direct"
            }
          }
        };
      }
      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: [] } };
      }
      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }
      if (request.data.action === "createUpload") {
        createCount += 1;
        return createCount === 1 ? oldCreate.promise : newCreate.promise;
      }
      if (request.data.action === "cancelUpload") {
        return { result: { success: true } };
      }
      if (request.data.action === "attachClientManifest") {
        manifestUploadIds.push(request.data.uploadId);
        return {
          result: {
            success: true,
            canCreateDraft: true,
            requiresClientManifest: false,
            requiresClientImages: false,
            upload: {
              id: request.data.uploadId,
              status: "uploaded",
              validationStatus: "client_manifest_validated",
              canCreateDraft: true
            }
          }
        };
      }
      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "并发测试书稿.docx",
          path: "wxfile://tmp/race.docx",
          size: 1024
        }]
      });
    },
    cloudUploadFile() {
      throw new Error("manifest-only Word must not upload the original DOCX");
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        async analyzeDocx() {
          return {
            blocks: [{ type: "paragraph", text: "并发测试正文" }],
            images: [],
            schemaVersion: 1,
            sourceType: "docx",
            stats: {
              extractedBlocks: 1,
              extractedCharacters: 6,
              imageCount: 0,
              totalParagraphs: 1,
              truncated: false
            },
            title: "并发测试书稿",
            warnings: []
          };
        }
      }
    },
    wx: harness.wx
  });
  const createResult = (uploadId) => ({
    result: {
      success: true,
      upload: { id: uploadId },
      uploadTransport: {
        directClientUploadAllowed: true,
        mode: "cloud-storage-direct",
        originalFileUploadRequired: false,
        requiresClientManifest: true,
        sourceMode: "client-manifest-only"
      }
    }
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  page.onRelatedIdInput({ detail: { value: "race-story" } });
  page.chooseFile();
  await flush();

  const oldPromise = page.startUpload();
  await flush();
  assert.strictEqual(createCount, 1);
  page.cancelActiveUpload();
  const newPromise = page.retryUpload();
  await flush();
  assert.strictEqual(createCount, 2);

  oldCreate.resolve(createResult(oldUploadId));
  await flush();
  await flush();
  assert.deepStrictEqual(
    harness.calls.cloud
      .filter((request) => request.data.action === "cancelUpload")
      .map((request) => request.data.uploadId),
    [oldUploadId]
  );
  assert.strictEqual(page.pendingUploadTicket, null);

  newCreate.resolve(createResult(newUploadId));
  await Promise.all([oldPromise, newPromise]);
  assert.deepStrictEqual(manifestUploadIds, [newUploadId]);
  assert.strictEqual(harness.calls.cloudUploadFile.length, 0);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => request.data.action === "confirmUpload"
    ),
    false
  );
  assert.strictEqual(page.data.canRetry, false);
  assert.strictEqual(page.pendingUploadTicket, null);
});

test("管理员取消或卸载免费直传时中止任务且绝不确认发布", async () => {
  const uploadId = "f".repeat(32);
  const cloudPath =
    `admin-direct-staging/${"1".repeat(24)}/${uploadId}/source.docx`;
  let activeRequest = null;
  let abortCount = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            role: "admin",
            success: true,
            capabilities: {
              directClientUpload: true,
              drafts: true,
              upload: true,
              transportMode: "cloud-storage-direct"
            }
          }
        };
      }
      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: [] } };
      }
      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }
      if (request.data.action === "createUpload") {
        return {
          result: {
            success: true,
            upload: { id: uploadId },
            uploadTransport: {
              cloudPath,
              directClientUploadAllowed: true,
              mode: "cloud-storage-direct"
            }
          }
        };
      }
      if (request.data.action === "cancelUpload") {
        return { result: { success: true } };
      }
      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile(request) {
      request.success({
        tempFiles: [{
          name: "待取消书稿.docx",
          path: "wxfile://tmp/cancel.docx",
          size: 1024
        }]
      });
    },
    cloudUploadFile(request) {
      activeRequest = request;
      return {
        abort() {
          abortCount += 1;
          request.fail({ errMsg: "uploadFile:fail abort" });
        },
        onProgressUpdate(handler) {
          handler({ progress: 10 });
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    requireMap: {
      "./docxImport": {
        async analyzeDocx() {
          return {
            blocks: [{ type: "paragraph", text: "待取消正文" }],
            images: [],
            schemaVersion: 1,
            sourceType: "docx",
            stats: {
              extractedBlocks: 1,
              extractedCharacters: 6,
              imageCount: 0,
              totalParagraphs: 1,
              truncated: false
            },
            title: "待取消书稿",
            warnings: []
          };
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();
  page.onRelatedIdInput({ detail: { value: "cancel-story" } });
  page.chooseFile();
  await flush();
  const uploadPromise = page.startUpload();
  await flush();
  assert.ok(activeRequest);

  page.cancelActiveUpload();
  await uploadPromise;
  await flush();
  assert.strictEqual(abortCount, 1);
  assert.strictEqual(page.data.uploading, false);
  assert.strictEqual(page.data.uploadStageLabel, "已取消上传");
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "cancelUpload"
    ).length,
    1
  );
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => ["confirmUpload", "publishDraft"].includes(request.data.action)
    ),
    false
  );

  page.onRelatedIdInput({ detail: { value: "unload-story" } });
  page.chooseFile();
  await flush();
  const unloadPromise = page.startUpload();
  await flush();
  page.onUnload();
  await unloadPromise;
  await flush();
  assert.strictEqual(abortCount, 2);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => ["confirmUpload", "publishDraft"].includes(request.data.action)
    ),
    false
  );
});

test("管理员上传代理未启用时不能选择文件或发起上传", async () => {
  const harness = createWx({
    async callFunction(request) {
      if (request.data.action === "status") {
        return {
          result: {
            authorized: true,
            role: "admin",
            success: true,
            capabilities: {
              upload: false,
              drafts: true,
              transportMode: "disabled"
            }
          }
        };
      }

      if (request.data.action === "listUploads") {
        return { result: { success: true, uploads: [] } };
      }

      if (request.data.action === "listDrafts") {
        return { result: { success: true, drafts: [], hasMore: false } };
      }

      throw new Error(`unexpected action: ${request.data.action}`);
    },
    chooseMessageFile() {
      throw new Error("disabled transport must not open file chooser");
    },
    uploadFile() {
      throw new Error("disabled transport must not upload");
    }
  });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await flush();

  assert.strictEqual(page.data.authorized, true);
  assert.strictEqual(page.data.uploadAvailable, false);
  assert.strictEqual(page.data.transportMessage.length > 0, true);
  page.chooseFile();
  await page.startUpload();

  assert.strictEqual(harness.calls.chooseMessageFile.length, 0);
  assert.strictEqual(harness.calls.uploadFile.length, 0);
  assert.strictEqual(harness.calls.cloudUploadFile.length, 0);
  assert.strictEqual(
    harness.calls.cloud.some(
      (request) => request.data.action === "createUpload"
    ),
    false
  );
});

test("管理员上传页卸载后忽略晚到的权限响应", async () => {
  const statusResponse = deferred();
  const harness = createWx({ callFunction: () => statusResponse.promise });
  const page = loadPage("miniprogram/pages/adminUploads/adminUploads.js", {
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  page.onUnload();
  statusResponse.resolve({
    result: { authorized: true, role: "admin", success: true }
  });
  await flush();

  assert.strictEqual(page.data.authorized, false);
  assert.strictEqual(
    harness.calls.cloud.filter(
      (request) => request.data.action === "listUploads"
    ).length,
    0
  );
});

test("书目触底后按游标增量加载并用正式内容替换同号占位", async () => {
  const offsets = [];
  const harness = createWx();
  const page = loadPage("miniprogram/pages/bookCatalog/bookCatalog.js", {
    requireMap: {
      "../../utils/contents": {
        bookContentList: [],
        async loadContentCatalogResult(view, options = {}) {
          assert.strictEqual(view, "book");
          const offset = Number(options.offset || 0);
          offsets.push(offset);

          if (offset === 0) {
            return {
              hasMore: true,
              items: [
                { available: true, id: "page-one", title: "第一页" },
                { available: false, id: "late-item", title: "待上传占位" }
              ],
              nextOffset: 1,
              success: true
            };
          }

          return {
            hasMore: false,
            items: [
              { available: true, id: "page-one", title: "重复项" },
              { available: true, id: "late-item", title: "正式内容" },
              { available: true, id: "page-two", title: "第二页" }
            ],
            nextOffset: null,
            success: true
          };
        }
      }
    },
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  await flush();
  await page.onReachBottom();

  assert.deepStrictEqual(offsets, [0, 1]);
  assert.deepStrictEqual(
    Array.from(page.data.contents, (item) => item.id),
    ["page-one", "late-item", "page-two"]
  );
  assert.strictEqual(page.data.contents[1].available, true);
  assert.strictEqual(page.data.contents[1].title, "正式内容");

  page.onHide();
  page.onShow();
  await flush();
  assert.deepStrictEqual(offsets, [0, 1]);
  assert.deepStrictEqual(
    Array.from(page.data.contents, (item) => item.id),
    ["page-one", "late-item", "page-two"]
  );
});

test("正文与音频详情使用各自的服务端读取模式", async () => {
  const modes = [];
  const content = {
    audioAvailable: true,
    available: true,
    id: "published-story",
    sections: [],
    title: "已发布内容"
  };
  const contentsModule = {
    async loadContentDetail(contentId, mode) {
      assert.strictEqual(contentId, content.id);
      modes.push(mode);
      return content;
    },
    markContentRead: async () => true
  };

  for (const relativePath of [
    "miniprogram/pages/article/article.js",
    "miniprogram/pages/bookText/bookText.js",
    "miniprogram/pages/articleAudio/articleAudio.js",
    "miniprogram/pages/bookAudio/bookAudio.js"
  ]) {
    const harness = createWx();
    const page = loadPage(relativePath, {
      requireMap: {
        "../../utils/contents": contentsModule
      },
      wx: harness.wx
    });

    await page.onLoad({ id: content.id });
    await flush();
    if (page.onUnload) {
      page.onUnload();
    }
  }

  assert.deepStrictEqual(modes, ["text", "text", "audio", "audio"]);
});

test("正文页卸载后忽略晚到的云端响应", async () => {
  for (const relativePath of [
    "miniprogram/pages/article/article.js",
    "miniprogram/pages/bookText/bookText.js"
  ]) {
    const response = deferred();
    const harness = createWx();
    const page = loadPage(relativePath, {
      requireMap: {
        "../../utils/contents": {
          loadContentDetail: () => response.promise,
          markContentRead: async () => true
        }
      },
      wx: harness.wx
    });

    const loadPromise = page.onLoad({ id: "late-content" });
    page.onUnload();
    response.resolve({
      available: false,
      errorCode: "MEMBER_REQUIRED",
      requiresMembership: true
    });
    await loadPromise;

    assert.strictEqual(page.data.content, null);
    assert.strictEqual(harness.calls.modals.length, 0);
    assert.strictEqual(harness.calls.toasts.length, 0);
  }
});

test("无配音内容不会进入播放器，音频网络错误提供重试", async () => {
  const catalogHarness = createWx();
  const catalogPage = loadPage("miniprogram/pages/bookCatalog/bookCatalog.js", {
    requireMap: {
      "../../utils/contents": {
        bookContentList: [
          {
            audioAvailable: false,
            available: true,
            id: "text-only",
            title: "纯文本"
          }
        ],
        loadContentCatalogResult: async () => ({
          hasMore: false,
          items: [],
          nextOffset: null,
          success: true
        })
      }
    },
    wx: catalogHarness.wx
  });
  catalogPage.openAudio({ currentTarget: { dataset: { id: "text-only" } } });
  assert.strictEqual(catalogHarness.calls.navigateTo.length, 0);
  assert.strictEqual(
    catalogHarness.calls.toasts[0].title,
    "配音资源尚未接入"
  );

  const networkHarness = createWx({ autoConfirmModals: false });
  const audioPage = loadPage("miniprogram/pages/articleAudio/articleAudio.js", {
    requireMap: {
      "../../utils/contents": {
        loadContentDetail: async () => ({
          available: false,
          errorCode: "CONTENT_REQUEST_FAILED",
          errorMessage: "内容读取失败，请检查网络后重试"
        })
      }
    },
    wx: networkHarness.wx
  });
  await audioPage.onLoad({ id: "published-story" });
  assert.strictEqual(networkHarness.calls.modals.length, 1);
  assert.strictEqual(
    networkHarness.calls.modals[0].title,
    "音频信息读取失败"
  );
  assert.strictEqual(networkHarness.calls.navigateBack.length, 0);
  audioPage.onUnload();
});

test("摘要仅在正文成功打开后记录阅读状态", async () => {
  const harness = createWx();
  const page = loadPage("miniprogram/pages/summary/summary.js", {
    requireMap: {
      "../../utils/contents": {
        loadContentCatalogResult: async () => ({
          hasMore: false,
          items: [
            {
              available: true,
              id: "published-summary",
              title: "已发布摘要"
            }
          ],
          nextOffset: null,
          success: true
        })
      }
    },
    wx: harness.wx
  });

  page.onShow();
  await flush();
  page.openSummary({
    currentTarget: { dataset: { id: "published-summary" } }
  });

  assert.strictEqual(harness.calls.cloud.length, 0);
  assert.strictEqual(harness.storage.has("summaryReadContentIds"), false);
  assert.strictEqual(harness.calls.navigateTo.length, 1);
});

test("目录页隐藏后忽略晚到的追加失败提示", async () => {
  for (const fixture of [
    {
      path: "miniprogram/pages/bookCatalog/bookCatalog.js",
      setup(page) {
        page.onLoad();
      },
      view: "book"
    },
    {
      path: "miniprogram/pages/summary/summary.js",
      setup(page) {
        page.onShow();
      },
      view: "summary"
    }
  ]) {
    const appendResponse = deferred();
    let requestCount = 0;
    const harness = createWx();
    const page = loadPage(fixture.path, {
      requireMap: {
        "../../utils/contents": {
          bookContentList: [],
          async loadContentCatalogResult(view) {
            assert.strictEqual(view, fixture.view);
            requestCount += 1;

            if (requestCount === 1) {
              return {
                hasMore: true,
                items: [],
                nextOffset: 1,
                success: true
              };
            }

            return appendResponse.promise;
          }
        }
      },
      wx: harness.wx
    });

    fixture.setup(page);
    await flush();
    const appendPromise = page.onReachBottom();
    page.onHide();
    appendResponse.resolve({
      hasMore: false,
      items: [],
      nextOffset: null,
      success: false
    });
    await appendPromise;

    assert.strictEqual(harness.calls.toasts.length, 0);
  }
});

test("三步注册传播 catalog 返回目标并回退到原书目页", () => {
  const policies = require("./miniprogram/utils/policies");
  const app = {
    globalData: {
      registrationConsent: null
    }
  };
  const firstHarness = createWx();
  const firstPage = loadPage("miniprogram/pages/register1/register1.js", {
    app,
    wx: firstHarness.wx
  });
  firstPage.onLoad({ returnTo: "catalog" });
  firstPage.setData({ agreed: true });
  firstPage.goNext();
  assert.strictEqual(
    firstHarness.calls.navigateTo[0].url,
    "/pages/register2/register2?returnTo=catalog"
  );

  const secondHarness = createWx();
  const secondPage = loadPage("miniprogram/pages/register2/register2.js", {
    app,
    pages: [{ route: "pages/register1/register1" }],
    wx: secondHarness.wx
  });
  secondPage.onLoad({ returnTo: "catalog" });
  secondPage.setData({ agreed: true });
  secondPage.goNext();
  assert.strictEqual(
    secondHarness.calls.navigateTo[0].url,
    "/pages/register3/register3?returnTo=catalog"
  );
  assert.strictEqual(
    app.globalData.registrationConsent.noticeVersion,
    policies.REGISTRATION_NOTICE_VERSION
  );
  assert.strictEqual(
    app.globalData.registrationConsent.rulesVersion,
    policies.READER_RULES_VERSION
  );

  const stack = [
    { route: "pages/bookCatalog/bookCatalog" },
    { route: "pages/register1/register1" },
    { route: "pages/register2/register2" },
    { route: "pages/register3/register3" }
  ];
  const thirdHarness = createWx();
  const thirdPage = loadPage("miniprogram/pages/register3/register3.js", {
    app,
    pages: stack,
    wx: thirdHarness.wx
  });
  thirdPage.onLoad({ returnTo: "catalog" });
  thirdPage.finishRegistration();
  assert.strictEqual(thirdHarness.calls.navigateBack[0].delta, 3);
});

test("注册深链缺少前序同意时回到第一步", () => {
  const harness = createWx();
  const page = loadPage("miniprogram/pages/register2/register2.js", {
    app: { globalData: { registrationConsent: null } },
    pages: [],
    wx: harness.wx
  });

  page.onLoad({ returnTo: "catalog" });
  assert.strictEqual(
    harness.calls.redirects[0].url,
    "/pages/register1/register1?returnTo=catalog"
  );
});

test("注册页卸载后忽略晚到的注册结果", async () => {
  const response = deferred();
  const policies = require("./miniprogram/utils/policies");
  const app = {
    globalData: {
      registrationConsent: {
        noticeVersion: policies.REGISTRATION_NOTICE_VERSION,
        rulesVersion: policies.READER_RULES_VERSION
      }
    }
  };
  const harness = createWx({
    callFunction: () => response.promise
  });
  const page = loadPage("miniprogram/pages/register3/register3.js", {
    app,
    wx: harness.wx
  });

  page.onLoad();
  page.setData({
    birthYear: "2012",
    city: "北京市 北京市 海淀区",
    confirmPassword: "12345678",
    nickname: "TEST",
    password: "12345678",
    phone: "13800138000"
  });
  const submitPromise = page.submitRegister();
  page.onUnload();
  response.resolve({
    result: {
      success: true,
      user: { memberId: "TEST2012EXAMPLE" }
    }
  });
  await submitPromise;

  assert.strictEqual(harness.calls.modals.length, 0);
  assert.strictEqual(app.globalData.memberProfile, undefined);
});

test("忘记密码沿用已选会员且忽略隐藏前发出的晚到响应", async () => {
  const resetResponse = deferred();
  const loginHarness = createWx();
  const loginPage = loadPage(
    "miniprogram/pages/memberLogin/memberLogin.js",
    {
      wx: loginHarness.wx
    }
  );
  loginPage.setData({ selectedMemberId: "TEST2012EXAMPLE" });
  loginPage.goRecovery();
  assert.strictEqual(
    loginHarness.calls.navigateTo[0].url,
    "/pages/memberRecovery/memberRecovery?memberId=TEST2012EXAMPLE"
  );

  const app = { globalData: {} };
  const recoveryHarness = createWx({
    callFunction: () => resetResponse.promise
  });
  const recoveryPage = loadPage(
    "miniprogram/pages/memberRecovery/memberRecovery.js",
    {
      app,
      wx: recoveryHarness.wx
    }
  );
  recoveryPage.onLoad({ memberId: "test2012example" });
  assert.strictEqual(recoveryPage.data.memberId, "TEST2012EXAMPLE");
  recoveryPage.setData({
    phone: "13800138000",
    newPassword: "87654321",
    confirmPassword: "87654321"
  });

  const resetPromise = recoveryPage.submitReset();
  recoveryPage.onHide();
  recoveryPage.onShow();
  resetResponse.resolve({
    result: {
      success: true
    }
  });
  await resetPromise;

  assert.strictEqual(recoveryHarness.calls.modals.length, 0);
  assert.strictEqual(recoveryHarness.calls.redirects.length, 0);
  assert.strictEqual(recoveryHarness.calls.hideLoading, 1);
  assert.strictEqual(app.globalData.memberProfile, undefined);
});

test("会员页隐藏时清空读后感且忽略晚到响应", async () => {
  const response = deferred();
  const app = {
    globalData: {
      memberProfile: { nickname: "TEST" },
      readerNotes: [{ id: "global-note" }]
    }
  };
  const harness = createWx({
    callFunction: () => response.promise
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app,
    wx: harness.wx
  });
  page.isPageVisible = true;
  page.setData({
    notePassword: "12345678",
    notesUnlocked: true,
    readerNotes: [{ id: "old-note" }],
    visibleReaderNotes: [{ id: "old-note" }]
  });

  const request = page.openReaderNotes();
  page.onHide();
  response.resolve({
    result: {
      notes: [{ id: "late-note", content: "late" }],
      success: true
    }
  });
  await request;

  assert.strictEqual(page.data.notesUnlocked, false);
  assert.strictEqual(page.data.notePassword, "");
  assert.strictEqual(page.data.readerNotes.length, 0);
  assert.strictEqual(app.globalData.readerNotes.length, 0);
});

test("会员读后感首屏分页且密码只短暂经 EventChannel 传递", async () => {
  const app = {
    globalData: {
      memberProfile: { nickname: "TEST" },
      readerNotes: []
    }
  };
  const eventChannel = createEventChannel();
  let emittedPayload = null;
  eventChannel.on("readerNotes", (payload) => {
    emittedPayload = payload;
  });
  const harness = createWx({
    eventChannel,
    async callFunction(request) {
      assert.strictEqual(request.name, "getNotes");
      return {
        result: {
          success: true,
          notes: Array.from({ length: 4 }, (_, index) => ({
            id: `note-${index + 1}`,
            bookTitle: `书稿${index + 1}`,
            content: `读后感${index + 1}`
          })),
          hasMore: true,
          nextOffset: 4,
          total: 5
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app,
    wx: harness.wx
  });
  page.isPageVisible = true;
  page.setData({ notePassword: "12345678" });

  await page.openReaderNotes();

  assert.strictEqual(harness.calls.cloud[0].data.password, "12345678");
  assert.strictEqual(harness.calls.cloud[0].data.offset, 0);
  assert.strictEqual(harness.calls.cloud[0].data.limit, 20);
  assert.strictEqual(page.data.notePassword, "");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.data, "password"), false);
  assert.strictEqual(app.globalData.readerNotes.length, 0);

  page.openAllReaderNotes();
  assert.strictEqual(emittedPayload.password, "12345678");
  assert.strictEqual(emittedPayload.nextOffset, 4);
  assert.strictEqual(emittedPayload.total, 5);

  page.onHide();
  assert.strictEqual(page.noteAccessPassword, "");
});

test("待接受亲友邀请与外发缓存隔离，并在网络恢复后重试", async () => {
  const incomingToken = "a".repeat(64);
  const outgoingToken = "b".repeat(64);
  const storage = new Map([
    [
      "familyInviteCache",
      { token: outgoingToken, expiresAtMs: Date.now() + 10 * 60 * 1000 }
    ]
  ]);
  let acceptAttempts = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            registered: true,
            success: true,
            user: { badges: [], nickname: "MEMBER" }
          }
        };
      }

      if (request.name === "familyCenter" && request.data.action === "acceptInvite") {
        acceptAttempts += 1;
        if (acceptAttempts === 1) {
          throw new Error("network down");
        }
        return { result: { success: true } };
      }

      if (request.name === "familyCenter" && request.data.action === "list") {
        return { result: { familyMembers: [], success: true } };
      }

      throw new Error(`Unexpected call: ${request.name}`);
    },
    storage
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app: { globalData: { memberProfile: null, readerNotes: [] } },
    wx: harness.wx
  });

  page.onLoad({ familyInvite: incomingToken });
  assert.strictEqual(storage.get("pendingFamilyInvite").token, incomingToken);
  assert.strictEqual(storage.get("familyInviteCache").token, outgoingToken);

  page.onShow();
  await page.pendingInvitePromise;
  await flush();
  assert.strictEqual(storage.get("pendingFamilyInvite").token, incomingToken);

  page.onShow();
  await page.pendingInvitePromise;
  await flush();
  assert.strictEqual(storage.has("pendingFamilyInvite"), false);
  assert.strictEqual(storage.get("familyInviteCache").token, outgoingToken);
  assert.strictEqual(acceptAttempts, 2);
});

test("终止性亲友邀请错误会清除待处理 token", async () => {
  const token = "c".repeat(64);
  const storage = new Map();
  let acceptAttempts = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return {
          result: {
            loggedIn: true,
            registered: true,
            success: true,
            user: { badges: [], userId: "member-terminal-invite" }
          }
        };
      }
      if (
        request.name === "familyCenter" &&
        request.data.action === "acceptInvite"
      ) {
        acceptAttempts += 1;
        return {
          result: {
            code: "INVITE_EXPIRED",
            message: "邀请已过期",
            success: false
          }
        };
      }
      return { result: { success: true } };
    },
    storage
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app: { globalData: { memberProfile: null, readerNotes: [] } },
    wx: harness.wx
  });

  page.onLoad({ familyInvite: token });
  page.onShow();
  await flush();
  if (page.pendingInvitePromise) {
    await page.pendingInvitePromise;
  }
  await flush();
  assert.strictEqual(storage.has("pendingFamilyInvite"), false);
  assert.strictEqual(acceptAttempts, 1);
});

test("损坏的待处理亲友邀请会被丢弃且不会发起接受请求", async () => {
  const storage = new Map([["pendingFamilyInvite", { token: "broken" }]]);
  let acceptAttempts = 0;
  const harness = createWx({
    async callFunction(request) {
      if (request.name === "getUser") {
        return { result: { registered: false, success: true } };
      }
      if (request.name === "familyCenter" && request.data.action === "acceptInvite") {
        acceptAttempts += 1;
      }
      return { result: { success: true } };
    },
    storage
  });
  const page = loadPage("miniprogram/pages/member/member.js", {
    app: { globalData: { memberProfile: null, readerNotes: [] } },
    wx: harness.wx
  });

  page.onLoad({});
  page.onShow();
  await flush();

  assert.strictEqual(storage.has("pendingFamilyInvite"), false);
  assert.strictEqual(acceptAttempts, 0);
});

test("奖励页不使用全局会员缓存提前放行", async () => {
  const membershipResponse = deferred();
  const harness = createWx({
    callFunction: () => membershipResponse.promise
  });
  const page = loadPage("miniprogram/pages/zhen/zhen.js", {
    app: { globalData: { memberProfile: { nickname: "STALE" } } },
    wx: harness.wx
  });

  page.onShow();
  assert.strictEqual(page.data.membershipStatus, "checking");
  membershipResponse.resolve({
    result: { registered: false, success: true }
  });
  await flush();
  assert.strictEqual(page.data.membershipStatus, "guest");
});

test("少年志只展示云端发布项并在触底后增量加载", async () => {
  const offsets = [];
  const harness = createWx({
    async callFunction(request) {
      const offset = Number(request.data.offset || 0);
      offsets.push(offset);

      if (offset === 0) {
        return {
          result: {
            entries: [
              {
                content: "第一页消息",
                day: "14",
                id: "zhi-page-one",
                month: "07",
                year: "2026"
              }
            ],
            hasMore: true,
            nextOffset: 1,
            source: "cloud",
            success: true
          }
        };
      }

      return {
        result: {
          entries: [
            {
              content: "第二页消息",
              day: "13",
              id: "zhi-page-two",
              month: "07",
              year: "2026"
            }
          ],
          hasMore: false,
          nextOffset: null,
          source: "cloud",
          success: true
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/zhi/zhi.js", {
    wx: harness.wx
  });
  page.setData({ selectedMonth: "07", selectedYear: "2026" });

  page.onShow();
  await flush();
  await page.onReachBottom();

  assert.deepStrictEqual(offsets, [0, 1]);
  assert.deepStrictEqual(
    Array.from(page.data.visibleEntries, (entry) => entry.id),
    ["zhi-page-one", "zhi-page-two"]
  );
});

test("少年志追加失败可重试且隐藏后不处理晚到错误", async () => {
  const offsets = [];
  const lateResponse = deferred();
  let pageRequestCount = 0;
  const harness = createWx({
    async callFunction(request) {
      const offset = Number(request.data.offset || 0);
      offsets.push(offset);
      pageRequestCount += 1;

      if (pageRequestCount === 1) {
        return {
          result: {
            entries: [
              {
                content: "第一页消息",
                day: "14",
                id: "zhi-retry-one",
                month: "07",
                year: "2026"
              }
            ],
            hasMore: true,
            nextOffset: 1,
            source: "cloud",
            success: true
          }
        };
      }

      if (pageRequestCount === 2) {
        return { result: { message: "网络错误", success: false } };
      }

      if (pageRequestCount === 3) {
        return {
          result: {
            entries: [
              {
                content: "重试后的第二页",
                day: "13",
                id: "zhi-retry-two",
                month: "07",
                year: "2026"
              }
            ],
            hasMore: true,
            nextOffset: 2,
            source: "cloud",
            success: true
          }
        };
      }

      return lateResponse.promise;
    }
  });
  const page = loadPage("miniprogram/pages/zhi/zhi.js", {
    wx: harness.wx
  });
  page.setData({ selectedMonth: "07", selectedYear: "2026" });

  page.onShow();
  await flush();
  await page.onReachBottom();
  await page.onReachBottom();

  assert.deepStrictEqual(offsets, [0, 1, 1]);
  assert.deepStrictEqual(
    Array.from(page.data.visibleEntries, (entry) => entry.id),
    ["zhi-retry-one", "zhi-retry-two"]
  );
  assert.strictEqual(harness.calls.toasts.length, 1);

  const hiddenRequest = page.onReachBottom();
  page.onHide();
  lateResponse.resolve({
    result: { message: "晚到错误", success: false }
  });
  await hiddenRequest;

  assert.strictEqual(harness.calls.toasts.length, 1);
  assert.strictEqual(page.data.timelineLoading, false);
});

test("少年真切换会员时丢弃上一位会员的晚到目录", async () => {
  const firstResponse = deferred();
  let requestCount = 0;
  const harness = createWx({
    callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      assert.strictEqual(request.data.action, "list");
      requestCount += 1;

      if (requestCount === 1) {
        return firstResponse.promise;
      }

      return Promise.resolve({
        result: {
          success: true,
          source: "cloud",
          memberLoggedIn: true,
          topics: [
            {
              id: "member-b-topic",
              title: "会员乙专题",
              unlockCostStars: 10,
              unlocked: false
            }
          ],
          hasMore: false
        }
      });
    }
  });
  const page = loadPage("miniprogram/pages/zhen/zhen.js", {
    wx: harness.wx
  });

  page.onShow();
  page.onHide();
  page.onShow();
  await flush();
  assert.deepStrictEqual(
    Array.from(page.data.topics, (topic) => topic.id),
    ["member-b-topic"]
  );

  firstResponse.resolve({
    result: {
      success: true,
      source: "cloud",
      memberLoggedIn: true,
      topics: [
        {
          id: "member-a-topic",
          title: "会员甲专题",
          unlockCostStars: 10,
          unlocked: true
        }
      ],
      hasMore: false
    }
  });
  await flush();

  assert.deepStrictEqual(
    Array.from(page.data.topics, (topic) => topic.id),
    ["member-b-topic"]
  );
});

test("小专题解锁后自动读取正文首屏", async () => {
  const actions = [];
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      actions.push(request.data.action);

      if (request.data.action === "open") {
        assert.strictEqual(request.data.topicId, "topic-first-page");
        return {
          result: {
            success: true,
            firstUnlock: true,
            chargedStars: 1,
            topic: { id: "topic-first-page", title: "首屏专题" },
            topicRevision: 7,
            hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        };
      }

      assert.strictEqual(request.data.action, "readPage");
      assert.strictEqual(request.data.topicId, "topic-first-page");
      assert.strictEqual(request.data.expectedRevision, "7");
      assert.deepStrictEqual(request.data.cursor, {
        entryOffset: 0,
        blockOffset: 0
      });
      return {
         result: {
           success: true,
           topicRevision: 7,
           entries: [{ id: "entry-first", title: "正文首屏" }],
          hasMore: true,
          nextCursor: { entryOffset: 1, blockOffset: 0 }
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-first-page" });
  await flush();

  assert.deepStrictEqual(actions, ["open", "readPage"]);
  assert.strictEqual(page.data.topic.id, "topic-first-page");
  assert.strictEqual(page.data.topicRevision, "7");
  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-first"]
  );
  assert.strictEqual(page.data.hasMore, true);
  assert.deepStrictEqual(page.data.nextCursor, {
    entryOffset: 1,
    blockOffset: 0
  });
  assert.strictEqual(page.data.contentLoading, false);
  assert.strictEqual(page.data.contentErrorMessage, "");
});

test("小专题触底追加且末页后不再请求", async () => {
  const actions = [];
  let pageNumber = 0;
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      actions.push(request.data.action);

      if (request.data.action === "open") {
        return {
          result: {
            success: true,
            firstUnlock: false,
             chargedStars: 0,
             topic: { id: "topic-append", title: "分页专题" },
             topicRevision: 1,
             hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        };
      }

      pageNumber += 1;
      assert.deepStrictEqual(request.data.cursor, {
        entryOffset: pageNumber - 1,
        blockOffset: 0
      });
      return {
         result: {
           success: true,
           topicRevision: 1,
           entries: [
            {
              id: `entry-page-${pageNumber}`,
              title: `第${pageNumber}页`
            }
          ],
          hasMore: pageNumber === 1,
          nextCursor:
            pageNumber === 1
              ? { entryOffset: 1, blockOffset: 0 }
              : null
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-append" });
  await flush();
  page.onReachBottom();
  await flush();
  page.onReachBottom();
  page.onReachBottom();
  await flush();

  assert.deepStrictEqual(actions, ["open", "readPage", "readPage"]);
  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-page-1", "entry-page-2"]
  );
  assert.strictEqual(page.data.hasMore, false);
  assert.strictEqual(page.data.nextCursor, null);
});

test("小专题连续触底只发出一个追加请求", async () => {
  const appendResponse = deferred();
  const actions = [];
  let readCount = 0;
  const harness = createWx({
    callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      actions.push(request.data.action);

      if (request.data.action === "open") {
        return Promise.resolve({
          result: {
            success: true,
            firstUnlock: false,
             chargedStars: 0,
             topic: { id: "topic-dedupe", title: "去重专题" },
             topicRevision: 1,
             hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        });
      }

      readCount += 1;
      if (readCount === 1) {
        return Promise.resolve({
           result: {
             success: true,
             topicRevision: 1,
             entries: [{ id: "entry-dedupe-1" }],
            hasMore: true,
            nextCursor: { entryOffset: 1, blockOffset: 0 }
          }
        });
      }

      assert.deepStrictEqual(request.data.cursor, {
        entryOffset: 1,
        blockOffset: 0
      });
      return appendResponse.promise;
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-dedupe" });
  await flush();
  page.onReachBottom();
  page.onReachBottom();
  page.onReachBottom();

  assert.deepStrictEqual(actions, ["open", "readPage", "readPage"]);
  assert.strictEqual(readCount, 2);
  assert.strictEqual(page.data.contentLoading, true);

  appendResponse.resolve({
     result: {
       success: true,
       topicRevision: 1,
       entries: [{ id: "entry-dedupe-2" }],
      hasMore: false,
      nextCursor: null
    }
  });
  await flush();

  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-dedupe-1", "entry-dedupe-2"]
  );
  assert.strictEqual(page.data.contentLoading, false);
});

test("小专题红五星不足时精确提示且不读取正文", async () => {
  const actions = [];
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      actions.push(request.data.action);
      return {
        result: {
          success: false,
          code: "INSUFFICIENT_STARS",
          message: "红五星不足",
          requiredStars: 1,
          starRemain: 0
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-no-stars" });
  await flush();

  assert.deepStrictEqual(actions, ["open"]);
  assert.strictEqual(page.data.errorCode, "INSUFFICIENT_STARS");
  assert.strictEqual(
    page.data.errorMessage,
    "解锁需要1颗红五星，当前剩余0颗。"
  );
  assert.strictEqual(page.data.topic, null);
  assert.deepStrictEqual(Array.from(page.data.entries), []);
  assert.strictEqual(harness.calls.toasts.length, 0);
});

test("小专题首屏失败后重试只重发正文页", async () => {
  const requests = [];
  let readCount = 0;
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      requests.push({
        action: request.data.action,
        cursor: request.data.cursor
          ? { ...request.data.cursor }
          : null
      });

      if (request.data.action === "open") {
        return {
          result: {
            success: true,
            firstUnlock: true,
             chargedStars: 1,
             topic: { id: "topic-page-retry", title: "重试专题" },
             topicRevision: 2,
             hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        };
      }

      readCount += 1;
      if (readCount === 1) {
        return {
          result: {
            success: false,
            code: "TOPIC_PAGE_UNAVAILABLE",
            message: "正文首屏暂不可用"
          }
        };
      }

      return {
         result: {
           success: true,
           topicRevision: 2,
           entries: [{ id: "entry-recovered" }],
          hasMore: false,
          nextCursor: null
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-page-retry" });
  await flush();
  assert.strictEqual(page.data.contentErrorCode, "TOPIC_PAGE_UNAVAILABLE");
  assert.strictEqual(page.data.contentErrorMessage, "正文首屏暂不可用");

  page.retryContent();
  await flush();

  assert.deepStrictEqual(
    requests.map((request) => request.action),
    ["open", "readPage", "readPage"]
  );
  assert.deepStrictEqual(requests[1].cursor, {
    entryOffset: 0,
    blockOffset: 0
  });
  assert.deepStrictEqual(requests[2].cursor, requests[1].cursor);
  assert.strictEqual(page.data.topic.id, "topic-page-retry");
  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-recovered"]
  );
  assert.strictEqual(page.data.contentErrorCode, "");
  assert.strictEqual(page.data.contentErrorMessage, "");
});

test("小专题发布版本变化后清空旧正文并重新打开新版本", async () => {
  const requests = [];
  let openCount = 0;
  let readCount = 0;
  const harness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "specialTopicCenter");
      requests.push({
        action: request.data.action,
        expectedRevision: request.data.expectedRevision,
        cursor: request.data.cursor
          ? { ...request.data.cursor }
          : null
      });

      if (request.data.action === "open") {
        openCount += 1;
        const topicRevision = openCount === 1 ? 3 : 4;
        return {
          result: {
            success: true,
            firstUnlock: false,
            chargedStars: 0,
            topic: {
              id: "topic-revision-change",
              title: openCount === 1 ? "旧版专题" : "新版专题"
            },
            topicRevision,
            hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        };
      }

      readCount += 1;
      if (readCount === 1) {
        assert.strictEqual(request.data.expectedRevision, "3");
        return {
           result: {
             success: true,
             topicRevision: 3,
             entries: [{ id: "entry-old-page-one", title: "旧版首屏" }],
            hasMore: true,
            nextCursor: { entryOffset: 1, blockOffset: 0 }
          }
        };
      }

      if (readCount === 2) {
        assert.strictEqual(request.data.expectedRevision, "3");
        assert.deepStrictEqual(request.data.cursor, {
          entryOffset: 1,
          blockOffset: 0
        });
        return {
          result: {
            success: false,
            code: "TOPIC_CHANGED_RELOAD",
            message: "服务端原始版本变化提示"
          }
        };
      }

      assert.strictEqual(request.data.expectedRevision, "4");
      assert.deepStrictEqual(request.data.cursor, {
        entryOffset: 0,
        blockOffset: 0
      });
      return {
         result: {
           success: true,
           topicRevision: 4,
           entries: [{ id: "entry-new-page-one", title: "新版首屏" }],
          hasMore: false,
          nextCursor: null
        }
      };
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-revision-change" });
  await flush();
  assert.strictEqual(page.data.topicRevision, "3");
  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-old-page-one"]
  );

  page.onReachBottom();
  await flush();

  assert.strictEqual(page.data.contentErrorCode, "TOPIC_CHANGED_RELOAD");
  assert.strictEqual(
    page.data.contentErrorMessage,
    "专题内容已更新，请重新打开"
  );
  assert.deepStrictEqual(Array.from(page.data.entries), []);
  assert.strictEqual(page.data.hasMore, false);
  assert.strictEqual(page.data.nextCursor, null);

  page.retryContent();
  await flush();

  assert.deepStrictEqual(
    requests.map((request) => request.action),
    ["open", "readPage", "readPage", "open", "readPage"]
  );
  assert.deepStrictEqual(
    requests
      .filter((request) => request.action === "readPage")
      .map((request) => request.expectedRevision),
    ["3", "3", "4"]
  );
  assert.strictEqual(openCount, 2);
  assert.strictEqual(page.data.topicRevision, "4");
  assert.strictEqual(page.data.topic.title, "新版专题");
  assert.deepStrictEqual(
    Array.from(page.data.entries, (entry) => entry.id),
    ["entry-new-page-one"]
  );
  assert.strictEqual(page.data.contentErrorCode, "");
  assert.strictEqual(page.data.contentErrorMessage, "");
  assert.strictEqual(page.data.hasMore, false);
});

test("小专题详情卸载后不展示晚到的扣星结果", async () => {
  const response = deferred();
  const actions = [];
  const harness = createWx({
    callFunction(request) {
      actions.push(request.data.action);
      return response.promise;
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    {
      wx: harness.wx
    }
  );

  page.onLoad({ id: "topic-one" });
  page.onUnload();
  response.resolve({
    result: {
      success: true,
      firstUnlock: true,
       chargedStars: 10,
       topic: { id: "topic-one", title: "测试专题" },
       topicRevision: 1,
       hasMore: true,
      nextCursor: { entryOffset: 0, blockOffset: 0 }
    }
  });
  await flush();

  assert.deepStrictEqual(actions, ["open"]);
  assert.strictEqual(page.data.topic, null);
  assert.strictEqual(harness.calls.toasts.length, 0);
});

test("小专题详情卸载后不写入晚到的正文页", async () => {
  const pageResponse = deferred();
  const actions = [];
  const harness = createWx({
    callFunction(request) {
      actions.push(request.data.action);

      if (request.data.action === "open") {
        return Promise.resolve({
          result: {
            success: true,
            firstUnlock: false,
             chargedStars: 0,
             topic: { id: "topic-late-page", title: "晚到正文专题" },
             topicRevision: 1,
             hasMore: true,
            nextCursor: { entryOffset: 0, blockOffset: 0 }
          }
        });
      }

      return pageResponse.promise;
    }
  });
  const page = loadPage(
    "miniprogram/pages/specialTopicDetail/specialTopicDetail.js",
    { wx: harness.wx }
  );

  page.onLoad({ id: "topic-late-page" });
  await flush();
  assert.deepStrictEqual(actions, ["open", "readPage"]);
  assert.strictEqual(page.data.contentLoading, true);

  const dataBeforeUnloadResponse = JSON.parse(JSON.stringify(page.data));
  const toastCountBeforeUnloadResponse = harness.calls.toasts.length;
  page.onUnload();
  pageResponse.resolve({
     result: {
       success: true,
       topicRevision: 1,
       entries: [{ id: "entry-too-late" }],
      hasMore: false,
      nextCursor: null
    }
  });
  await flush();

  assert.strictEqual(
    JSON.stringify(page.data),
    JSON.stringify(dataBeforeUnloadResponse)
  );
  assert.deepStrictEqual(Array.from(page.data.entries), []);
  assert.strictEqual(
    harness.calls.toasts.length,
    toastCountBeforeUnloadResponse
  );
});

test("音频播放器拒绝原始云路径和非 HTTPS 地址", async () => {
  for (const relativePath of [
    "miniprogram/pages/articleAudio/articleAudio.js",
    "miniprogram/pages/bookAudio/bookAudio.js"
  ]) {
    const harness = createWx({
      async callFunction(request) {
        assert.strictEqual(request.name, "getAudioManifest");
        return {
          result: {
            success: true,
            available: true,
            manifest: {
              tracks: [
                { trackNo: 1, src: "cloud://env/private/one.mp3" },
                { trackNo: 2, fileID: "cloud://env/private/two.mp3" },
                {
                  trackNo: 3,
                  tempFileURL: "cloud://env/private/three.mp3"
                },
                { trackNo: 4, src: "http://signed.example/four.mp3" }
              ]
            }
          }
        };
      }
    });
    const page = loadPage(relativePath, {
      requireMap: {
        "../../utils/contents": {
          loadContentDetail: async () => ({
            available: true,
            audioAvailable: true,
            id: "secure-audio"
          })
        }
      },
      wx: harness.wx
    });

    await page.onLoad({ id: "secure-audio" });
    await flush();

    assert.strictEqual(page.data.audioStatus, "error");
    assert.strictEqual(page.data.hasAudio, false);
    assert.strictEqual(harness.createdAudioContexts.length, 0);
    page.onUnload();
  }
});

test("音频多轨切轨，单轨快进并循环倍速", () => {
  const harness = createWx();
  const page = loadPage("miniprogram/pages/bookAudio/bookAudio.js", {
    requireMap: {
      "../../utils/contents": {
        loadContentDetail: async () => null
      }
    },
    wx: harness.wx
  });

  page.tracks = [
    { durationSeconds: 60, src: "https://signed.example/one.mp3?token=test" },
    { durationSeconds: 80, src: "https://signed.example/two.mp3?token=test" }
  ];
  page.currentTrackIndex = 0;
  page.trackDuration = 60;
  page.setData({ audioStatus: "ready", hasAudio: true, isPlaying: false });
  page.audioContext = createAudioContext();
  page.seekForward();
  assert.strictEqual(page.currentTrackIndex, 1);
  assert.strictEqual(
    harness.createdAudioContexts[harness.createdAudioContexts.length - 1].src,
    "https://signed.example/two.mp3?token=test"
  );

  const singleContext = createAudioContext();
  singleContext.currentTime = 10;
  singleContext.duration = 100;
  page.tracks = [
    { durationSeconds: 100, src: "https://signed.example/one.mp3?token=test" }
  ];
  page.currentTrackIndex = 0;
  page.audioContext = singleContext;
  page.trackDuration = 100;
  page.seekForward();
  assert.strictEqual(singleContext.seekTarget, 25);

  page.setData({ playbackRate: 1, playbackRateText: "1倍" });
  page.cyclePlaybackRate();
  assert.strictEqual(page.data.playbackRate, 1.25);
  assert.strictEqual(singleContext.playbackRate, 1.25);
});

test("会员消息使用既有行打开列表并标记所选消息已读", async () => {
  const cloudCalls = [];
  const storage = new Map([
    ["familyInviteCache", { token: "a".repeat(64) }],
    ["pendingFamilyInvite", { token: "b".repeat(64) }],
    ["pendingMemberIntent", { type: "quiz", questionId: "0001" }],
    ["pendingQuizFocus", { questionId: "0001" }],
    ["bookCatalogCommentDraft", { comment: "本机读后感草稿" }],
    ["summaryReadContentIds", ["legacy-read-id"]]
  ]);
  const harness = createWx({
    async callFunction(request) {
      cloudCalls.push(request);
      if (request.data.action === "list") {
        return {
          result: {
            messages: [
              {
                content: "欢迎加入少年会员。",
                id: "message-a",
                isRead: false,
                title: "欢迎消息"
              }
            ],
            success: true
          }
        };
      }
      return { result: { success: true } };
    },
    storage
  });
  const page = loadPage("miniprogram/pages/memberSettings/memberSettings.js", {
    app: {
      globalData: {
        memberProfile: { phoneMasked: "138****0000" },
        readerNotes: []
      }
    },
    wx: harness.wx
  });

  page.onShow();
  await page.openMemberMessages();
  await flush();
  assert.strictEqual(harness.calls.showActionSheet.length, 1);
  assert(
    cloudCalls.some(
      (request) =>
        request.name === "memberInbox" &&
        request.data.action === "markRead" &&
        request.data.messageId === "message-a"
    )
  );
  page.clearLocalSensitiveState();
  assert.strictEqual(storage.has("familyInviteCache"), false);
  assert.strictEqual(storage.has("pendingFamilyInvite"), false);
  assert.strictEqual(storage.has("pendingMemberIntent"), false);
  assert.strictEqual(storage.has("pendingQuizFocus"), false);
  assert.strictEqual(storage.has("bookCatalogCommentDraft"), false);
  assert.strictEqual(storage.has("summaryReadContentIds"), false);
});

test("读后感页经 EventChannel 增量加载并在隐藏时清空密码", async () => {
  const eventChannel = createEventChannel();
  const harness = createWx({
    eventChannel,
    async callFunction(request) {
      assert.strictEqual(request.name, "getNotes");
      return {
        result: {
          success: true,
          notes: [
            {
              bookTitle: "第二篇书稿",
              completedAt: "2026-07-13T00:00:00.000Z",
              content: "第二篇读后感",
              id: "note-b"
            }
          ],
          hasMore: false,
          nextOffset: null,
          total: 2
        }
      };
    }
  });
  const page = loadPage("miniprogram/pages/readerNotes/readerNotes.js", {
    eventChannel,
    getOpenerEventChannel: () => eventChannel,
    wx: harness.wx
  });

  page.onLoad();
  page.onShow();
  eventChannel.emit("readerNotes", {
    notes: [
      {
        bookTitle: "测试书稿",
        completedAt: "2026-07-14T00:00:00.000Z",
        content: "测试读后感",
        id: "note-a"
      }
    ],
    password: "12345678",
    hasMore: true,
    nextOffset: 1,
    total: 2
  });
  assert.strictEqual(page.data.hasNotes, true);
  assert.strictEqual(page.data.notes.length, 1);

  await page.onReachBottom();

  assert.strictEqual(harness.calls.cloud[0].data.password, "12345678");
  assert.strictEqual(harness.calls.cloud[0].data.offset, 1);
  assert.strictEqual(harness.calls.cloud[0].data.limit, 20);
  assert.strictEqual(page.data.notes.length, 2);
  assert.strictEqual(page.data.notes[1].displayIndex, 2);
  assert.strictEqual(page.data.notesTotal, 2);
  assert.strictEqual(page.data.notesHasMore, false);
  page.onHide();
  assert.strictEqual(page.data.hasNotes, false);
  assert.strictEqual(page.data.notes.length, 0);
  assert.strictEqual(page.noteAccessPassword, "");
});

test("少年爱只展示云端发布题，空题库和断网都不回退本地题", async () => {
  const publishedQuestion = {
    id: "quiz-from-admin",
    revision: "revision-from-admin",
    topic: "管理员发布",
    department: "测试科室",
    source: "结构化草稿",
    question: "管理员发布的题目",
    options: [
      { key: "A", label: "选择一", text: "选项一" },
      { key: "B", label: "选择二", text: "选项二" }
    ],
    explanation: "管理员发布的解释"
  };
  const publishedHarness = createWx({
    async callFunction(request) {
      assert.strictEqual(request.name, "quizCenter");
      assert.strictEqual(request.data.action, "list");
      return {
        result: {
          questions: [publishedQuestion],
          source: "cloud",
          success: true
        }
      };
    }
  });
  const publishedPage = loadPage("miniprogram/pages/ai/ai.js", {
    wx: publishedHarness.wx
  });
  assert.deepStrictEqual(Array.from(publishedPage.data.questions), []);
  publishedPage.onLoad();
  await flush();
  assert.deepStrictEqual(
    Array.from(publishedPage.data.questions, (question) => question.id),
    [publishedQuestion.id]
  );
  assert.strictEqual(publishedPage.data.questionSource, "cloud");
  assert.strictEqual(publishedPage.data.sourceNotice, "");

  const emptyHarness = createWx({
    async callFunction() {
      return {
        result: {
          questions: [],
          source: "cloud",
          success: true
        }
      };
    }
  });
  const emptyPage = loadPage("miniprogram/pages/ai/ai.js", {
    wx: emptyHarness.wx
  });
  emptyPage.onLoad();
  await flush();
  assert.deepStrictEqual(Array.from(emptyPage.data.questions), []);
  assert.strictEqual(emptyPage.data.sourceNotice, "暂时没有已开放的题目。");

  const offlineHarness = createWx();
  delete offlineHarness.wx.cloud;
  const offlinePage = loadPage("miniprogram/pages/ai/ai.js", {
    wx: offlineHarness.wx
  });
  offlinePage.onLoad();
  assert.deepStrictEqual(Array.from(offlinePage.data.questions), []);
  assert.strictEqual(
    offlinePage.data.sourceNotice,
    "当前无法读取已开放题目，请联网后重试。"
  );
});

test("AI 云端题目在任意作答状态都保留解释入口", () => {
  const source = fs.readFileSync(
    path.join(root, "miniprogram/pages/ai/ai.wxml"),
    "utf8"
  );
  assert(source.includes("wx:if=\"{{question.id === '0001'}}\""));
  assert(source.includes("wx:else"));
  assert(!source.includes("question.id === '0001' &&"));
});

test("陈旧注册脚本和未注册 wo 页面已移除", () => {
  assert.strictEqual(
    fs.existsSync(path.join(root, "miniprogram/pages/register2/regitser2.js")),
    false
  );
  assert.strictEqual(
    fs.existsSync(path.join(root, "miniprogram/pages/wo/wo.js")),
    false
  );
});

(async () => {
  let passed = 0;

  for (const { handler, name } of tests) {
    try {
      await handler();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }

  if (!process.exitCode) {
    console.log(`小程序前端回归测试通过：${passed}/${tests.length}`);
  }
})();
