const PAGE_SIZE = 20;
const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;
const COMMENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizeText(value, maximum = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? text.slice(0, maximum) : text;
}

function timeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : NaN;
  }

  if (value && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }

  if (value && value.$date) {
    return new Date(value.$date).getTime();
  }

  return new Date(value).getTime();
}

function formatTime(value) {
  const timestamp = timeValue(value);

  if (!Number.isFinite(timestamp)) {
    return "提交时间未知";
  }

  const date = new Date(timestamp);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeRecord(source) {
  const item = source && typeof source === "object" ? source : {};
  const id = normalizeText(item.id, 128).toLowerCase();
  const commentHash = normalizeText(item.commentHash, 64).toLowerCase();
  const comment = normalizeText(item.comment, 2000);

  if (
    !RECORD_ID_PATTERN.test(id) ||
    !COMMENT_HASH_PATTERN.test(commentHash) ||
    !comment
  ) {
    return null;
  }

  return {
    id,
    commentHash,
    contentId: normalizeText(item.contentId, 64),
    contentRevision: normalizeText(item.contentRevision, 128),
    title: normalizeText(item.title, 160) || "未命名阅读内容",
    comment,
    reviewCategory:
      normalizeText(item.reviewCategory, 80) || "敏感词命中",
    submittedAtText: formatTime(item.submittedAt)
  };
}

function normalizeRecords(source) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.map(normalizeRecord).filter(Boolean);
}

function mergeRecords(current, incoming) {
  const merged = [];
  const seen = new Set();

  current.concat(incoming).forEach((item) => {
    if (!item || seen.has(item.id)) {
      return;
    }

    seen.add(item.id);
    merged.push(item);
  });

  return merged;
}

function isPermissionError(code) {
  return ["ADMIN_FORBIDDEN", "OPENID_UNAVAILABLE"].includes(
    normalizeText(code, 64)
  );
}

