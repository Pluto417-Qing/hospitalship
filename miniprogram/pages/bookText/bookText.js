const { loadContentDetail, markContentRead } = require("../../utils/contents");

function rememberTextIntent(contentId) {
  if (!contentId) {
    return;
  }

  try {
    wx.setStorageSync("pendingMemberIntent", {
      type: "text",
      page: "bookText",
      contentId,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn("保存正文登录回跳失败：", error);
  }
}

Page({
  data: {
    content: null
  },

  async onLoad(options = {}) {
    this.pageUnloaded = false;
    let contentId = "";

    try {
      contentId = decodeURIComponent(options.id || "");
    } catch (error) {
      contentId = "";
    }

    this.pendingContentId = contentId;
    await this.loadContent(contentId);
  },

  async loadContent(contentId) {
    if (!contentId || this.contentLoading || this.pageUnloaded) {
      return;
    }

    const requestId = (this.contentRequestId || 0) + 1;
    this.contentRequestId = requestId;
    this.contentLoading = true;
    const content = await loadContentDetail(contentId, "text");

    if (this.pageUnloaded || requestId !== this.contentRequestId) {
      return;
    }

    if (!content || !content.available) {
      this.contentLoading = false;
      if (content && content.requiresMembership) {
        wx.showModal({
          title: content.errorCode === "ACCOUNT_INACTIVE"
            ? "会员账号不可用"
            : "正文仅向已登录会员开放",
          content: content.errorMessage || "请先在“少年我”登录会员。",
          cancelText: "返回",
          confirmText: "去少年我",
          success: (result) => {
            if (this.pageUnloaded) {
              return;
            }

            if (result.confirm) {
              rememberTextIntent(this.pendingContentId);
              wx.switchTab({
                url: "/pages/member/member",
                fail: () => this.returnCatalog()
              });
            } else {
              this.returnCatalog();
            }
          },
          fail: () => this.returnCatalog()
        });
        return;
      }

      if (
        content &&
        [
          "CLOUD_UNAVAILABLE",
          "CONTENT_REQUEST_FAILED",
          "CONTENT_READ_FAILED",
          "CONTENT_ASSET_SIGN_FAILED"
        ].includes(
          content.errorCode
        )
      ) {
        wx.showModal({
          title: "文本读取失败",
          content: content.errorMessage || "请检查网络后重试。",
          cancelText: "返回",
          confirmText: "重试",
          success: (result) => {
            if (this.pageUnloaded) {
              return;
            }

            if (result.confirm) {
              this.loadContent(this.pendingContentId);
            } else {
              this.returnCatalog();
            }
          },
          fail: () => this.returnCatalog()
        });
        return;
      }

      wx.showToast({
        title: (content && content.errorMessage) || "文本尚未开放",
        icon: "none"
      });
      this.backTimer = setTimeout(() => {
        if (!this.pageUnloaded) {
          this.returnCatalog();
        }
      }, 1000);
      return;
    }

    const readResult = await markContentRead(
      content.id,
      content.currentRevision
    );

    if (this.pageUnloaded || requestId !== this.contentRequestId) {
      return;
    }

    this.contentLoading = false;
    const readRecorded = readResult === true || Boolean(readResult && readResult.success);

    if (!readRecorded) {
      this.handleReadStateFailure(content, readResult || {});
      return;
    }

    this.setData({ content });
  },

  handleReadStateFailure(content, result) {
    const code = String(result.code || "");

    if (
      [
        "MEMBER_LOGIN_REQUIRED",
        "MEMBER_SESSION_EXPIRED",
        "ACCOUNT_INACTIVE"
      ].includes(code)
    ) {
      wx.showModal({
        title: code === "ACCOUNT_INACTIVE" ? "会员账号不可用" : "请登录少年会员",
        content: result.message || "阅读正文前，请先登录少年会员。",
        cancelText: "返回",
        confirmText: "去少年我",
        success: (modalResult) => {
          if (this.pageUnloaded) {
            return;
          }

          if (modalResult.confirm) {
            rememberTextIntent(content.id || this.pendingContentId);
            wx.switchTab({ url: "/pages/member/member" });
          } else {
            this.returnCatalog();
          }
        },
        fail: () => this.returnCatalog()
      });
      return;
    }

    wx.showModal({
      title: code === "CONTENT_REVISION_CHANGED" ? "正文已更新" : "阅读状态同步失败",
      content: result.message || "暂时无法记录已阅读状态，请重试。",
      cancelText: "返回",
      confirmText: "重试",
      success: (modalResult) => {
        if (this.pageUnloaded) {
          return;
        }

        if (modalResult.confirm) {
          this.loadContent(content.id);
        } else {
          this.returnCatalog();
        }
      },
      fail: () => this.returnCatalog()
    });
  },

  onUnload() {
    this.pageUnloaded = true;
    this.contentRequestId = (this.contentRequestId || 0) + 1;
    this.contentLoading = false;
    clearTimeout(this.backTimer);
  },

  returnCatalog() {
    if (this.pageUnloaded) {
      return;
    }

    const pages = getCurrentPages();

    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }

    wx.redirectTo({
      url: "/pages/bookCatalog/bookCatalog"
    });
  },

  openArticle() {
    if (!this.data.content) {
      return;
    }

    wx.navigateTo({
      url: `/pages/article/article?id=${encodeURIComponent(this.data.content.id)}`
    });
  }
});
