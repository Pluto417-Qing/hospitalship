const {
  clone,
  createMutationId,
  getErrorMessage,
  normalizeCapabilities,
  normalizeText
} = require("../../utils/adminContent");

const CONTENT_TYPES = Object.freeze([
  {
    value: "zhi-entry",
    label: "少年志消息",
    description: "发布活动、人物和医院船相关消息"
  },
  {
    value: "quiz-question",
    label: "少年爱题目",
    description: "录入阅读后的单选题"
  }
]);
const OPTION_KEYS = "ABCDEFGH".split("");

function callAdmin(action, data = {}) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
    return Promise.reject(new Error("云服务暂时不可用"));
  }
  return wx.cloud.callFunction({
    name: "adminContentCenter",
    data: { action, ...data }
  }).then((response) => response && response.result || {});
}

function chinaToday() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}`;
}

function initialZhiForm() {
  return {
    eventAt: chinaToday(),
    source: "",
    label: "",
    content: ""
  };
}

function initialQuizForm() {
  return {
    topic: "",
    department: "",
    source: "",
    question: "",
    options: [
      { key: "A", text: "" },
      { key: "B", text: "" }
    ],
    correctKey: "A",
    correctFeedback: "",
    wrongFeedback: "",
    explanation: ""
  };
}

function cleanText(value, maximum) {
  return normalizeText(value, maximum);
}

function validateZhi(form) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.eventAt || "")) {
    return "请选择消息日期";
  }
  if (!cleanText(form.source, 120)) return "请填写消息来源";
  if (!cleanText(form.label, 80)) return "请填写消息标签";
  if (!cleanText(form.content, 2000)) return "请填写消息正文";
  return "";
}

function validateQuiz(form) {
  const options = Array.isArray(form.options) ? form.options : [];
  if (!cleanText(form.question, 3000)) return "请填写题目";
  if (options.length < 2 || options.length > 8) {
    return "每道题需要 2 至 8 个选项";
  }
  const optionTexts = options.map((option) => cleanText(option && option.text, 1000));
  if (optionTexts.some((text) => !text)) return "请填写每一个选项";
  const comparableTexts = optionTexts.map((text) =>
    text.toLocaleLowerCase("zh-CN")
  );
  if (new Set(comparableTexts).size !== comparableTexts.length) {
    return "选项内容不能重复";
  }
  if (!options.some((option) => option.key === form.correctKey)) {
    return "请选择正确答案";
  }
  return "";
}

function buildZhiPayload(form) {
  return {
    eventAt: cleanText(form.eventAt, 10),
    source: cleanText(form.source, 120),
    label: cleanText(form.label, 80),
    content: cleanText(form.content, 2000)
  };
}

function buildQuizPayload(form) {
  const options = (Array.isArray(form.options) ? form.options : [])
    .slice(0, OPTION_KEYS.length)
    .map((option, index) => ({
      key: OPTION_KEYS[index],
      label: `选择${OPTION_KEYS[index]}`,
      text: cleanText(option && option.text, 1000)
    }));
  return {
    topic: cleanText(form.topic, 120),
    department: cleanText(form.department, 160),
    source: cleanText(form.source, 300),
    question: cleanText(form.question, 3000),
    options,
    correctKey: options.some((option) => option.key === form.correctKey)
      ? form.correctKey
      : options[0].key,
    correctFeedback: cleanText(form.correctFeedback, 500),
    wrongFeedback: cleanText(form.wrongFeedback, 500),
    explanation: cleanText(form.explanation, 5000),
    sortOrder: 0
  };
}

Page({
  data: {
    contentTypes: CONTENT_TYPES,
    selectedType: "zhi-entry",
    loading: true,
    authorized: false,
    pageError: "",
    submitting: false,
    zhiForm: initialZhiForm(),
    quizForm: initialQuizForm()
  },

  onLoad(options = {}) {
    this.pageDestroyed = false;
    this.pendingRequestId = "";
    const selectedType = CONTENT_TYPES.some(
      (item) => item.value === options.type
    )
      ? options.type
      : "zhi-entry";
    this.setData({ selectedType });
  },

  onShow() {
    if (!this.statusLoaded && !this.data.submitting) {
      this.loadStatus();
    }
  },

  onUnload() {
    this.pageDestroyed = true;
    this.statusRequestId = (this.statusRequestId || 0) + 1;
    this.submitRequestId = (this.submitRequestId || 0) + 1;
  },

  async loadStatus() {
    const requestId = (this.statusRequestId || 0) + 1;
    this.statusRequestId = requestId;
    this.setData({ loading: true, pageError: "" });
    try {
      const result = await callAdmin("status");
      if (this.pageDestroyed || requestId !== this.statusRequestId) return;
      const capabilities = normalizeCapabilities(result);
      if (!result.success || result.authorized !== true || !capabilities.drafts) {
        throw Object.assign(
          new Error(result.message || "当前微信没有内容编辑权限"),
          { userMessage: result.message }
        );
      }
      this.statusLoaded = true;
      this.setData({ loading: false, authorized: true, pageError: "" });
    } catch (error) {
      if (!this.pageDestroyed && requestId === this.statusRequestId) {
        this.setData({
          loading: false,
          authorized: false,
          pageError: getErrorMessage(error, "权限读取失败，请稍后重试")
        });
      }
    }
  },

  retryLoad() {
    if (!this.data.loading) this.loadStatus();
  },

  selectType(event) {
    if (this.data.submitting) return;
    const value = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.type,
      32
    );
    if (!CONTENT_TYPES.some((item) => item.value === value)) return;
    this.pendingRequestId = "";
    this.setData({ selectedType: value, pageError: "" });
  },

  onZhiInput(event) {
    const field = normalizeText(event.currentTarget.dataset.field, 32);
    if (!["source", "label", "content"].includes(field)) return;
    const form = clone(this.data.zhiForm, initialZhiForm());
    form[field] = event && event.detail ? event.detail.value : "";
    this.pendingRequestId = "";
    this.setData({ zhiForm: form, pageError: "" });
  },

  onZhiDateChange(event) {
    const form = clone(this.data.zhiForm, initialZhiForm());
    form.eventAt = event && event.detail ? event.detail.value : "";
    this.pendingRequestId = "";
    this.setData({ zhiForm: form, pageError: "" });
  },

  onQuizInput(event) {
    const field = normalizeText(event.currentTarget.dataset.field, 32);
    if (![
      "topic",
      "department",
      "source",
      "question",
      "correctFeedback",
      "wrongFeedback",
      "explanation"
    ].includes(field)) {
      return;
    }
    const form = clone(this.data.quizForm, initialQuizForm());
    form[field] = event && event.detail ? event.detail.value : "";
    this.pendingRequestId = "";
    this.setData({ quizForm: form, pageError: "" });
  },

  onOptionInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const form = clone(this.data.quizForm, initialQuizForm());
    if (!Number.isInteger(index) || !form.options[index]) return;
    form.options[index].text = event && event.detail ? event.detail.value : "";
    this.pendingRequestId = "";
    this.setData({ quizForm: form, pageError: "" });
  },

  addOption() {
    const form = clone(this.data.quizForm, initialQuizForm());
    if (form.options.length >= OPTION_KEYS.length) return;
    form.options.push({
      key: OPTION_KEYS[form.options.length],
      text: ""
    });
    this.pendingRequestId = "";
    this.setData({ quizForm: form, pageError: "" });
  },

  removeOption(event) {
    const index = Number(event.currentTarget.dataset.index);
    const form = clone(this.data.quizForm, initialQuizForm());
    if (
      !Number.isInteger(index) ||
      !form.options[index] ||
      form.options.length <= 2
    ) {
      return;
    }
    const oldCorrectIndex = form.options.findIndex(
      (option) => option.key === form.correctKey
    );
    form.options.splice(index, 1);
    form.options = form.options.map((option, optionIndex) => ({
      key: OPTION_KEYS[optionIndex],
      text: option.text
    }));
    const nextCorrectIndex = oldCorrectIndex < 0 || oldCorrectIndex === index
      ? 0
      : oldCorrectIndex > index
        ? oldCorrectIndex - 1
        : oldCorrectIndex;
    form.correctKey = form.options[nextCorrectIndex].key;
    this.pendingRequestId = "";
    this.setData({ quizForm: form, pageError: "" });
  },

  chooseCorrectOption(event) {
    const key = normalizeText(event.currentTarget.dataset.key, 1).toUpperCase();
    const form = clone(this.data.quizForm, initialQuizForm());
    if (!form.options.some((option) => option.key === key)) return;
    form.correctKey = key;
    this.pendingRequestId = "";
    this.setData({ quizForm: form, pageError: "" });
  },

  async createDraft() {
    if (
      this.data.loading ||
      !this.data.authorized ||
      this.data.submitting ||
      this.pageDestroyed
    ) {
      return;
    }

    const isZhi = this.data.selectedType === "zhi-entry";
    const form = isZhi ? this.data.zhiForm : this.data.quizForm;
    const validationMessage = isZhi ? validateZhi(form) : validateQuiz(form);
    if (validationMessage) {
      this.setData({ pageError: validationMessage });
      return;
    }

    const payload = isZhi ? buildZhiPayload(form) : buildQuizPayload(form);
    const requestId = this.pendingRequestId ||
      createMutationId("editorial");
    this.pendingRequestId = requestId;
    const operationId = (this.submitRequestId || 0) + 1;
    this.submitRequestId = operationId;
    this.setData({ submitting: true, pageError: "" });
    try {
      const result = await callAdmin("createEditorialDraft", {
        assetType: this.data.selectedType,
        payload,
        requestId
      });
      if (this.pageDestroyed || operationId !== this.submitRequestId) return;
      if (!result.success) {
        const error = new Error(result.message || "草稿创建失败");
        error.userMessage = result.message;
        throw error;
      }
      const draftId = normalizeText(
        result.draft && (result.draft.id || result.draft.draftId),
        32
      ).toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(draftId)) {
        throw new Error("服务端返回的草稿状态无效");
      }
      this.pendingRequestId = "";
      wx.navigateTo({
        url: `/pages/adminDraft/adminDraft?id=${draftId}`
      });
    } catch (error) {
      if (!this.pageDestroyed && operationId === this.submitRequestId) {
        this.setData({
          pageError: getErrorMessage(error, "草稿创建失败，请稍后重试")
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.submitRequestId) {
        this.setData({ submitting: false });
      }
    }
  }
});