Page({
  data: {
    loading: false,
    accessChecked: false,
    authorized: false,
    accessMessage: "",
    loadError: "",
    records: [],
    hasMore: false,
    nextOffset: null,
    actionRecordId: ""
  },

  onLoad() {
    this.pageDestroyed = false;
    this.pageVisible = false;
    this.listLoading = false;
    this.reviewPromptOpen = false;
    this.listRequestId = 0;
    this.reviewOperationId = 0;
  },

  onShow() {
    this.pageVisible = true;
    this.loadPending({ append: false });
  },

  onHide() {
    this.pageVisible = false;
    this.listRequestId += 1;
    this.reviewOperationId += 1;
    this.listLoading = false;
    this.reviewPromptOpen = false;
    this.setData({
      loading: false,
      actionRecordId: ""
    });
  },

  onUnload() {
    this.pageDestroyed = true;
    this.pageVisible = false;
    this.listRequestId += 1;
    this.reviewOperationId += 1;
    this.listLoading = false;
    this.reviewPromptOpen = false;
  },

  async loadPending({ append = false, quiet = false } = {}) {
    if (
      this.listLoading ||
      this.pageDestroyed ||
      !this.pageVisible ||
      (append && !this.data.hasMore)
    ) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        accessChecked: true,
        authorized: false,
        accessMessage: "云服务暂不可用，请检查网络后重试。",
        loadError: ""
      });
      return;
    }

    const offset = append && Number.isInteger(this.data.nextOffset)
      ? this.data.nextOffset
      : 0;
    const requestId = this.listRequestId + 1;
    this.listRequestId = requestId;
    this.listLoading = true;
    this.setData({
      loading: true,
      loadError: quiet ? this.data.loadError : ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "moderationCenter",
        data: {
          action: "listPending",
          limit: PAGE_SIZE,
          offset
        }
      });
      const result = response.result || {};

      if (
        this.pageDestroyed ||
        !this.pageVisible ||
        requestId !== this.listRequestId
      ) {
        return;
      }

      if (!result.success) {
        if (isPermissionError(result.code)) {
          this.setData({
            accessChecked: true,
            authorized: false,
            accessMessage:
              result.message || "当前微信没有读后感复审权限。",
            loadError: "",
            records: [],
            hasMore: false,
            nextOffset: null
          });
          return;
        }

        throw new Error(result.message || "待复审读后感读取失败");
      }

      const incoming = normalizeRecords(result.records);
      const current = append ? this.data.records : [];
      this.setData({
        accessChecked: true,
        authorized: true,
        accessMessage: "",
        loadError: "",
        records: mergeRecords(current, incoming),
        hasMore: result.hasMore === true,
        nextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
    } catch (error) {
      console.error("load pending moderation records error:", error);
      if (
        !this.pageDestroyed &&
        this.pageVisible &&
        requestId === this.listRequestId
      ) {
        this.setData({
          accessChecked: true,
          loadError: quiet
            ? this.data.loadError
            : "待复审读后感读取失败，请稍后重试。"
        });
      }
    } finally {
      if (requestId === this.listRequestId) {
        this.listLoading = false;
        if (!this.pageDestroyed && this.pageVisible) {
          this.setData({ loading: false });
        }
      }
    }
  },

  refreshPending() {
    if (!this.listLoading) {
      this.loadPending({ append: false });
    }
  },

  retryAccess() {
    if (!this.listLoading) {
      this.loadPending({ append: false });
    }
  },

  loadMore() {
    if (!this.listLoading && this.data.hasMore) {
      this.loadPending({ append: true });
    }
  },

  confirmReview(event) {
    if (this.data.actionRecordId || this.reviewPromptOpen) {
      return;
    }

    const dataset =
      event && event.currentTarget && event.currentTarget.dataset || {};
    const recordId = normalizeText(dataset.recordId, 128).toLowerCase();
    const decision = normalizeText(dataset.decision, 16).toLowerCase();
    const record = this.data.records.find((item) => item.id === recordId);

    if (!record || !["approve", "reject"].includes(decision)) {
      wx.showToast({
        title: "待复审记录已变化，请刷新后重试",
        icon: "none"
      });
      return;
    }

    const approving = decision === "approve";
    this.reviewPromptOpen = true;
    wx.showModal({
      title: approving ? "确认批准读后感？" : "确认退回修改？",
      content: approving
        ? "批准后系统会按规则发放一次50颗红五星，并开放对应整书权限。"
        : "退回后读者可以修改并重新提交，原读后感不会被删除。",
      confirmText: approving ? "批准" : "退回修改",
      confirmColor: approving ? "#2b9878" : "#b44a42",
      success: (result) => {
        this.reviewPromptOpen = false;
        if (
          result.confirm &&
          !this.pageDestroyed &&
          this.pageVisible
        ) {
          this.reviewRecord(record, decision);
        }
      },
      fail: () => {
        this.reviewPromptOpen = false;
      }
    });
  },

  async reviewRecord(record, decision) {
    if (
      this.data.actionRecordId ||
      this.pageDestroyed ||
      !this.pageVisible
    ) {
      return;
    }

    const operationId = this.reviewOperationId + 1;
    this.reviewOperationId = operationId;
    this.setData({ actionRecordId: record.id });

    try {
      const response = await wx.cloud.callFunction({
        name: "moderationCenter",
        data: {
          action: "review",
          recordId: record.id,
          expectedCommentHash: record.commentHash,
          decision
        }
      });
      const result = response.result || {};

      if (
        this.pageDestroyed ||
        !this.pageVisible ||
        operationId !== this.reviewOperationId
      ) {
        return;
      }

      if (!result.success) {
        if (isPermissionError(result.code)) {
          this.setData({
            accessChecked: true,
            authorized: false,
            accessMessage:
              result.message || "当前微信没有读后感复审权限。",
            actionRecordId: ""
          });
          return;
        }

        if (
          ["REVIEW_STALE", "RECORD_NOT_PENDING_REVIEW"].includes(result.code)
        ) {
          wx.showToast({
            title: "记录已变化，正在刷新",
            icon: "none"
          });
          await this.loadPending({ append: false, quiet: true });
          return;
        }

        throw new Error(result.message || "读后感复审失败");
      }

      this.setData({
        records: this.data.records.filter(
          (item) =>
            item.id !== record.id || item.commentHash !== record.commentHash
        )
      });
      wx.showToast({
        title: decision === "approve"
          ? result.starAwarded
            ? "已批准并发放50星"
            : "已批准"
          : "已退回修改",
        icon: "success"
      });
    } catch (error) {
      console.error("review moderation record error:", error);
      if (
        !this.pageDestroyed &&
        this.pageVisible &&
        operationId === this.reviewOperationId
      ) {
        wx.showToast({
          title: error.message || "读后感复审失败，请稍后重试",
          icon: "none"
        });
      }
    } finally {
      if (
        !this.pageDestroyed &&
        this.pageVisible &&
        operationId === this.reviewOperationId
      ) {
        this.setData({ actionRecordId: "" });
      }
    }
  }
});
