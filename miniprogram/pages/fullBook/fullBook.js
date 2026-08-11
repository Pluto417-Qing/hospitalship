const BOOK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PAGE_LIMIT = 5;
const MEMBER_LOGIN_CODES = new Set([
  "MEMBER_LOGIN_REQUIRED",
  "MEMBER_SESSION_EXPIRED",
  "ACCOUNT_INACTIVE"
]);

function rememberFullBookIntent(bookId) {
  if (!BOOK_ID_PATTERN.test(String(bookId || ""))) {
    return;
  }

  try {
    wx.setStorageSync("pendingMemberIntent", {
      type: "full-book",
      bookId,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn("保存完整书稿登录回跳失败：", error);
  }
}

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function normalizeParagraphs(value, chapterId, sectionIndex) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((paragraph) => typeof paragraph === "string" && paragraph.trim())
    .slice(0, 100)
    .map((paragraph, paragraphIndex) => ({
      key: `${chapterId}-section-${sectionIndex}-paragraph-${paragraphIndex}`,
      text: paragraph.trim().slice(0, 10000)
    }));
}

function normalizeChapters(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((chapter, chapterIndex) => {
      const id = normalizeText(chapter && chapter.id, 128);
      const title = normalizeText(chapter && chapter.title, 160);

      if (!id || !title || !Array.isArray(chapter.sections)) {
        return null;
      }

      const sections = chapter.sections
        .slice(0, 40)
        .map((section, sectionIndex) => {
          const heading = normalizeText(section && section.heading, 160);
          const paragraphs = normalizeParagraphs(
            section && section.paragraphs,
            id,
            sectionIndex
          );

          if (!heading && paragraphs.length === 0) {
            return null;
          }

          return {
            key: `${id}-section-${sectionIndex}`,
            heading,
            paragraphs
          };
        })
        .filter(Boolean);

      if (sections.length === 0) {
        return null;
      }

      return {
        id,
        title,
        displayNo: String(chapterIndex + 1).padStart(2, "0"),
        sections
      };
    })
    .filter(Boolean);
}

function normalizePdf(value) {
  const pdf = value && typeof value === "object" ? value : {};
  const downloadUrl = normalizeText(pdf.downloadUrl, 4096);

  return {
    available: pdf.available === true,
    downloadReady:
      pdf.downloadReady === true &&
      /^https:\/\//.test(downloadUrl) &&
      !/[\s\\\u0000-\u001f]/.test(downloadUrl),
    downloadUrl,
    fileName: normalizeText(pdf.fileName, 180) || "完整书稿.pdf",
    message: normalizeText(pdf.message, 160)
  };
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    downloading: false,
    errorCode: "",
    errorMessage: "",
    book: null,
    chapters: [],
    hasMore: false,
    nextOffset: null
  },

  onLoad(options = {}) {
    this.pageUnloaded = false;
    let bookId = "";

    try {
      bookId = decodeURIComponent(options.bookId || "").trim();
    } catch (error) {
      bookId = "";
    }

    this.bookId = BOOK_ID_PATTERN.test(bookId) ? bookId : "";

    if (!this.bookId) {
      this.setData({
        loading: false,
        errorCode: "INVALID_BOOK_ID",
        errorMessage: "书稿编号无效，请返回书目重新进入。"
      });
      return;
    }

    this.loadBook({ reset: true });
  },

  onUnload() {
    this.pageUnloaded = true;
    this.requestId = (this.requestId || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadBook({ reset: true }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    this.loadMore();
  },

  async loadBook({ reset = false } = {}) {
    if (
      this.pageUnloaded ||
      this.requestPending ||
      (!reset && (!this.data.hasMore || !Number.isInteger(this.data.nextOffset)))
    ) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        loading: false,
        loadingMore: false,
        errorCode: "CLOUD_UNAVAILABLE",
        errorMessage: "云服务暂不可用，请检查网络后重试。"
      });
      return;
    }

    const offset = reset ? 0 : this.data.nextOffset;
    const requestId = (this.requestId || 0) + 1;
    this.requestId = requestId;
    this.requestPending = true;
    this.setData(
      reset
        ? {
            loading: true,
            loadingMore: false,
            errorCode: "",
            errorMessage: ""
          }
        : { loadingMore: true }
    );

    try {
      const response = await wx.cloud.callFunction({
        name: "getFullBookAccess",
        data: {
          bookId: this.bookId,
          offset,
          limit: PAGE_LIMIT
        }
      });
      const result = response.result || {};

      if (this.pageUnloaded || requestId !== this.requestId) {
        return;
      }

      if (!result.success) {
        this.handleLoadFailure(result, { reset });
        return;
      }

      const remoteBook = result.book || {};
      const incoming = normalizeChapters(remoteBook.chapters);
      const existing = reset ? [] : this.data.chapters;
      const existingIds = new Set(existing.map((chapter) => chapter.id));
      const chapters = existing.concat(
        incoming
          .filter((chapter) => !existingIds.has(chapter.id))
          .map((chapter, index) => ({
            ...chapter,
            displayNo: String(existing.length + index + 1).padStart(2, "0")
          }))
      );
      const nextOffset = Number(result.nextOffset);
      const hasMore = result.hasMore === true && Number.isInteger(nextOffset);

      this.setData({
        book: {
          id: normalizeText(remoteBook.id, 64),
          title: normalizeText(remoteBook.title, 160) || "完整书稿",
          subtitle: normalizeText(remoteBook.subtitle, 240),
          pdf: normalizePdf(remoteBook.pdf)
        },
        chapters,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        errorCode: "",
        errorMessage: ""
      });
    } catch (error) {
      console.error("load full book error:", error);

      if (!this.pageUnloaded && requestId === this.requestId) {
        if (reset) {
          this.setData({
            errorCode: "BOOK_REQUEST_FAILED",
            errorMessage: "完整书稿读取失败，请检查网络后重试。"
          });
        } else {
          wx.showToast({
            title: "更多章节加载失败",
            icon: "none"
          });
        }
      }
    } finally {
      if (!this.pageUnloaded && requestId === this.requestId) {
        this.requestPending = false;
        this.setData({
          loading: false,
          loadingMore: false
        });
      }
    }
  },

  handleLoadFailure(result, { reset }) {
    const code = String(result.code || "BOOK_READ_FAILED");
    const message = result.message || "完整书稿读取失败";

    if (!reset) {
      wx.showToast({ title: message, icon: "none" });
      return;
    }

    this.setData({
      book: null,
      chapters: [],
      hasMore: false,
      nextOffset: null,
      errorCode: code,
      errorMessage: message
    });

    if (MEMBER_LOGIN_CODES.has(code)) {
      this.promptMemberLogin(code, message);
    }
  },

  promptMemberLogin(code, message) {
    if (this.loginPromptVisible || this.pageUnloaded) {
      return;
    }

    this.loginPromptVisible = true;
    wx.showModal({
      title: code === "ACCOUNT_INACTIVE" ? "会员账号不可用" : "请登录少年会员",
      content: message,
      cancelText: "返回书目",
      confirmText: "去少年我",
      success: (result) => {
        this.loginPromptVisible = false;

        if (result.confirm) {
          rememberFullBookIntent(this.bookId);
          wx.switchTab({
            url: "/pages/member/member",
            fail: () => this.returnCatalog()
          });
        } else {
          this.returnCatalog();
        }
      },
      fail: () => {
        this.loginPromptVisible = false;
      }
    });
  },

  retryLoad() {
    this.loadBook({ reset: true });
  },

  loadMore() {
    this.loadBook({ reset: false });
  },

  downloadPdf() {
    if (this.data.downloading || !this.data.book) {
      return;
    }

    const pdf = this.data.book.pdf || {};

    if (!pdf.downloadReady || !pdf.downloadUrl) {
      wx.showToast({
        title: pdf.message || "PDF暂时无法下载",
        icon: "none"
      });
      return;
    }

    this.setData({ downloading: true });
    wx.showLoading({ title: "正在下载PDF", mask: true });
    wx.downloadFile({
      url: pdf.downloadUrl,
      success: (downloadResult) => {
        if (
          this.pageUnloaded ||
          Number(downloadResult.statusCode) !== 200 ||
          !downloadResult.tempFilePath
        ) {
          if (!this.pageUnloaded) {
            wx.showToast({ title: "PDF下载失败", icon: "none" });
          }
          return;
        }

        wx.openDocument({
          filePath: downloadResult.tempFilePath,
          fileType: "pdf",
          showMenu: true,
          fail: () => {
            if (!this.pageUnloaded) {
              wx.showToast({ title: "PDF打开失败", icon: "none" });
            }
          }
        });
      },
      fail: () => {
        if (!this.pageUnloaded) {
          wx.showToast({ title: "PDF下载失败，请重试", icon: "none" });
        }
      },
      complete: () => {
        wx.hideLoading();

        if (!this.pageUnloaded) {
          this.setData({ downloading: false });
        }
      }
    });
  },

  returnCatalog() {
    if (this.pageUnloaded) {
      return;
    }

    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }

    wx.redirectTo({ url: "/pages/bookCatalog/bookCatalog" });
  }
});
