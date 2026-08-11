function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    const timestamp = Math.abs(value) < 100000000000 ? value * 1000 : value;
    const date = new Date(timestamp);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) {
      return null;
    }

    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      return toDate(Number(text));
    }

    const parsedDate = new Date(text);

    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }

    const parts = text.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):?(\d{1,2})?(?::?(\d{1,2}))?)?$/
    );

    if (parts) {
      const date = new Date(
        Number(parts[1]),
        Number(parts[2]) - 1,
        Number(parts[3]),
        Number(parts[4] || 0),
        Number(parts[5] || 0),
        Number(parts[6] || 0)
      );

      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.toDate === "function") {
    try {
      return toDate(value.toDate());
    } catch (error) {
      return null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, "$date")) {
    return toDate(value.$date);
  }

  const seconds = value.seconds !== undefined ? value.seconds : value._seconds;

  if (seconds !== undefined) {
    const nanoseconds =
      value.nanoseconds !== undefined ? value.nanoseconds : value._nanoseconds;
    const timestamp = Number(seconds) * 1000 + Number(nanoseconds || 0) / 1000000;

    return toDate(timestamp);
  }

  return null;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatCompletedAt(value) {
  const date = toDate(value);

  if (!date) {
    return "完成时间未记录";
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readText(value, fallback) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }

  return String(value).trim() || fallback;
}

const NOTES_PAGE_LIMIT = 20;

function normalizeNotes(source, startIndex = 0) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.map((item, index) => {
    const note = item && typeof item === "object" ? item : {};

    return {
      id: readText(note.id, `reader-note-${index}`),
      displayIndex: startIndex + index + 1,
      bookTitle: readText(note.bookTitle, "未命名书稿"),
      content: readText(note.content, "暂无读后感内容"),
      completedAtText: formatCompletedAt(note.completedAt)
    };
  });
}

Page({
  data: {
    notes: [],
    hasNotes: false,
    notesLoading: false,
    notesHasMore: false,
    notesLoadError: "",
    notesTotal: 0
  },

  onLoad() {
    this.isPageVisible = true;
    const eventChannel =
      typeof this.getOpenerEventChannel === "function"
        ? this.getOpenerEventChannel()
        : null;

    if (eventChannel && typeof eventChannel.on === "function") {
      eventChannel.on("readerNotes", (payload = {}) => {
        if (this.isPageVisible) {
          this.initializeNotes(payload);
        }
      });
    }
  },

  onShow() {
    this.isPageVisible = true;
  },

  onHide() {
    this.isPageVisible = false;
    this.clearNotes();
  },

  onUnload() {
    this.isPageVisible = false;
    this.clearNotes({ updatePage: false });
  },

  onReachBottom() {
    return this.loadMoreNotes();
  },

  initializeNotes(payload = {}) {
    const source = Array.isArray(payload.notes) ? payload.notes : [];
    const notes = normalizeNotes(source);
    const password = String(payload.password || "");
    const nextOffset = Number(payload.nextOffset);
    const notesHasMore =
      payload.hasMore === true &&
      /^\d{8}$/.test(password) &&
      Number.isInteger(nextOffset) &&
      nextOffset >= notes.length &&
      nextOffset <= 10000;

    this.noteAccessPassword = notesHasMore ? password : "";
    this.notesNextOffset = notesHasMore ? nextOffset : null;

    this.setData({
      notes,
      hasNotes: notes.length > 0,
      notesLoading: false,
      notesHasMore,
      notesLoadError: "",
      notesTotal: Number.isInteger(Number(payload.total))
        ? Math.max(notes.length, Number(payload.total))
        : notes.length
    });
  },

  loadNotes(source = []) {
    this.initializeNotes({ notes: source });
  },

  async loadMoreNotes() {
    if (
      !this.isPageVisible ||
      this.data.notesLoading ||
      !this.data.notesHasMore ||
      !/^\d{8}$/.test(String(this.noteAccessPassword || "")) ||
      !Number.isInteger(this.notesNextOffset)
    ) {
      return;
    }

    const requestId = (this.notesRequestId || 0) + 1;
    this.notesRequestId = requestId;
    const offset = this.notesNextOffset;
    this.setData({
      notesLoading: true,
      notesLoadError: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "getNotes",
        data: {
          password: this.noteAccessPassword,
          offset,
          limit: NOTES_PAGE_LIMIT
        }
      });
      const result = response.result || {};

      if (requestId !== this.notesRequestId || !this.isPageVisible) {
        return;
      }

      if (!result.success) {
        const message = result.message || "读后感读取失败";
        this.setData({ notesLoadError: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }

      const existingIds = new Set(this.data.notes.map((item) => item.id));
      const appendedNotes = normalizeNotes(
        Array.isArray(result.notes) ? result.notes : [],
        this.data.notes.length
      ).filter((item) => !existingIds.has(item.id));
      const notes = this.data.notes.concat(appendedNotes).map((item, index) => ({
        ...item,
        displayIndex: index + 1
      }));
      const nextOffset = Number(result.nextOffset);
      const notesHasMore =
        result.hasMore === true &&
        Number.isInteger(nextOffset) &&
        nextOffset > offset &&
        nextOffset <= 10000;

      this.notesNextOffset = notesHasMore ? nextOffset : null;
      if (!notesHasMore) {
        this.noteAccessPassword = "";
      }

      this.setData({
        notes,
        hasNotes: notes.length > 0,
        notesHasMore,
        notesLoadError:
          result.hasMore === true && !notesHasMore
            ? "分页信息异常，请返回后重试"
            : "",
        notesTotal: Number.isInteger(Number(result.total))
          ? Math.max(notes.length, Number(result.total))
          : Math.max(this.data.notesTotal, notes.length)
      });
    } catch (error) {
      if (requestId !== this.notesRequestId || !this.isPageVisible) {
        return;
      }

      console.error("loadMoreNotes error:", error);
      this.setData({ notesLoadError: "读后感读取失败，请稍后重试" });
      wx.showToast({
        title: "读后感读取失败，请稍后重试",
        icon: "none"
      });
    } finally {
      if (requestId === this.notesRequestId && this.isPageVisible) {
        this.setData({ notesLoading: false });
      }
    }
  },

  retryLoadMore() {
    return this.loadMoreNotes();
  },

  clearNotes({ updatePage = true } = {}) {
    this.notesRequestId = (this.notesRequestId || 0) + 1;
    this.noteAccessPassword = "";
    this.notesNextOffset = null;
    const clearedState = {
      notes: [],
      hasNotes: false,
      notesLoading: false,
      notesHasMore: false,
      notesLoadError: "",
      notesTotal: 0
    };

    if (updatePage) {
      this.setData(clearedState);
    } else {
      Object.assign(this.data, clearedState);
    }
  }
});
