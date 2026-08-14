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
const timelineEntries = [
  {
    id: "test-001",
    year: "2026",
    month: "08",
    day: "12",
    source: "北京大学第三医院",
    label: "专家提醒",
    content: "儿童易感染麻疹病毒并可能出现肺炎、喉炎、中耳炎、心肌炎、脑炎等并发症甚至可能导致死亡。"
  },
  {
    id: "test-002",
    year: "2026",
    month: "08",
    day: "11",
    source: "北京儿童医院",
    label: "医生提示",
    content: "中小学生腹部疼痛情况比较复杂应当及时前往医院就诊并在医生指导下进行专业治疗切勿自行服用药物。"
  },
  {
    id: "test-003",
    year: "2026",
    month: "08",
    day: "10",
    source: "首都儿科研究所",
    label: "健康提醒",
    content: "青少年每天应保证充足睡眠时间小学生不少于10小时初中生不少于9小时高中生不少于8小时。"
  },
  {
    id: "test-004",
    year: "2026",
    month: "08",
    day: "09",
    source: "北京协和医院儿科",
    label: "专家建议",
    content: "儿童青少年应养成良好的用眼习惯连续用眼40分钟后应休息10分钟眺望远处或闭目养神预防近视发生发展。"
  },
  {
    id: "test-005",
    year: "2026",
    month: "08",
    day: "08",
    source: "中国医学科学院",
    label: "健康科普",
    content: "青春期是生长发育的关键时期要注意均衡营养多吃新鲜蔬菜水果适量摄入优质蛋白质避免偏食挑食。"
  }
];

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
    pickerValue: [yearOptions.length - 1, 0],
    draftPickerValue: [yearOptions.length - 1, 0],
    timelineLoading: false
  },

  onShow() {
    this.pageVisible = true;
    this.pageDestroyed = false;
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ selected: 1, hidden: false });
    }

    this.loadTimeline(this.data.selectedYear, this.data.selectedMonth);
  },

  onHide() {
    this.pageVisible = false;
    this.timelineRequestId = (this.timelineRequestId || 0) + 1;
    this.timelineLoading = false;
    this.setTabBarHidden(false);
    this.setData({ timelineLoading: false });
  },

  onUnload() {
    this.pageVisible = false;
    this.pageDestroyed = true;
    this.timelineRequestId = (this.timelineRequestId || 0) + 1;
    this.timelineLoading = false;
    this.setTabBarHidden(false);
  },

  setTabBarHidden(hidden) {
    const tabBar = this.getTabBar && this.getTabBar();

    if (tabBar) {
      tabBar.setData({ hidden });
    }
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
        // 云函数返回 unavailable，使用测试数据
        if (!append) {
          const localEntries = filterEntries(year, month);
          this.timelineHasMore = false;
          this.timelineNextOffset = null;
          this.setData({ visibleEntries: localEntries });

          wx.showToast({
            title: "已加载测试数据",
            icon: "none"
          });
        }
        return;
      }

      const entries = normalizeCloudEntries(result.entries);

      // 如果云函数返回空数据，使用测试数据
      if (!append && (!entries || entries.length === 0)) {
        const localEntries = filterEntries(year, month);
        this.timelineHasMore = false;
        this.timelineNextOffset = null;
        this.setData({ visibleEntries: localEntries });

        wx.showToast({
          title: "已加载测试数据",
          icon: "none"
        });
        return;
      }

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
      console.log("使用本地测试数据");

      // 使用本地测试数据
      if (!append) {
        const localEntries = filterEntries(year, month);
        this.timelineHasMore = false;
        this.timelineNextOffset = null;
        this.setData({ visibleEntries: localEntries });

        wx.showToast({
          title: "已加载测试数据",
          icon: "none"
        });
      }
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
    this.setTabBarHidden(true);
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
    this.setTabBarHidden(false);
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
    this.setTabBarHidden(false);
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
