const { loadContentDetail, markContentRead } = require("../../utils/contents");

function rememberTextIntent(contentId) {
  if (!contentId) {
    return;
  }

  try {
    wx.setStorageSync("pendingMemberIntent", {
      type: "text",
      page: "article",
      contentId,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn("保存正文登录回跳失败：", error);
  }
}

Page({
  data: {
    content: null,
    comment: "",
    commentLength: 0,
    submitting: false,
    submitted: false,
    needsRevision: false,
    readRecorded: false,
    reviewPending: false
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

  onShow() {
    if (
      this.awaitingMembership &&
      this.pendingContentId &&
      !this.contentLoading
    ) {
      this.loadContent(this.pendingContentId);
    }
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
      this.handleUnavailableContent(content || {});
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

    this.awaitingMembership = false;
    this.setData({ content, readRecorded: true });
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
            this.leaveUnavailablePage();
          }
        }
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
          this.leaveUnavailablePage();
        }
      },
      fail: () => this.leaveUnavailablePage()
    });
  },

  handleUnavailableContent(content) {
    if (this.pageUnloaded) {
      return;
    }

    if (
      content.requiresMembership ||
      [
        "MEMBER_REQUIRED",
        "MEMBER_LOGIN_REQUIRED",
        "MEMBER_SESSION_EXPIRED",
        "ACCOUNT_INACTIVE"
      ].includes(content.errorCode)
    ) {
      this.awaitingMembership = true;
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

          if (!result.confirm) {
            this.leaveUnavailablePage();
            return;
          }

          rememberTextIntent(this.pendingContentId);
          wx.switchTab({
            url: "/pages/member/member",
            fail: () => this.leaveUnavailablePage()
          });
        },
        fail: () => this.leaveUnavailablePage()
      });
      return;
    }

    if (
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
        title: "内容读取失败",
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
            this.leaveUnavailablePage();
          }
        },
        fail: () => this.leaveUnavailablePage()
      });
      return;
    }

    wx.showToast({
      title: content.errorMessage || "内容不存在或尚未开放",
      icon: "none"
    });
    this.backTimer = setTimeout(() => {
      if (!this.pageUnloaded) {
        this.leaveUnavailablePage();
      }
    }, 1200);
  },

  leaveUnavailablePage() {
    if (this.pageUnloaded) {
      return;
    }

    const pages = getCurrentPages();

    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.redirectTo({
        url: "/pages/bookCatalog/bookCatalog"
      });
    }
  },

  onUnload() {
    this.pageUnloaded = true;
    this.contentRequestId = (this.contentRequestId || 0) + 1;
    this.contentLoading = false;
    this.submitRequestId = (this.submitRequestId || 0) + 1;
    clearTimeout(this.backTimer);
  },

  onCommentInput(event) {
    const comment = event.detail.value;

    this.setData({
      comment,
      commentLength: Array.from(comment.trim()).length,
      submitted: false,
      reviewPending: false
    });
  },

  openAudio() {
    if (!this.data.content) {
      return;
    }

    if (!this.data.content.audioAvailable) {
      wx.showToast({
        title: "配音资源尚未开放",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/articleAudio/articleAudio?id=${encodeURIComponent(
        this.data.content.id
      )}`
    });
  },

  onInlineImageError(event) {
    const sectionIndex = Number(event.currentTarget.dataset.sectionIndex);
    const blockIndex = Number(event.currentTarget.dataset.blockIndex);

    if (!Number.isInteger(sectionIndex) || !Number.isInteger(blockIndex)) {
      return;
    }

    const update = {};
    update[`content.sections[${sectionIndex}].blocks[${blockIndex}].imageFailed`] =
      true;
    this.setData(update);
  },

  async submitComment() {
    const { content, comment, submitting } = this.data;
    const normalizedComment = comment.trim();
    const commentLength = Array.from(normalizedComment).length;

    if (submitting || !content || this.pageUnloaded) {
      return;
    }

    if (!this.data.readRecorded) {
      wx.showToast({
        title: "请先打开并同步当前正文",
        icon: "none"
      });
      return;
    }

    if (commentLength < 100 || commentLength > 2000) {
      wx.showToast({
        title: "读后感需为100至2000字",
        icon: "none"
      });
      return;
    }

    this.setData({ submitting: true });
    const requestId = (this.submitRequestId || 0) + 1;
    this.submitRequestId = requestId;
    wx.showLoading({
      title: "正在提交",
      mask: true
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "saveRecord",
        data: {
          contentId: content.id,
          comment: normalizedComment
        }
      });
      const result = response.result || {};

      if (this.pageUnloaded || requestId !== this.submitRequestId) {
        return;
      }

      if (!result.success) {
        if (
          [
            "NOT_REGISTERED",
            "MEMBER_LOGIN_REQUIRED",
            "MEMBER_SESSION_EXPIRED",
            "ACCOUNT_INACTIVE"
          ].includes(result.code)
        ) {
          wx.showModal({
            title: result.code === "ACCOUNT_INACTIVE"
              ? "会员账号不可用"
              : "请登录少年会员",
            content: result.message || "提交读后感前，请先登录少年会员。",
            confirmText: "去少年我",
            success: (modalResult) => {
              if (this.pageUnloaded) {
                return;
              }

              if (modalResult.confirm) {
                rememberTextIntent(content.id || this.pendingContentId);
                wx.switchTab({ url: "/pages/member/member" });
              }
            }
          });
          return;
        }

        if (result.code === "READ_REQUIRED") {
          this.setData({ readRecorded: false });
          wx.showModal({
            title: "请先阅读正文",
            content: result.message || "提交前需要先打开当前版本正文。",
            showCancel: false,
            success: () => {
              if (!this.pageUnloaded) {
                this.loadContent(content.id);
              }
            }
          });
          return;
        }

        if (result.code === "COMMENT_NOT_ALLOWED") {
          this.setData({
            submitted: false,
            needsRevision: true
          });
        }

        wx.showToast({
          title: result.message || "提交失败",
          icon: "none"
        });
        return;
      }

      this.setData({
        comment: "",
        commentLength: 0,
        submitted: !result.requiresReview,
        needsRevision: false,
        reviewPending: Boolean(result.requiresReview)
      });

      if (result.requiresReview) {
        wx.showModal({
          title: "需要人工复审",
          content: "读后感已保存并进入人工复审，复审通过前不会发放红五星或开放全本。",
          showCancel: false
        });
        return;
      }

      wx.showModal({
        title: "提交成功",
        content: result.starAwarded
          ? "阅读记录已保存，已获得50颗红五星，可前往“少年我”查看。"
          : "读后感已更新，可前往“少年我”查看。",
        cancelText: "继续阅读",
        confirmText: "去少年我",
        success: (modalResult) => {
          if (this.pageUnloaded) {
            return;
          }

          if (modalResult.confirm) {
            wx.switchTab({
              url: "/pages/member/member"
            });
          }
        }
      });
    } catch (error) {
      if (this.pageUnloaded || requestId !== this.submitRequestId) {
        return;
      }

      console.error("submitComment error:", error);
      wx.showToast({
        title: "提交请求失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
      if (!this.pageUnloaded && requestId === this.submitRequestId) {
        this.setData({ submitting: false });
      }
    }
  }
});
