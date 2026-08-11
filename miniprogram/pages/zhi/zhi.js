const currentYear = new Date().getFullYear();
const yearOptions = Array.from({ length: 5 }, (_, index) =>
  String(currentYear - 4 + index)
);
const monthOptions = ["全年"].concat(
  Array.from({ length: 12 }, (_, index) =>
    String(index + 1).padStart(2, "0")
  )
);

// Examples stay in seed-data as drafts. The client only renders entries that
// getYouthTimeline confirms are published in the current cloud environment.
const timelineEntries = [];

function filterEntries(year, month) {
  return timelineEntries.filter(
    (entry) => entry.year === year && (!month || entry.month === month)
  );
}

function normalizeCloudEntries(source) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((item) => {
      const entry = item && typeof item === "object" ? item : {};
      const year = String(entry.year || "");
      const month = String(entry.month || "").padStart(2, "0");
      const day = String(entry.day || "").padStart(2, "0");
      const content = typeof entry.content === "string"
        ? entry.content.trim()
        : "";

      if (
        !entry.id ||
        !/^\d{4}$/.test(year) ||
        !/^(?:0[1-9]|1[0-2])$/.test(month) ||
        !/^(?:0[1-9]|[12]\d|3[01])$/.test(day) ||
        !content
      ) {
        return null;
      }

      return {
        id: String(entry.id),
        year,
        month,
        day,
        source:
          typeof entry.source === "string" && entry.source.trim()
            ? entry.source.trim()
            : "中国医院船科普栏目",
        label:
          typeof entry.label === "string" && entry.label.trim()
            ? entry.label.trim()
            : "正式消息",
        content
      };
    })
    .filter(Boolean);
}

Page({
  data: {
    selectedYear: String(currentYear),
    selectedMonth: "",
    visibleEntries: filterEntries(String(currentYear), ""),
    datePickerVisible: false,
    yearOptions,
    monthOptions,
    pickerValue: [yearOptions.length - 1, new Date().getMonth() + 1],
    draftPickerValue: [yearOptions.length - 1, new Date().getMonth() + 1],
    timelineLoading: false
  },

  onShow() {
    this.pageVisible = true;
    this.pageDestroyed = false;
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 1 });
    }

    this.loadTimeline(this.data.selectedYear, this.data.selectedMonth);
  },

  onHide() {
    this.pageVisible = false;
    this.timelineRequestId = (this.timelineRequestId || 0) + 1;
    this.timelineLoading = false;
    this.setData({ timelineLoading: false });
  },

  onUnload() {
    this.pageVisible = false;
    this.pageDestroyed = true;
    this.timelineRequestId = (this.timelineRequestId || 0) + 1;
    this.timelineLoading = false;
  },

  async loadTimeline(year, month, { append = false } = {}) {
    if (append && (this.timelineLoading || !this.timelineHasMore)) {
      return;
    }

    const requestId = (this.timelineRequestId || 0) + 1;
    const offset = append ? Number(this.timelineNextOffset || 0) : 0;

    this.timelineRequestId = requestId;
    this.timelineLoading = true;
    this.setData({ timelineLoading: true });

    try {
      const response = await wx.cloud.callFunction({
        name: "getYouthTimeline",
        data: {
          year,
          month,
          limit: 50,
          offset
        }
      });
      const result = response.result || {};

      if (!result.success) {
        throw new Error(result.message || "少年志消息读取失败");
      }

      if (
        requestId !== this.timelineRequestId ||
        this.pageDestroyed ||
        !this.pageVisible
      ) {
        return;
      }

      if (result.source === "unavailable") {
        this.timelineHasMore = false;
        this.timelineNextOffset = null;
        if (!append) {
          this.setData({ visibleEntries: [] });
        }
        return;
      }

      const entries = normalizeCloudEntries(result.entries);
      const existingEntries = append ? this.data.visibleEntries : [];
      const existingIds = new Set(existingEntries.map((item) => item.id));
      const mergedEntries = existingEntries.concat(
        entries.filter((item) => !existingIds.has(item.id))
      );

      this.timelineHasMore = Boolean(
        result.hasMore &&
        Number.isInteger(Number(result.nextOffset)) &&
        Number(result.nextOffset) > offset
      );
      this.timelineNextOffset = this.timelineHasMore
        ? Number(result.nextOffset)
        : null;

      this.setData({
        visibleEntries: mergedEntries
      });
    } catch (error) {
      if (
        requestId !== this.timelineRequestId ||
        this.pageDestroyed ||
        !this.pageVisible
      ) {
        return;
      }

      console.error("loadYouthTimeline error:", error);
      if (!append) {
        this.timelineHasMore = false;
        this.timelineNextOffset = null;
        this.setData({ visibleEntries: [] });
      }
      wx.showToast({
        title: "云端消息暂未更新",
        icon: "none"
      });
    } finally {
      if (
        requestId === this.timelineRequestId &&
        !this.pageDestroyed &&
        this.pageVisible
      ) {
        this.timelineLoading = false;
        this.setData({ timelineLoading: false });
      }
    }
  },

  onReachBottom() {
    return this.loadTimeline(
      this.data.selectedYear,
      this.data.selectedMonth,
      { append: true }
    );
  },

  openDatePicker() {
    this.setData({
      datePickerVisible: true,
      draftPickerValue: this.data.pickerValue
    });
  },

  onPickerChange(event) {
    this.setData({
      draftPickerValue: event.detail.value
    });
  },

  cancelDatePicker() {
    this.setData({
      datePickerVisible: false,
      draftPickerValue: this.data.pickerValue
    });
  },

  confirmDatePicker() {
    const [yearIndex, monthIndex] = this.data.draftPickerValue;
    const selectedYear = this.data.yearOptions[yearIndex];
    const monthValue = this.data.monthOptions[monthIndex];
    const selectedMonth = monthValue === "全年" ? "" : monthValue;

    this.setData({
      datePickerVisible: false,
      pickerValue: this.data.draftPickerValue,
      selectedYear,
      selectedMonth,
      visibleEntries: filterEntries(selectedYear, selectedMonth)
    });
    this.loadTimeline(selectedYear, selectedMonth);
  },

  clearMonthFilter() {
    const selectedYear = this.data.selectedYear;
    const yearIndex = this.data.yearOptions.indexOf(selectedYear);
    const pickerValue = [Math.max(0, yearIndex), 0];

    this.setData({
      selectedMonth: "",
      pickerValue,
      draftPickerValue: pickerValue,
      visibleEntries: filterEntries(selectedYear, "")
    });
    this.loadTimeline(selectedYear, "");
  },

  stopPropagation() {}
});
