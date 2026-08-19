const {
  ADMIN_ENTRY_CARDS,
  ASSET_EXTENSIONS,
  ASSET_TYPES,
  AUDIO_DURATION_TIMEOUT_MS,
  CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS,
  CLIENT_IMAGE_CONFIRM_MAX_RETRIES,
  CLIENT_IMAGE_CONFIRM_RETRY_BASE_MS,
  CLIENT_IMAGE_RESUME_MAX_ROUNDS,
  DEFAULT_BOOK_TARGETS,
  PORTAL_ROLES,
  REVIEW_STATUS_LABELS,
  STATUS_LABELS,
  allowedFileHint,
  buildBookTargets,
  createAdminContentError,
  createClientManifest,
  createNewTargetId,
  createRandomHex32,
  firstNonNegativeInteger,
  formatFileSize,
  formatTime,
  getAssetLabel,
  getConfirmedUploadState,
  getDirectCloudCapability,
  getDocumentImportLimits,
  getDocumentTooLargeMessage,
  getErrorMessage,
  getFileDisplayType,
  getPdfReadiness,
  getUploadMode,
  hasUploadAccess,
  getUploadRole,
  inferMimeType,
  isAllowedFile,
  isCancelError,
  isDirectCloudMode,
  isRetryableAdminContentError,
  isSafeDirectCloudPath,
  isStableTargetId,
  normalizeClientImageProgress,
  normalizeClientImageUploadPlan,
  normalizeCloudFileID,
  normalizeDirectCloudTransport,
  normalizeBrokerTransport,
  normalizeText,
  normalizeUpload,
  normalizeUploadTargets,
  normalizeUploads,
  parseBrokerUploadResult,
  targetTypeForAsset,
  toSafeInteger,
  utf8ByteLength,
  withPublicDraftTitle,
  wrapBookTitle,
  wrapCloudUploadError
} = require("./uploadHelpers");
const adminContent = require("../../utils/adminContent");
const docxImport = require("./docxImport");
const docxImageTransfer = require("./docxImageTransfer");

function confirmModal(title, content, confirmText = "确认") {
  return new Promise((resolve) => {
    if (typeof wx.showModal !== "function") {
      resolve(false);
      return;
    }
    wx.showModal({
      title,
      content,
      confirmText,
      confirmColor: "#b93731",
      success: (result) => resolve(Boolean(result && result.confirm)),
      fail: () => resolve(false)
    });
  });
}

Page({
  data: {
    accessLoading: true,
    accessChecked: false,
    authorized: false,
    uploadAvailable: false,
    uploadMode: "",
    capabilities: {
      upload: false,
      drafts: false,
      review: false,
      moderation: false,
      assetPreview: false,
      publish: false,
      transportMode: ""
    },
    transportMessage: "",
    role: "",
    accessMessage: "",
    entryCards: ADMIN_ENTRY_CARDS,
    selectedEntryId: "manuscript",
    selectedEntryKind: "file",
    assetTypeOptions: ASSET_TYPES,
    assetTypeIndex: 0,
    selectedAssetType: ASSET_TYPES[0].value,
    selectedAssetTypeLabel: ASSET_TYPES[0].label,
    manuscriptStep: "word",
    contentMode: "new",
    relatedId: "",
    bookTargets: DEFAULT_BOOK_TARGETS,
    pdfReadinessTone: "muted",
    pdfReadinessTitle: "尚未读取到已发布 PDF",
    pdfReadinessMessage: "可以现在上传；若云端已有版本，也可先沿用并稍后再替换。",
    uploadTargets: [],
    uploadTargetsLoading: false,
    uploadTargetsError: "",
    selectedTargetIndex: -1,
    selectedTargetTitle: "",
    selectedTargetSubtitle: "",
    targetSelectionRequired: false,
    targetPickerLabel: "",
    emptyTargetMessage: "",
    fileDisplayType: "Word 文档",
    fileFormatHint: "支持 DOCX；旧版 DOC 请先另存为 DOCX",
    fileChoosing: false,
    selectedFile: null,
    audioDurationLoading: false,
    audioDurationError: "",
    audioDurationLabel: "",
    localDocumentReady: false,
    localParseError: "",
    localParseLoading: false,
    localParsePreview: [],
    localParseSummary: "",
    localParseWarning: "",
    uploading: false,
    uploadProgress: 0,
    uploadStageLabel: "",
    imageTransferCompleted: 0,
    imageTransferTotal: 0,
    uploadError: "",
    canRetry: false,
    uploadSuccess: "",
    historyLoading: false,
    historyError: "",
    uploads: [],
    historyHasMore: false,
    historyNextOffset: null,
    draftsLoading: false,
    draftsError: "",
    drafts: [],
    draftsHasMore: false,
    draftsNextOffset: null,
    reviewLoading: false,
    reviewError: "",
    reviewDrafts: [],
    reviewHasMore: false,
    reviewNextOffset: null,
    creatingDraftId: "",
    cancelingUploadId: "",
    resumingClientImagesId: "",
    cleaningUpUploadId: ""
  },

  onLoad() {
    this.pageDestroyed = false;
    this.isPageVisible = false;
    this.retryStage = "";
    this.pendingUploadTicket = null;
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.imageTransferController = null;
    this.draftMutationIds = {};
    this.targetSelectionConfirmed = false;
    this.targetRequestId = 0;
    this.fileSelectionRequestId = 0;
    this.audioProbeRequestId = 0;
    this.audioProbeContext = null;
    this.audioProbeCancel = null;
    this.resumeClientImagesOperationId = 0;
    this.cleanupCanceledUploadOperationId = 0;
    this.selectedBookTargetId = DEFAULT_BOOK_TARGETS[0].id;
    this.setData({
      relatedId: createNewTargetId("manuscript")
    });
  },

  onShow() {
    this.isPageVisible = true;
    this.loadAccessStatus();
  },

  onHide() {
    this.isPageVisible = false;
    const discardAudioSelection = this.data.audioDurationLoading;
    const preservePendingFileSelection = Boolean(this.data.fileChoosing);
    this.accessRequestId = (this.accessRequestId || 0) + 1;
    this.historyRequestId = (this.historyRequestId || 0) + 1;
    this.draftsRequestId = (this.draftsRequestId || 0) + 1;
    this.reviewRequestId = (this.reviewRequestId || 0) + 1;
    this.resumeClientImagesOperationId =
      (this.resumeClientImagesOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.draftOperationId = (this.draftOperationId || 0) + 1;
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    if (!preservePendingFileSelection) {
      this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    }
    this.cancelAudioDurationProbe();
    this.setData({
      fileChoosing: preservePendingFileSelection,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: discardAudioSelection
        ? ""
        : this.data.audioDurationLabel,
      selectedFile: discardAudioSelection ? null : this.data.selectedFile,
      localDocumentReady: discardAudioSelection
        ? false
        : this.data.localDocumentReady,
      creatingDraftId: "",
      resumingClientImagesId: "",
      cleaningUpUploadId: ""
    });
    this.stopActiveUpload({ showMessage: false });
  },

  onUnload() {
    this.pageDestroyed = true;
    this.isPageVisible = false;
    this.accessRequestId = (this.accessRequestId || 0) + 1;
    this.historyRequestId = (this.historyRequestId || 0) + 1;
    this.draftsRequestId = (this.draftsRequestId || 0) + 1;
    this.reviewRequestId = (this.reviewRequestId || 0) + 1;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.uploadOperationId = (this.uploadOperationId || 0) + 1;
    this.draftOperationId = (this.draftOperationId || 0) + 1;
    this.cancelOperationId = (this.cancelOperationId || 0) + 1;
    this.resumeClientImagesOperationId =
      (this.resumeClientImagesOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.stopActiveUpload({ showMessage: false });
  },

  stopActiveUpload({
    showMessage = true,
    cancelRemote = showMessage
  } = {}) {
    const ticket = this.pendingUploadTicket;
    const task = this.uploadTask;
    const imageController = this.imageTransferController;

    if (!ticket && !task && !imageController && !this.data.uploading) {
      return;
    }

    this.uploadOperationId = (this.uploadOperationId || 0) + 1;
    if (task && typeof task.abort === "function") {
      try {
        task.abort();
      } catch (error) {
        console.warn("abort admin upload error:", error);
      }
    }
    if (imageController && typeof imageController.cancel === "function") {
      try {
        imageController.cancel();
      } catch (error) {
        console.warn("cancel Word image transfer error:", error);
      }
    }

    this.uploadTask = null;
    this.imageTransferController = null;
    const remoteCanResumeImages = Boolean(
      ticket &&
      (
        this.retryStage === "images" ||
        this.retryStage === "image-confirm" ||
        ticket.manifestResult ||
        ticket.imageUploadPlan
      )
    );
    const shouldCancelRemote = Boolean(
      cancelRemote || !remoteCanResumeImages
    );
    this.pendingUploadTicket = null;
    this.retryStage = "create";

    if (
      shouldCancelRemote &&
      ticket &&
      /^[a-f0-9]{32}$/.test(ticket.uploadId) &&
      wx.cloud
    ) {
      wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "cancelUpload", uploadId: ticket.uploadId }
      }).catch((error) => {
        console.warn("release canceled admin upload error:", error);
      });
    }

    if (!this.pageDestroyed) {
      this.setData({
        uploading: false,
        uploadProgress: 0,
        imageTransferCompleted: 0,
        imageTransferTotal: 0,
        uploadStageLabel: showMessage ? "已取消上传" : "",
        uploadError: "",
        canRetry: showMessage
      });
    }
  },

  cancelActiveUpload() {
    this.stopActiveUpload({
      showMessage: true,
      cancelRemote: true
    });
  },

  async loadAccessStatus() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setData({
        accessLoading: false,
        accessChecked: true,
        authorized: false,
        uploadAvailable: false,
        uploadMode: "",
        capabilities: adminContent.normalizeCapabilities(null),
        transportMessage: "",
        accessMessage: "云服务暂不可用，无法验证管理员权限。"
      });
      return;
    }

    const requestId = (this.accessRequestId || 0) + 1;
    this.accessRequestId = requestId;
    this.setData({
      accessLoading: true,
      accessChecked: false,
      authorized: false,
      uploadAvailable: false,
      uploadMode: "",
      capabilities: adminContent.normalizeCapabilities(null),
      transportMessage: "",
      accessMessage: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "status" }
      });
      const result = response.result || {};

      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.accessRequestId
      ) {
        return;
      }

      if (!hasUploadAccess(result)) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities: adminContent.normalizeCapabilities(null),
          transportMessage: "",
          role: "",
          accessMessage:
            result.message || "当前会员没有内容上传权限，请联系管理员。",
          uploads: []
        });
        return;
      }

      const capabilities = adminContent.normalizeCapabilities(result);
      const portalAvailable = Boolean(
        capabilities.upload ||
        capabilities.drafts ||
        capabilities.review ||
        capabilities.moderation ||
        capabilities.publish
      );
      if (!portalAvailable) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities,
          transportMessage: "",
          role: "",
          accessMessage: "当前管理员账号没有可用的内容管理能力。",
          uploads: [],
          drafts: [],
          reviewDrafts: []
        });
        return;
      }

      const uploadMode = capabilities.upload ? getUploadMode(result) : "";
      this.setData({
        accessLoading: false,
        accessChecked: true,
        authorized: true,
        uploadAvailable: Boolean(uploadMode),
        uploadMode,
        capabilities,
        transportMessage: uploadMode
          ? ""
          : capabilities.drafts
            ? "文件上传通道尚未配置，当前仍可处理已有草稿。"
            : "当前角色不承担文件上传。",
        role: getUploadRole(result),
        accessMessage: "",
        uploads: capabilities.drafts ? normalizeUploads(result) : []
      });
      await Promise.all([
        capabilities.drafts ? this.loadHistory({ quiet: true }) : Promise.resolve(),
        capabilities.drafts ? this.loadDrafts({ quiet: true }) : Promise.resolve(),
        capabilities.review ? this.loadReviewQueue({ quiet: true }) : Promise.resolve()
      ]);
    } catch (error) {
      console.error("load admin upload status error:", error);

      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.accessRequestId
      ) {
        this.setData({
          accessLoading: false,
          accessChecked: true,
          authorized: false,
          uploadAvailable: false,
          uploadMode: "",
          capabilities: adminContent.normalizeCapabilities(null),
          transportMessage: "",
          role: "",
          accessMessage: "权限验证失败，请检查网络后重试。",
          uploads: []
        });
      }
    }
  },

  retryAccess() {
    if (!this.data.accessLoading) {
      this.loadAccessStatus();
    }
  },

  async loadHistory({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.drafts ||
      this.historyLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }

    const requestId = (this.historyRequestId || 0) + 1;
    this.historyRequestId = requestId;
    this.historyLoading = true;
    this.setData({ historyLoading: true, historyError: "" });
    const offset = append && Number.isInteger(this.data.historyNextOffset)
      ? this.data.historyNextOffset
      : 0;

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: {
          action: "listUploads",
          limit: 20,
          offset
        }
      });
      const result = response.result || {};

      if (!result.success) {
        const error = new Error(result.message || "上传记录读取失败");
        error.userMessage = result.message;
        throw error;
      }

      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.historyRequestId
      ) {
        return;
      }

      const incoming = normalizeUploads(result);
      const uploads = append
        ? this.mergeById(this.data.uploads, incoming, "uploadId")
        : incoming;
      this.setData({
        uploads,
        historyError: "",
        historyHasMore: result.hasMore === true,
        historyNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
      this.syncUploadDraftState();
      return this.data.uploads;
    } catch (error) {
      console.error("load admin upload history error:", error);

      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.historyRequestId
      ) {
        const message = getErrorMessage(error, "上传记录读取失败，请稍后重试。");
        this.setData({ historyError: quiet ? "" : message });
      }
      return null;
    } finally {
      if (requestId === this.historyRequestId) {
        this.historyLoading = false;
        if (!this.pageDestroyed) {
          this.setData({ historyLoading: false });
        }
      }
    }
  },

  refreshHistory() {
    this.loadHistory({ append: false });
  },

  loadMoreHistory() {
    if (this.data.historyHasMore && !this.data.historyLoading) {
      this.loadHistory({ append: true });
    }
  },

  mergeById(current, incoming, field = "id") {
    const result = [];
    const seen = new Set();
    (Array.isArray(current) ? current : [])
      .concat(Array.isArray(incoming) ? incoming : [])
      .forEach((item) => {
        const id = normalizeText(item && item[field], 128);
        if (id && !seen.has(id)) {
          seen.add(id);
          result.push(item);
        }
      });
    return result;
  },

  async loadDrafts({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.drafts ||
      this.draftsLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.draftsRequestId || 0) + 1;
    this.draftsRequestId = requestId;
    this.draftsLoading = true;
    const offset = append && Number.isInteger(this.data.draftsNextOffset)
      ? this.data.draftsNextOffset
      : 0;
    this.setData({ draftsLoading: true, draftsError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "listDrafts", limit: 20, offset }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "草稿列表读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.draftsRequestId
      ) {
        return;
      }
      const incoming = adminContent.normalizeDrafts(result).map(withPublicDraftTitle);
      this.setData({
        drafts: append ? this.mergeById(this.data.drafts, incoming) : incoming,
        draftsError: "",
        draftsHasMore: result.hasMore === true,
        draftsNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
      this.syncUploadDraftState();
      this.syncBookTargets();
    } catch (error) {
      console.error("load admin drafts error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.draftsRequestId
      ) {
        this.setData({
          draftsError: quiet ? "" : getErrorMessage(error, "草稿列表读取失败，请稍后重试。")
        });
      }
    } finally {
      if (requestId === this.draftsRequestId) {
        this.draftsLoading = false;
        if (!this.pageDestroyed) this.setData({ draftsLoading: false });
      }
    }
  },

  refreshDrafts() {
    this.loadDrafts({ append: false });
  },

  async reopenPublishedDraft(event) {
    const draftId = normalizeText(
      event.currentTarget.dataset.draftId,
      32
    ).toLowerCase();
    const draft = (Array.isArray(this.data.drafts) ? this.data.drafts : [])
      .find((item) => item.id === draftId);

    if (
      !draft ||
      draft.state !== "published" ||
      !this.data.capabilities.drafts ||
      this.reopeningDraftId
    ) {
      return;
    }

    this.reopeningDraftId = draftId;

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: {
          action: "reopenDraftForEditing",
          draftId,
          requestId: adminContent.createMutationId("reopen")
        }
      });
      const result = response && response.result || {};
      if (!result.success) {
        wx.showToast({
          title: result.message || "重新打开编辑失败，请稍后重试。",
          icon: "none"
        });
        return;
      }

      wx.showToast({ title: "已进入编辑", icon: "success" });
      this.refreshDrafts();
      if (typeof wx.navigateTo === "function") {
        wx.navigateTo({ url: `/pages/adminDraft/adminDraft?id=${draftId}` });
      }
    } catch (error) {
      console.error("reopen published draft error:", error);
      wx.showToast({
        title: getErrorMessage(error, "重新打开编辑失败，请稍后重试。"),
        icon: "none"
      });
    } finally {
      this.reopeningDraftId = null;
    }
  },

  async deletePublishedDraft(event) {
    const draftId = normalizeText(
      event.currentTarget.dataset.draftId,
      32
    ).toLowerCase();
    const draft = (Array.isArray(this.data.drafts) ? this.data.drafts : [])
      .find((item) => item.id === draftId);
    const contentId = normalizeText(draft && draft.targetId, 64).toLowerCase();

    if (
      !draft ||
      draft.assetType !== "manuscript" ||
      draft.state !== "published" ||
      !contentId ||
      !this.data.capabilities.publish ||
      this.deletingDraftId
    ) {
      return;
    }

    const confirmed = await confirmModal(
      "删除已发布书稿",
      `删除后读者端将无法再打开《${draft.title || "这篇书稿"}》，且不可恢复。确定删除吗？`,
      "删除"
    );
    if (!confirmed) return;

    this.deletingDraftId = draftId;

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "deletePublishedContent", contentId }
      });
      const result = response && response.result || {};
      if (!result.success) {
        wx.showToast({
          title: result.message || "删除失败，请稍后重试。",
          icon: "none"
        });
        return;
      }

      wx.showToast({ title: "已删除", icon: "success" });
      this.setData({
        drafts: (Array.isArray(this.data.drafts) ? this.data.drafts : [])
          .filter((item) => item.id !== draftId)
      });
      this.refreshDrafts();
    } catch (error) {
      console.error("delete published draft error:", error);
      wx.showToast({
        title: getErrorMessage(error, "删除失败，请稍后重试。"),
        icon: "none"
      });
    } finally {
      this.deletingDraftId = null;
    }
  },

  loadMoreDrafts() {
    if (this.data.draftsHasMore && !this.data.draftsLoading) {
      this.loadDrafts({ append: true });
    }
  },

  syncUploadDraftState() {
    const draftIds = new Set(
      (Array.isArray(this.data.drafts) ? this.data.drafts : [])
        .map((draft) => normalizeText(draft && draft.id, 32))
        .filter(Boolean)
    );
    const uploads = (Array.isArray(this.data.uploads) ? this.data.uploads : [])
      .map((upload) => {
        const hasDraft = draftIds.has(upload.uploadId);
        return {
          ...upload,
          hasDraft,
          canCancel: Boolean(upload.canCancel && !hasDraft)
        };
      });
    this.setData({ uploads });
  },

  syncBookTargets() {
    const targets = buildBookTargets(this.data.drafts);
    const preferredId = normalizeText(this.selectedBookTargetId, 64).toLowerCase();
    let selectedIndex = targets.findIndex((item) => item.id === preferredId);
    if (selectedIndex < 0) {
      selectedIndex = 0;
    }
    const selectedTarget = targets[selectedIndex] || DEFAULT_BOOK_TARGETS[0];
    this.selectedBookTargetId = selectedTarget.id;
    const readiness = getPdfReadiness(this.data.drafts, selectedTarget.id);
    const update = {
      bookTargets: targets,
      pdfReadinessTone: readiness.tone,
      pdfReadinessTitle: readiness.title,
      pdfReadinessMessage: readiness.message
    };

    if (this.data.selectedAssetType === "full-book-pdf") {
      this.targetSelectionConfirmed = true;
      Object.assign(update, {
        relatedId: selectedTarget.id,
        uploadTargets: targets,
        uploadTargetsLoading: false,
        uploadTargetsError: "",
        selectedTargetIndex: selectedIndex,
        selectedTargetTitle: selectedTarget.title,
        selectedTargetSubtitle: selectedTarget.subtitle
      });
    }

    this.setData(update);
  },

  async loadReviewQueue({ quiet = false, append = false } = {}) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.review ||
      this.reviewLoading ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.reviewRequestId || 0) + 1;
    this.reviewRequestId = requestId;
    this.reviewLoading = true;
    const offset = append && Number.isInteger(this.data.reviewNextOffset)
      ? this.data.reviewNextOffset
      : 0;
    this.setData({ reviewLoading: true, reviewError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "listReviewQueue", limit: 20, offset }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "审核队列读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.reviewRequestId
      ) {
        return;
      }
      const incoming = adminContent.normalizeDrafts(result).map(withPublicDraftTitle);
      this.setData({
        reviewDrafts: append
          ? this.mergeById(this.data.reviewDrafts, incoming)
          : incoming,
        reviewError: "",
        reviewHasMore: result.hasMore === true,
        reviewNextOffset: Number.isInteger(result.nextOffset)
          ? result.nextOffset
          : null
      });
    } catch (error) {
      console.error("load admin review queue error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.reviewRequestId
      ) {
        this.setData({
          reviewError: quiet ? "" : getErrorMessage(error, "审核队列读取失败，请稍后重试。")
        });
      }
    } finally {
      if (requestId === this.reviewRequestId) {
        this.reviewLoading = false;
        if (!this.pageDestroyed) this.setData({ reviewLoading: false });
      }
    }
  },

  refreshReviewQueue() {
    this.loadReviewQueue({ append: false });
  },

  loadMoreReviewQueue() {
    if (this.data.reviewHasMore && !this.data.reviewLoading) {
      this.loadReviewQueue({ append: true });
    }
  },

  onEntryTap(event) {
    if (this.data.uploading) {
      return;
    }
    const entryId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.entryId,
      32
    );
    const entry = ADMIN_ENTRY_CARDS.find((item) => item.id === entryId);
    if (!entry) {
      return;
    }
    if (entry.kind === "editorial") {
      if (typeof wx.navigateTo === "function") {
        wx.navigateTo({
          url:
            `/pages/adminEditorial/adminEditorial?type=${entry.editorialType}`
        });
      }
      return;
    }
    this.activateFileEntry(entry.assetType);
  },

  openModeration() {
    if (!this.data.authorized || !this.data.capabilities.moderation) {
      wx.showToast({
        title: "当前账号没有读后感复审权限",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/adminModeration/adminModeration"
    });
  },

  activateFileEntry(assetType, { force = false } = {}) {
    if (
      this.data.uploading ||
      !["manuscript", "audio", "special-topic", "full-book-pdf"].includes(assetType) ||
      (
        !force &&
        this.data.selectedEntryKind === "file" &&
        this.data.selectedAssetType === assetType
      )
    ) {
      return;
    }

    const optionIndex = ASSET_TYPES.findIndex((item) => item.value === assetType);
    const option = ASSET_TYPES[optionIndex];
    const entryAssetType = assetType === "full-book-pdf"
      ? "manuscript"
      : assetType;
    const entry = ADMIN_ENTRY_CARDS.find(
      (item) => item.kind === "file" && item.assetType === entryAssetType
    );
    const isBookPdf = assetType === "full-book-pdf";
    const requiresTarget = assetType === "audio" || isBookPdf;
    const bookTargets = this.data.bookTargets.length > 0
      ? this.data.bookTargets
      : DEFAULT_BOOK_TARGETS;
    let selectedBookIndex = bookTargets.findIndex(
      (item) => item.id === this.selectedBookTargetId
    );
    if (selectedBookIndex < 0) {
      selectedBookIndex = 0;
    }
    const selectedBook = bookTargets[selectedBookIndex] || DEFAULT_BOOK_TARGETS[0];
    const relatedId = isBookPdf
      ? selectedBook.id
      : requiresTarget
        ? ""
        : createNewTargetId(assetType);
    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.targetSelectionConfirmed = isBookPdf || !requiresTarget;
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.setData({
      selectedEntryId: entry.id,
      selectedEntryKind: "file",
      assetTypeIndex: optionIndex,
      selectedAssetType: assetType,
      selectedAssetTypeLabel: option.label,
      manuscriptStep: isBookPdf
        ? "pdf"
        : assetType === "manuscript"
          ? "word"
          : "",
      contentMode: requiresTarget ? "existing" : "new",
      relatedId,
      uploadTargets: isBookPdf ? bookTargets : [],
      uploadTargetsLoading: false,
      uploadTargetsError: "",
      selectedTargetIndex: isBookPdf ? selectedBookIndex : -1,
      selectedTargetTitle: isBookPdf ? selectedBook.title : "",
      selectedTargetSubtitle: isBookPdf ? selectedBook.subtitle : "",
      targetSelectionRequired: requiresTarget,
      targetPickerLabel: isBookPdf
        ? "选择下载版所属书目"
        : requiresTarget
          ? "选择要配音的文章"
          : "",
      emptyTargetMessage: isBookPdf
        ? "暂时没有可选书目。"
        : requiresTarget
          ? "还没有可配音的文章，请先上传并发布首页书稿。"
          : "",
      fileDisplayType: getFileDisplayType(assetType),
      fileFormatHint: assetType === "audio"
        ? "支持 MP3、M4A、WAV 格式"
        : isBookPdf
          ? "仅支持 PDF 格式"
          : "支持 DOCX；旧版 DOC 请先另存为 DOCX",
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });

    if (requiresTarget) {
      if (isBookPdf) {
        this.syncBookTargets();
      } else {
        this.loadUploadTargets("content");
      }
    }
  },

  onManuscriptStepTap(event) {
    if (this.data.uploading) {
      return;
    }
    const step = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.step,
      16
    );
    if (!["word", "pdf"].includes(step) || step === this.data.manuscriptStep) {
      return;
    }

    this.activateFileEntry(
      step === "pdf" ? "full-book-pdf" : "manuscript",
      { force: true }
    );
  },

  onAssetTypeChange(event) {
    const index = Number(event && event.detail && event.detail.value);
    const option = ASSET_TYPES[index];
    if (!option) {
      return;
    }
    this.activateFileEntry(option.value, { force: true });
  },

  onContentModeTap(event) {
    if (
      this.data.uploading ||
      !["manuscript", "special-topic"].includes(this.data.selectedAssetType)
    ) {
      return;
    }
    const mode = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.mode,
      16
    );
    if (!["new", "update"].includes(mode) || mode === this.data.contentMode) {
      return;
    }

    this.targetRequestId = (this.targetRequestId || 0) + 1;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    this.targetSelectionConfirmed = mode === "new";
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    const isTopic = this.data.selectedAssetType === "special-topic";
    this.setData({
      contentMode: mode,
      relatedId: mode === "new"
        ? createNewTargetId(this.data.selectedAssetType)
        : "",
      uploadTargets: [],
      uploadTargetsLoading: false,
      uploadTargetsError: "",
      selectedTargetIndex: -1,
      selectedTargetTitle: "",
      selectedTargetSubtitle: "",
      targetSelectionRequired: mode === "update",
      targetPickerLabel: mode === "update"
        ? (isTopic ? "选择要更新的小专题" : "选择要更新的书稿")
        : "",
      emptyTargetMessage: mode === "update"
        ? (
            isTopic
              ? "还没有已发布的小专题，请先新建并发布一个小专题。"
              : "还没有已发布书稿，请先选择“新建内容”上传第一篇。"
          )
        : "",
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });

    if (mode === "update") {
      this.loadUploadTargets(targetTypeForAsset(this.data.selectedAssetType));
    }
  },

  async loadUploadTargets(targetType) {
    if (
      !this.data.authorized ||
      !this.data.capabilities.upload ||
      !["content", "special-topic"].includes(targetType) ||
      !wx.cloud ||
      typeof wx.cloud.callFunction !== "function"
    ) {
      return;
    }
    const requestId = (this.targetRequestId || 0) + 1;
    this.targetRequestId = requestId;
    this.setData({
      uploadTargetsLoading: true,
      uploadTargetsError: "",
      uploadTargets: [],
      selectedTargetIndex: -1,
      selectedTargetTitle: "",
      selectedTargetSubtitle: ""
    });

    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: {
          action: "listUploadTargets",
          targetType
        }
      });
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.message || "内容列表读取失败");
        error.userMessage = result.message;
        throw error;
      }
      if (
        this.pageDestroyed ||
        !this.isPageVisible ||
        requestId !== this.targetRequestId
      ) {
        return;
      }
      this.setData({
        uploadTargets: normalizeUploadTargets(result),
        uploadTargetsError: ""
      });
    } catch (error) {
      console.error("load upload targets error:", error);
      if (
        !this.pageDestroyed &&
        this.isPageVisible &&
        requestId === this.targetRequestId
      ) {
        this.setData({
          uploadTargets: [],
          uploadTargetsError: getErrorMessage(
            error,
            "文章列表读取失败，请稍后重试。"
          )
        });
      }
    } finally {
      if (requestId === this.targetRequestId && !this.pageDestroyed) {
        this.setData({ uploadTargetsLoading: false });
      }
    }
  },

  retryUploadTargets() {
    if (!this.data.uploadTargetsLoading) {
      if (this.data.selectedAssetType === "full-book-pdf") {
        this.syncBookTargets();
        return;
      }
      this.loadUploadTargets(
        targetTypeForAsset(this.data.selectedAssetType)
      );
    }
  },

  onUploadTargetChange(event) {
    if (this.data.uploading) {
      return;
    }
    const index = Number(event && event.detail && event.detail.value);
    const target = this.data.uploadTargets[index];
    if (!target || !isStableTargetId(target.id)) {
      return;
    }

    this.targetSelectionConfirmed = true;
    this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
    this.cancelAudioDurationProbe();
    if (this.data.selectedAssetType === "full-book-pdf") {
      this.selectedBookTargetId = target.id;
    }
    this.resetRetryState();
    this.localDocumentManifest = null;
    this.pendingClientManifest = null;
    this.localParseRequestId = (this.localParseRequestId || 0) + 1;
    this.setData({
      relatedId: target.id,
      selectedTargetIndex: index,
      selectedTargetTitle: target.title,
      selectedTargetSubtitle: target.subtitle,
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadProgress: 0,
      uploadStageLabel: "",
      uploadError: "",
      uploadSuccess: ""
    });
    if (this.data.selectedAssetType === "full-book-pdf") {
      const readiness = getPdfReadiness(this.data.drafts, target.id);
      this.setData({
        pdfReadinessTone: readiness.tone,
        pdfReadinessTitle: readiness.title,
        pdfReadinessMessage: readiness.message
      });
    }
  },

  onRelatedIdInput(event) {
    if (this.data.uploading) {
      return;
    }

    const relatedId = normalizeText(
      event && event.detail && event.detail.value,
      64
    ).toLowerCase();
    if (relatedId !== this.data.relatedId) {
      this.fileSelectionRequestId = (this.fileSelectionRequestId || 0) + 1;
      this.cancelAudioDurationProbe();
      this.localParseRequestId = (this.localParseRequestId || 0) + 1;
      this.localDocumentManifest = null;
    }
    this.resetRetryState();
    this.targetSelectionConfirmed = true;
    this.setData({
      relatedId,
      fileChoosing: false,
      selectedFile: null,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: false,
      localParsePreview: [],
      localParseSummary: "",
      localParseWarning: "",
      uploadError: "",
      uploadSuccess: ""
    });
  },

  chooseFile() {
    if (
      !this.data.authorized ||
      !this.data.uploadAvailable ||
      this.data.uploading ||
      this.data.fileChoosing
    ) {
      return;
    }

    if (typeof wx.chooseMessageFile !== "function") {
      wx.showToast({ title: "当前微信版本不支持文件选择", icon: "none" });
      return;
    }

    const requestId = (this.fileSelectionRequestId || 0) + 1;
    const selectedAssetType = this.data.selectedAssetType;
    const selectedUploadMode = this.data.uploadMode;
    const relatedId = this.data.relatedId;
    this.fileSelectionRequestId = requestId;
    this.cancelAudioDurationProbe();
    this.setData({
      fileChoosing: true,
      audioDurationLoading: false,
      audioDurationError: "",
      audioDurationLabel: ""
    });
    const finishChoosing = () => {
      if (
        !this.pageDestroyed &&
        requestId === this.fileSelectionRequestId
      ) {
        this.setData({ fileChoosing: false });
      }
    };

    try {
      wx.chooseMessageFile({
        count: 1,
        type: "file",
        success: (result) => {
          if (
            this.pageDestroyed ||
            requestId !== this.fileSelectionRequestId ||
            this.data.selectedAssetType !== selectedAssetType ||
            this.data.relatedId !== relatedId
          ) {
            return;
          }
          finishChoosing();

          const file = result && Array.isArray(result.tempFiles)
            ? result.tempFiles[0]
            : null;
          const filePath = normalizeText(
            file && (file.path || file.tempFilePath),
            2048
          );
          const fallbackFileName = filePath
            ? filePath.split(/[\\/]/).pop()
            : "";
          const fileName = normalizeText(
            file && (file.name || file.fileName) || fallbackFileName,
            180
          );
          const size = Number(file && file.size);

          if (
            !file ||
            !fileName ||
            !filePath ||
            !Number.isFinite(size) ||
            size <= 0
          ) {
            wx.showToast({
              title: "所选文件信息不完整，请重新选择",
              icon: "none"
            });
            return;
          }

          if (!isAllowedFile(selectedAssetType, fileName)) {
            wx.showToast({
              title: `该类型仅支持 ${allowedFileHint(selectedAssetType)}`,
              icon: "none"
            });
            return;
          }

          const selectedFile = {
            fileName,
            filePath,
            size,
            sizeLabel: formatFileSize(size),
            mimeType: inferMimeType(fileName, file.type || file.mimeType)
          };

          this.resetRetryState();
          this.setData({
            selectedFile,
            audioDurationLoading: false,
            audioDurationError: "",
            audioDurationLabel: "",
            uploadProgress: 0,
            imageTransferCompleted: 0,
            imageTransferTotal: 0,
            uploadStageLabel: "",
            uploadError: "",
            uploadSuccess: "",
            localParseWarning: ""
          });
          if (selectedAssetType === "audio") {
            this.prepareSelectedAudio(requestId);
          } else {
            this.prepareSelectedDocument({
              file: selectedFile,
              assetType: selectedAssetType,
              uploadMode: selectedUploadMode
            });
          }
        },
        fail: (error) => {
          if (
            requestId !== this.fileSelectionRequestId ||
            this.pageDestroyed
          ) {
            return;
          }
          finishChoosing();
          if (!isCancelError(error)) {
            console.error("choose admin upload file error:", error);
            wx.showToast({ title: "文件选择失败，请重试", icon: "none" });
          }
        }
      });
    } catch (error) {
      finishChoosing();
      console.error("open admin upload file chooser error:", error);
      wx.showToast({ title: "文件选择失败，请重试", icon: "none" });
    }
  },

  cancelAudioDurationProbe() {
    this.audioProbeRequestId = (this.audioProbeRequestId || 0) + 1;
    const cancel = this.audioProbeCancel;
    const context = this.audioProbeContext;
    this.audioProbeCancel = null;
    this.audioProbeContext = null;

    if (typeof cancel === "function") {
      cancel();
      return;
    }
    if (context && typeof context.destroy === "function") {
      try {
        context.destroy();
      } catch (error) {
        console.warn("destroy audio duration probe error:", error);
      }
    }
  },

  readAudioDuration(filePath, requestId) {
    return new Promise((resolve, reject) => {
      if (typeof wx.createInnerAudioContext !== "function") {
        reject(new Error("当前微信版本无法读取配音时长"));
        return;
      }

      let context;
      try {
        context = wx.createInnerAudioContext();
      } catch (error) {
        reject(error);
        return;
      }
      if (!context) {
        reject(new Error("无法打开配音文件"));
        return;
      }

      this.audioProbeContext = context;
      let settled = false;
      let retryTimer = null;
      const timeoutTimer = setTimeout(() => {
        finish(
          reject,
          new Error("读取配音时长超时，请重新选择音频文件")
        );
      }, AUDIO_DURATION_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (this.audioProbeContext === context) {
          this.audioProbeContext = null;
          this.audioProbeCancel = null;
        }
        if (typeof context.destroy === "function") {
          try {
            context.destroy();
          } catch (error) {
            console.warn("destroy audio duration probe error:", error);
          }
        }
      };
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        handler(value);
      };
      const canceledError = new Error("音频时长读取已取消");
      canceledError.canceled = true;
      this.audioProbeCancel = () => finish(reject, canceledError);
      const readDuration = () => {
        if (
          settled ||
          this.pageDestroyed ||
          requestId !== this.audioProbeRequestId
        ) {
          finish(reject, canceledError);
          return;
        }
        const duration = Number(context.duration);
        if (Number.isFinite(duration) && duration > 0 && duration <= 86400) {
          finish(resolve, Math.round(duration * 1000) / 1000);
          return;
        }
        retryTimer = setTimeout(readDuration, 120);
      };

      if (typeof context.onCanplay === "function") {
        context.onCanplay(readDuration);
      }
      if (typeof context.onLoadedMetadata === "function") {
        context.onLoadedMetadata(readDuration);
      }
      if (typeof context.onError === "function") {
        context.onError(() => {
          finish(reject, new Error("无法读取这段配音的时长"));
        });
      }

      try {
        context.autoplay = false;
        context.src = filePath;
        readDuration();
      } catch (error) {
        finish(reject, error);
      }
    });
  },

  async prepareSelectedAudio(selectionRequestId) {
    const file = this.data.selectedFile;
    const requestId = (this.audioProbeRequestId || 0) + 1;
    this.audioProbeRequestId = requestId;
    this.setData({
      audioDurationLoading: true,
      audioDurationError: "",
      audioDurationLabel: "",
      localDocumentReady: false
    });

    try {
      const durationSeconds = await this.readAudioDuration(
        file && file.filePath,
        requestId
      );
      if (
        this.pageDestroyed ||
        selectionRequestId !== this.fileSelectionRequestId ||
        requestId !== this.audioProbeRequestId ||
        this.data.selectedAssetType !== "audio" ||
        !this.data.selectedFile ||
        this.data.selectedFile.filePath !== file.filePath
      ) {
        return;
      }
      const roundedLabel = durationSeconds >= 60
        ? `${Math.floor(durationSeconds / 60)} 分 ${Math.round(durationSeconds % 60)} 秒`
        : `${Math.round(durationSeconds)} 秒`;
      this.setData({
        selectedFile: {
          ...this.data.selectedFile,
          durationSeconds
        },
        audioDurationLoading: false,
        audioDurationError: "",
        audioDurationLabel: roundedLabel,
        localDocumentReady: true
      });
    } catch (error) {
      if (
        this.pageDestroyed ||
        selectionRequestId !== this.fileSelectionRequestId ||
        requestId !== this.audioProbeRequestId ||
        (error && error.canceled)
      ) {
        return;
      }
      this.setData({
        audioDurationLoading: false,
        audioDurationError:
          "无法读取这段配音的时长，请重新选择音频文件。",
        audioDurationLabel: "",
        localDocumentReady: false
      });
    }
  },

  resetRetryState() {
    this.retryStage = "";
    this.pendingUploadTicket = null;
    this.setData({ canRetry: false });
  },

  requiresLocalDocument(file = this.data.selectedFile, options = {}) {
    const fileName = normalizeText(file && file.fileName, 180).toLowerCase();
    const uploadMode = normalizeText(
      options.uploadMode || this.data.uploadMode,
      64
    );
    const assetType = normalizeText(
      options.assetType || this.data.selectedAssetType,
      64
    );

    return Boolean(
      uploadMode === "cloud-storage-direct" &&
      ["manuscript", "special-topic"].includes(assetType) &&
      fileName.endsWith(".docx")
    );
  },

  async prepareSelectedDocument(options = {}) {
    const file = options.file || this.data.selectedFile;
    const assetType = options.assetType || this.data.selectedAssetType;
    const uploadMode = options.uploadMode || this.data.uploadMode;
    const requestId = (this.localParseRequestId || 0) + 1;
    this.localParseRequestId = requestId;
    this.localDocumentManifest = null;

    if (!this.requiresLocalDocument(file, { assetType, uploadMode })) {
      this.setData({
        localDocumentReady: true,
        localParseError: "",
        localParseLoading: false,
        localParsePreview: [],
        localParseSummary: "",
        localParseWarning: ""
      });
      return;
    }

    this.setData({
      localDocumentReady: false,
      localParseError: "",
      localParseLoading: true,
      localParsePreview: [],
      localParseSummary: "正在本机读取 Word 正文",
      localParseWarning: ""
    });

    try {
      const manifest = createClientManifest(
        await docxImport.analyzeDocx(file.filePath, {
          wx,
          ...getDocumentImportLimits(assetType)
        })
      );

      if (
        this.pageDestroyed ||
        requestId !== this.localParseRequestId ||
        !this.data.selectedFile ||
        this.data.selectedFile.filePath !== file.filePath ||
        this.data.selectedAssetType !== assetType
      ) {
        return;
      }

      const stats = manifest && manifest.stats || {};
      if (stats.truncated) {
        const error = new Error(
          getDocumentTooLargeMessage(assetType)
        );
        error.userMessage = error.message;
        throw error;
      }
      if (Number(stats.omittedImageReferences) > 0) {
        const error = new Error(
          "这份 Word 的图片较多，请拆分文稿后重新上传"
        );
        error.userMessage = error.message;
        throw error;
      }
      if (Number(stats.unsupportedImageReferences) > 0) {
        const error = new Error(
          "Word 中有暂不支持的图片，请改为 JPG、PNG、GIF 或 WEBP 后重新上传"
        );
        error.userMessage = error.message;
        throw error;
      }
      if (utf8ByteLength(JSON.stringify(manifest)) > 700 * 1024) {
        const error = new Error(
          getDocumentTooLargeMessage(assetType)
        );
        error.userMessage = error.message;
        throw error;
      }

      this.localDocumentManifest = manifest;
      const preview = Array.isArray(manifest && manifest.blocks)
        ? manifest.blocks
            .map((block) => normalizeText(block && block.text, 180))
            .filter(Boolean)
            .slice(0, 3)
        : [];
      this.setData({
        localDocumentReady: true,
        localParseError: "",
        localParseLoading: false,
        localParsePreview: preview,
        localParseSummary:
          `已识别 ${Number(stats.extractedBlocks) || 0} 段、` +
          `${Number(stats.extractedCharacters) || 0} 个字` +
          (
            Number(stats.skippedTableOfContentsParagraphs) > 0
              ? `，已跳过目录 ${Number(stats.skippedTableOfContentsParagraphs)} 段`
              : ""
          ),
        localParseWarning: (Array.isArray(manifest.warnings) ? manifest.warnings : [])
          .concat([
            Number(stats.imageCount) > 0
              ? `检测到 ${Number(stats.imageCount)} 张内嵌图片；本轮会保留图片位置说明，图片仍需后续确认。`
              : ""
          ])
          .filter(Boolean)
          .join(" ")
      });
    } catch (error) {
      if (
        this.pageDestroyed ||
        requestId !== this.localParseRequestId
      ) {
        return;
      }
      this.setData({
        localDocumentReady: false,
        localParseError: getErrorMessage(
          error,
          "无法读取这个 Word 文件，请重新选择"
        ),
        localParseLoading: false,
        localParsePreview: [],
        localParseSummary: "",
        localParseWarning: ""
      });
    }
  },

  retryLocalDocument() {
    if (!this.data.localParseLoading && this.data.selectedFile) {
      return this.prepareSelectedDocument();
    }

    return Promise.resolve();
  },

  waitForClientImageDelay(delayMs) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(delayMs) || 0));
    });
  },

  async callAdminContentWithRetry(data, options = {}) {
    const isActive = typeof options.isActive === "function"
      ? options.isActive
      : () => !this.pageDestroyed;
    const maximumRetries = Number.isInteger(options.maximumRetries)
      ? Math.max(0, options.maximumRetries)
      : CLIENT_IMAGE_CONFIRM_MAX_RETRIES;
    const fallback = normalizeText(options.fallback, 180) ||
      "管理员内容服务暂不可用";
    let retries = 0;

    while (isActive()) {
      try {
        const response = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data
        });
        if (!isActive()) {
          return null;
        }
        const result = response.result || {};
        if (!result.success) {
          throw createAdminContentError(result, fallback);
        }
        return result;
      } catch (error) {
        if (
          !isActive() ||
          retries >= maximumRetries ||
          !isRetryableAdminContentError(error)
        ) {
          throw error;
        }
        const delayMs =
          CLIENT_IMAGE_CONFIRM_RETRY_BASE_MS * Math.pow(2, retries);
        retries += 1;
        await this.waitForClientImageDelay(delayMs);
      }
    }

    return null;
  },

  async transferAndConfirmClientImages(
    ticket,
    manifest,
    manifestResult,
    operationId
  ) {
    if (!ticket.imageUploadPlan) {
      ticket.imageUploadPlan = normalizeClientImageUploadPlan(
        manifestResult,
        manifest
      );
    }

    if (this.retryStage !== "image-confirm") {
      this.retryStage = "images";
      this.pendingUploadTicket = ticket;
      this.setData({
        uploadStageLabel: `正在上传内嵌图片（0/${ticket.imageUploadPlan.length}）`,
        uploadProgress: 0,
        imageTransferCompleted: 0,
        imageTransferTotal: ticket.imageUploadPlan.length
      });
      const controller = docxImageTransfer.createCancellationController();
      this.imageTransferController = controller;
      let transferResult;
      try {
        transferResult = await docxImageTransfer.transferDocxImages({
          filePath: ticket.filePath,
          images: manifest.images,
          uploadPlan: ticket.imageUploadPlan,
          existingFiles: Array.isArray(ticket.imageUploadedFiles)
            ? ticket.imageUploadedFiles
            : [],
          wx,
          concurrency: 2,
          cancelToken: controller.token,
          onProgress: (progress = {}) => {
            if (
              this.pageDestroyed ||
              operationId !== this.uploadOperationId
            ) {
              return;
            }
            const total = Math.max(
              0,
              Number(progress.total) || ticket.imageUploadPlan.length
            );
            const completed = Math.max(
              0,
              Math.min(total, Number(progress.completed) || 0)
            );
            const percent = Math.max(
              0,
              Math.min(100, Math.round(Number(progress.percent) || 0))
            );
            const phaseLabel = progress.phase === "extracting"
              ? "正在读取"
              : progress.phase === "uploading"
                ? "正在上传"
                : "正在处理";
            this.setData({
              imageTransferCompleted: completed,
              imageTransferTotal: total,
              uploadProgress: percent,
              uploadStageLabel:
                `${phaseLabel}内嵌图片（${completed}/${total}）`
            });
          }
        });
      } catch (error) {
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return null;
        }
        if (error && Array.isArray(error.uploadedFiles)) {
          ticket.imageUploadedFiles = error.uploadedFiles;
          this.pendingUploadTicket = ticket;
        }
        throw error;
      } finally {
        if (this.imageTransferController === controller) {
          this.imageTransferController = null;
        }
      }

      if (
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }
      if (
        !transferResult ||
        !Array.isArray(transferResult.files) ||
        transferResult.files.length !== ticket.imageUploadPlan.length
      ) {
        throw new Error("Word 图片上传结果不完整，请重试");
      }
      ticket.imageFiles = transferResult.files;
      ticket.imageUploadedFiles = transferResult.files;
      ticket.imageConfirmationBatches = Array.isArray(
        transferResult.confirmationBatches
      )
        ? transferResult.confirmationBatches
        : docxImageTransfer.chunkDocxImageFiles(ticket.imageFiles);
      ticket.imageConfirmationState = ticket.imageConfirmationBatches.map(
        (files) => ({
          confirmed: false,
          files,
          requestId: adminContent.createMutationId("confirm-images")
        })
      );
      this.pendingUploadTicket = ticket;
      this.retryStage = "image-confirm";
    }

    const batches = Array.isArray(ticket.imageConfirmationState)
      ? ticket.imageConfirmationState
      : [];
    if (
      batches.length === 0 ||
      batches.some(
        (batch) =>
          !Array.isArray(batch.files) ||
          batch.files.length < 1 ||
          batch.files.length > 20
      )
    ) {
      throw new Error("Word 图片确认清单无效，请重试");
    }

    let finalResult = manifestResult;
    let confirmedImages = batches
      .filter((batch) => batch.confirmed)
      .reduce((sum, batch) => sum + batch.files.length, 0);
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      if (batch.confirmed) {
        continue;
      }
      if (
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }
      this.setData({
        uploadStageLabel:
          `正在确认内嵌图片（${confirmedImages}/${ticket.imageFiles.length}）`,
        uploadProgress: Math.round(
          (confirmedImages / ticket.imageFiles.length) * 100
        )
      });
      const result = await this.callAdminContentWithRetry(
        {
          action: "confirmClientImages",
          uploadId: ticket.uploadId,
          requestId: batch.requestId,
          files: batch.files
        },
        {
          fallback: "Word 图片确认失败",
          isActive: () =>
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
        }
      );
      if (
        !result ||
        this.pageDestroyed ||
        operationId !== this.uploadOperationId
      ) {
        return null;
      }

      const state = getConfirmedUploadState(result, ticket.mode);
      const finalBatch = index === batches.length - 1;
      if (
        finalBatch
          ? (
              !result.complete ||
              !state.canCreateDraft ||
              state.validationStatus !== "client_manifest_validated"
            )
          : (
              result.complete ||
              !state.requiresClientImages ||
              state.canCreateDraft ||
              state.validationStatus !== "awaiting_client_images"
            )
      ) {
        throw new Error("Word 图片确认状态异常，请刷新后重试");
      }
      batch.confirmed = true;
      confirmedImages += batch.files.length;
      finalResult = result;
      ticket.imageLastConfirmResult = result;
      this.pendingUploadTicket = ticket;
      if (
        batches.slice(index + 1).some((item) => !item.confirmed)
      ) {
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }
    }

    this.setData({
      imageTransferCompleted: ticket.imageFiles.length,
      imageTransferTotal: ticket.imageFiles.length,
      uploadProgress: 100
    });
    return finalResult;
  },

  async startUpload() {
    if (this.data.uploading || this.data.fileChoosing || this.pageDestroyed) {
      return;
    }

    if (!this.data.authorized) {
      wx.showToast({ title: "当前账号没有上传权限", icon: "none" });
      return;
    }

    if (!this.data.uploadAvailable) {
      wx.showToast({ title: "上传通道尚未配置", icon: "none" });
      return;
    }

    if (
      this.data.targetSelectionRequired &&
      (
        !this.targetSelectionConfirmed ||
        !isStableTargetId(this.data.relatedId)
      )
    ) {
      wx.showToast({
        title: this.data.selectedAssetType === "audio"
          ? "请先选择要配音的文章"
          : "请先选择要更新的内容",
        icon: "none"
      });
      return;
    }

    const selectedFile = this.data.selectedFile;

    if (!selectedFile) {
      wx.showToast({ title: "请先选择一个文件", icon: "none" });
      return;
    }

    if (
      this.data.selectedAssetType === "audio" &&
      (
        this.data.audioDurationLoading ||
        !Number.isFinite(Number(selectedFile.durationSeconds)) ||
        Number(selectedFile.durationSeconds) <= 0
      )
    ) {
      wx.showToast({
        title: this.data.audioDurationLoading
          ? "正在读取配音时长，请稍候"
          : "请重新选择能够正常播放的音频文件",
        icon: "none"
      });
      return;
    }

    if (this.requiresLocalDocument(selectedFile)) {
      if (this.data.localParseLoading) {
        wx.showToast({
          title: "正在读取 Word，请稍候",
          icon: "none"
        });
        return;
      }

      if (
        (
          !this.data.localDocumentReady ||
          !this.localDocumentManifest
        ) &&
        !this.data.localParseError
      ) {
        await this.prepareSelectedDocument({
          file: selectedFile,
          assetType: this.data.selectedAssetType,
          uploadMode: this.data.uploadMode
        });

        if (
          this.pageDestroyed ||
          !this.data.selectedFile ||
          this.data.selectedFile.filePath !== selectedFile.filePath
        ) {
          return;
        }
      }

      if (
        !this.data.localDocumentReady ||
        !this.localDocumentManifest
      ) {
        wx.showToast({
          title: "请先重试读取 Word 文件",
          icon: "none"
        });
        return;
      }
    }

    const relatedId = normalizeText(this.data.relatedId, 64).toLowerCase();
    if (!isStableTargetId(relatedId)) {
      wx.showToast({
        title: "内容信息异常，请重新选择栏目",
        icon: "none"
      });
      return;
    }
    if (!isAllowedFile(this.data.selectedAssetType, selectedFile.fileName)) {
      wx.showToast({
        title: `该类型仅支持 ${allowedFileHint(this.data.selectedAssetType)}`,
        icon: "none"
      });
      return;
    }

    const operationId = (this.uploadOperationId || 0) + 1;
    this.uploadOperationId = operationId;
    this.setData({
      uploading: true,
      uploadError: "",
      uploadSuccess: "",
      canRetry: false,
      uploadStageLabel:
        this.retryStage === "manifest"
          ? "正在校验 Word 正文"
          : this.retryStage === "images"
            ? "正在上传内嵌图片"
            : this.retryStage === "image-confirm"
              ? "正在确认内嵌图片"
              : this.retryStage === "confirm"
                ? "正在确认文件"
                : "正在准备上传"
    });

    try {
      let ticket = this.pendingUploadTicket;

      if (!ticket || this.retryStage === "create") {
        this.retryStage = "create";
        const createUploadData = {
          action: "createUpload",
          fileName: selectedFile.fileName,
          declaredBytes: selectedFile.size,
          mimeType: selectedFile.mimeType,
          assetType: this.data.selectedAssetType,
          relatedId
        };
        if (this.data.selectedAssetType === "audio") {
          createUploadData.clientDurationSeconds = Number(
            selectedFile.durationSeconds
          );
        }
        const response = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: createUploadData
        });
        const result = response.result || {};
        const upload = result.upload && typeof result.upload === "object"
          ? result.upload
          : result;
        const uploadId = normalizeText(upload.uploadId || upload.id, 128);
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          if (
            result.success &&
            /^[a-f0-9]{32}$/.test(uploadId) &&
            wx.cloud &&
            typeof wx.cloud.callFunction === "function"
          ) {
            wx.cloud.callFunction({
              name: "adminContentCenter",
              data: { action: "cancelUpload", uploadId }
            }).catch((error) => {
              console.warn("release stale admin upload error:", error);
            });
          }
          return;
        }
        const brokerTransport = normalizeBrokerTransport(result);
        const directTransport = normalizeDirectCloudTransport(result, uploadId);
        const transport = brokerTransport || directTransport;

        if (
          !result.success ||
          !/^[a-f0-9]{32}$/.test(uploadId) ||
          !transport ||
          (
            transport.mode === "https-broker" &&
            !transport.url.endsWith(`/${uploadId}`)
          )
        ) {
          const error = new Error(result.message || "创建上传任务失败");
          error.userMessage = result.message;
          throw error;
        }

        ticket = transport.mode === "https-broker"
          ? {
              uploadId,
              mode: "https-broker",
              brokerUrl: transport.url,
              brokerTicket: transport.ticket,
              fieldName: transport.fieldName,
              filePath: selectedFile.filePath
            }
          : {
              uploadId,
              mode: "cloud-storage-direct",
              cloudPath: transport.cloudPath,
              filePath: selectedFile.filePath,
              originalFileUploadRequired:
                transport.originalFileUploadRequired !== false,
              sourceMode: transport.sourceMode
            };
        this.pendingUploadTicket = ticket;
        const clientManifestOnly = Boolean(
          ticket.mode === "cloud-storage-direct" &&
          ticket.originalFileUploadRequired === false &&
          ticket.sourceMode === "client-manifest-only" &&
          ["manuscript", "special-topic"].includes(
            this.data.selectedAssetType
          ) &&
          this.localDocumentManifest
        );
        if (clientManifestOnly) {
          ticket.confirmResult = {
            success: true,
            requiresClientManifest: true,
            upload: {
              id: uploadId,
              status: "pending_upload",
              validationStatus: "awaiting_client_manifest",
              requiresClientManifest: true
            }
          };
          this.pendingUploadTicket = ticket;
          this.retryStage = "manifest";
        } else {
          this.retryStage = "upload";
        }
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      if (this.retryStage === "upload") {
        this.setData({ uploadStageLabel: "正在上传文件", uploadProgress: 0 });
        if (ticket.mode === "cloud-storage-direct") {
          const directResult = await this.uploadCloudFile(ticket, operationId);
          if (
            this.pageDestroyed ||
            operationId !== this.uploadOperationId
          ) {
            return;
          }
          const fileID = normalizeCloudFileID(
            directResult && directResult.fileID,
            ticket.cloudPath
          );

          if (!fileID) {
            throw new Error("文件上传结果无效，请重新上传");
          }
          ticket.fileID = fileID;
        } else {
          const uploadResult = parseBrokerUploadResult(
            await this.uploadFile(ticket, operationId)
          );
          if (
            this.pageDestroyed ||
            operationId !== this.uploadOperationId
          ) {
            return;
          }
          const completedUploadId = normalizeText(uploadResult && uploadResult.uploadId, 128);
          const completedStatus = normalizeText(uploadResult && uploadResult.status, 32);

          if (completedUploadId !== ticket.uploadId || completedStatus !== "uploaded") {
            throw new Error("文件上传结果无效，请重试");
          }
        }

        this.pendingUploadTicket = ticket;
        this.retryStage = "confirm";
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      let confirmResult = ticket.confirmResult || {};
      if (this.retryStage === "confirm") {
        this.setData({
          uploadStageLabel: ticket.mode === "cloud-storage-direct"
            ? "正在确认云端原件"
            : "正在确认文件",
          uploadProgress: 100
        });
        const confirmData = {
          action: "confirmUpload",
          uploadId: ticket.uploadId
        };
        if (ticket.mode === "cloud-storage-direct") {
          confirmData.fileID = ticket.fileID;
        }
        const confirmResponse = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: confirmData
        });
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        confirmResult = confirmResponse.result || {};

        if (!confirmResult.success) {
          const error = new Error(confirmResult.message || "文件确认失败");
          error.userMessage = confirmResult.message;
          error.code = confirmResult.code;
          if (confirmResult.code === "UPLOAD_RESERVATION_EXPIRED") {
            error.restartReservation = true;
          }
          throw error;
        }
        ticket.confirmResult = confirmResult;
        this.pendingUploadTicket = ticket;
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      let finalResult = ticket.manifestResult || confirmResult;
      let confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
      const localManifest = this.localDocumentManifest;
      const localImageCount = Number(
        localManifest && localManifest.stats && localManifest.stats.imageCount
      ) || 0;
      if (confirmedState.requiresClientManifest && localManifest) {
        const manifestJson = JSON.stringify(localManifest);
        if (utf8ByteLength(manifestJson) > 700 * 1024) {
          const error = new Error(
            getDocumentTooLargeMessage(this.data.selectedAssetType)
          );
          error.userMessage = error.message;
          throw error;
        }
        if (!ticket.manifestRequestId) {
          ticket.manifestRequestId = adminContent.createMutationId("attach-manifest");
        }
        this.pendingClientManifest = {
          uploadId: ticket.uploadId,
          manifest: localManifest
        };
        this.pendingUploadTicket = ticket;
        this.retryStage = "manifest";
        this.setData({
          uploadStageLabel: "正在校验 Word 正文",
          uploadProgress: 100
        });
        const manifestResponse = await wx.cloud.callFunction({
          name: "adminContentCenter",
          data: {
            action: "attachClientManifest",
            uploadId: ticket.uploadId,
            requestId: ticket.manifestRequestId,
            manifest: localManifest
          }
        });
        if (
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        finalResult = manifestResponse.result || {};
        if (!finalResult.success) {
          const error = new Error(finalResult.message || "Word 正文校验失败");
          error.userMessage = finalResult.message;
          error.code = finalResult.code;
          if (finalResult.code === "UPLOAD_RESERVATION_EXPIRED") {
            error.restartReservation = true;
          }
          throw error;
        }
        ticket.manifestResult = finalResult;
        this.pendingUploadTicket = ticket;
        confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
        const awaitingClientImages = Boolean(
          confirmedState.requiresClientImages &&
          !confirmedState.canCreateDraft &&
          confirmedState.validationStatus === "awaiting_client_images"
        );
        if (
          !awaitingClientImages &&
          (
            !confirmedState.canCreateDraft ||
            confirmedState.validationStatus !== "client_manifest_validated"
          )
        ) {
          throw new Error("Word 正文尚未完成校验，请稍后重试");
        }
      }

      if (
        confirmedState.requiresClientImages &&
        !confirmedState.canCreateDraft &&
        confirmedState.validationStatus === "awaiting_client_images"
      ) {
        finalResult = await this.transferAndConfirmClientImages(
          ticket,
          localManifest,
          finalResult,
          operationId
        );
        if (
          !finalResult ||
          this.pageDestroyed ||
          operationId !== this.uploadOperationId
        ) {
          return;
        }
        confirmedState = getConfirmedUploadState(finalResult, ticket.mode);
      }

      if (
        localManifest &&
        (
          !confirmedState.canCreateDraft ||
          confirmedState.validationStatus !== "client_manifest_validated"
        )
      ) {
        throw new Error("Word 正文及图片尚未完成校验，请稍后重试");
      }

      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }

      this.retryStage = "";
      this.pendingUploadTicket = null;
      this.pendingClientManifest = null;
      this.localDocumentManifest = null;
      const prepareAnotherNewContent = Boolean(
        this.data.contentMode === "new" &&
        ["manuscript", "special-topic"].includes(this.data.selectedAssetType)
      );
      const nextRelatedId = prepareAnotherNewContent
        ? createNewTargetId(this.data.selectedAssetType)
        : relatedId;
      if (prepareAnotherNewContent) {
        this.targetSelectionConfirmed = true;
      }
      this.setData({
        selectedFile: null,
        relatedId: nextRelatedId,
        uploadProgress: 100,
        uploadStageLabel: confirmedState.canCreateDraft
          ? localManifest
            ? "正文结构校验完成，可创建内容草稿"
            : this.data.selectedAssetType === "audio"
              ? "配音上传完成，可创建内容草稿"
              : this.data.selectedAssetType === "full-book-pdf"
                ? "下载版 PDF 上传完成，可创建草稿"
                : "文件上传完成，可创建内容草稿"
          : "文件已上传，等待正文校验",
        uploadSuccess: confirmedState.canCreateDraft
          ? localManifest
            ? localImageCount > 0
              ? `Word 正文及 ${localImageCount} 张内嵌图片已校验，可创建草稿；系统不会自动发布。`
              : "Word 正文结构已校验，可创建草稿；系统不会自动发布。"
            : this.data.selectedAssetType === "audio"
              ? "配音文件已上传，可创建草稿；系统不会自动发布。"
              : this.data.selectedAssetType === "full-book-pdf"
                ? "下载版 PDF 已上传，可创建草稿并送审；系统不会自动发布。"
                : "文件已上传，可创建草稿；系统不会自动发布。"
          : "原件已经收到，完成内容解析与安全校验前不会创建草稿或自动发布。",
        uploadError: "",
        canRetry: false
      });
      await this.loadHistory({ quiet: true });
    } catch (error) {
      if (this.pageDestroyed || operationId !== this.uploadOperationId) {
        return;
      }
      if (
        error &&
        (
          error.nativeErrorMessage ||
          error.nativeErrorCode ||
          error.requestId
        )
      ) {
        console.error("admin upload diagnostic:", {
          code: error.code || "",
          nativeErrorCode: error.nativeErrorCode || "",
          nativeErrorMessage: error.nativeErrorMessage || "",
          requestId: error.requestId || "",
          imageOrder: error.imageOrder || 0,
          cloudPath: error.cloudPath || "",
          temporaryFileSize: error.temporaryFileSize
        });
      }
      console.error("admin upload error:", error);

      if (error && error.restartReservation) {
        this.retryStage = "create";
        this.pendingUploadTicket = null;
      }

      if (!this.pageDestroyed && operationId === this.uploadOperationId) {
        this.setData({
          uploadError: getErrorMessage(error, "上传失败，请稍后重试。"),
          uploadStageLabel:
            this.retryStage === "manifest"
              ? "Word 正文校验未完成"
              : this.retryStage === "images"
                ? "内嵌图片上传未完成"
                : this.retryStage === "image-confirm"
                  ? "内嵌图片确认未完成"
                  : this.retryStage === "confirm"
                    ? "云端文件确认未完成"
                    : this.retryStage === "create"
                      ? "上传任务创建未完成"
                      : "云端文件上传未完成",
          canRetry: true
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.uploadOperationId) {
        this.setData({ uploading: false });
      }
    }
  },

  retryUpload() {
    if (this.data.canRetry && !this.data.uploading) {
      return this.startUpload();
    }

    return Promise.resolve();
  },

  openDraft(event) {
    const draftId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.draftId,
      32
    ).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(draftId) || typeof wx.navigateTo !== "function") {
      return;
    }
    wx.navigateTo({ url: `/pages/adminDraft/adminDraft?id=${draftId}` });
  },

  isDraftOperationActive(operationId) {
    return Boolean(
      !this.pageDestroyed &&
      this.isPageVisible === true &&
      operationId === this.draftOperationId
    );
  },

  markUploadDraftCreated(uploadId) {
    const uploads = Array.isArray(this.data.uploads)
      ? this.data.uploads
      : [];
    let changed = false;
    const nextUploads = uploads.map((upload) => {
      if (!upload || upload.uploadId !== uploadId) return upload;
      changed = true;
      return {
        ...upload,
        hasDraft: true,
        canCancel: false
      };
    });
    if (changed) {
      this.setData({ uploads: nextUploads });
    }
  },

  navigateToCreatedDraft(draftId, uploadId, operationId) {
    if (!this.isDraftOperationActive(operationId)) return false;
    this.markUploadDraftCreated(uploadId);
    const showNavigationError = () => {
      if (!this.isDraftOperationActive(operationId)) return;
      this.setData({
        historyError: "草稿已创建，但页面打开失败，请点击“打开草稿”重试。"
      });
    };
    if (typeof wx.navigateTo !== "function") {
      showNavigationError();
      return false;
    }
    try {
      wx.navigateTo({
        url: `/pages/adminDraft/adminDraft?id=${draftId}`,
        fail: showNavigationError
      });
      return true;
    } catch (error) {
      console.warn("navigate to created admin draft error:", error);
      showNavigationError();
      return false;
    }
  },

  updateHistoryUploadFromResult(uploadId, result) {
    const uploads = Array.isArray(this.data.uploads)
      ? this.data.uploads
      : [];
    const current = uploads.find((item) => item.uploadId === uploadId) || {
      uploadId
    };
    const response = result && typeof result === "object" ? result : {};
    const remote = response.upload && typeof response.upload === "object"
      ? response.upload
      : {};
    const patch = {
      ...current,
      ...remote,
      uploadId,
      status:
        normalizeText(remote.status || response.status, 48) ||
        current.status,
      validationStatus:
        normalizeText(
          remote.validationStatus || response.validationStatus,
          48
        ) || current.validationStatus,
      clientImageCount: firstNonNegativeInteger(
        remote.clientImageCount,
        response.clientImageCount,
        response.totalCount,
        current.clientImageCount
      ),
      confirmedClientImageCount: firstNonNegativeInteger(
        remote.confirmedClientImageCount,
        response.confirmedClientImageCount,
        response.confirmedCount,
        current.confirmedClientImageCount
      ),
      remainingClientImageCount: firstNonNegativeInteger(
        remote.remainingClientImageCount,
        response.remainingClientImageCount,
        response.remainingCount,
        current.remainingClientImageCount
      ),
      cleanupRequired:
        typeof remote.cleanupRequired === "boolean"
          ? remote.cleanupRequired
          : typeof response.cleanupRequired === "boolean"
            ? response.cleanupRequired
            : current.cleanupRequired === true,
      cleanupRemainingCount: firstNonNegativeInteger(
        remote.cleanupRemainingCount,
        response.cleanupRemainingCount,
        response.remainingCleanupCount,
        current.cleanupRemainingCount
      )
    };
    if (
      remote.cleanupRequired === false ||
      response.cleanupRequired === false
    ) {
      patch.cleanupRemainingCount = 0;
    }
    const normalized = normalizeUpload(patch);

    if (!normalized) {
      return current;
    }
    normalized.hasDraft = current.hasDraft === true;
    if (
      response.canCreateDraft === true ||
      remote.canCreateDraft === true
    ) {
      normalized.canCreateDraft = true;
      normalized.canResumeClientImages = false;
    }
    const nextUploads = uploads.map((item) =>
      item.uploadId === uploadId ? normalized : item
    );
    if (!nextUploads.some((item) => item.uploadId === uploadId)) {
      nextUploads.unshift(normalized);
    }
    this.setData({ uploads: nextUploads });
    return normalized;
  },

  async resumeClientImages(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.resumingClientImagesId ||
      this.data.cancelingUploadId ||
      this.data.cleaningUpUploadId
    ) {
      return;
    }

    const operationId = (this.resumeClientImagesOperationId || 0) + 1;
    this.resumeClientImagesOperationId = operationId;
    this.setData({
      resumingClientImagesId: uploadId,
      historyError: ""
    });
    let completed = false;
    let previousSignature = "";
    let stalledRounds = 0;

    try {
      for (
        let round = 0;
        round < CLIENT_IMAGE_RESUME_MAX_ROUNDS;
        round += 1
      ) {
        const requestData = {
          action: "resumeClientImages",
          uploadId,
          requestId: adminContent.createMutationId("resume-images")
        };
        const result = await this.callAdminContentWithRetry(requestData, {
          fallback: "图片确认暂时中断，请稍后重试",
          isActive: () =>
            !this.pageDestroyed &&
            this.isPageVisible &&
            operationId === this.resumeClientImagesOperationId
        });
        if (
          !result ||
          this.pageDestroyed ||
          operationId !== this.resumeClientImagesOperationId
        ) {
          return;
        }
        const upload = this.updateHistoryUploadFromResult(uploadId, result);
        const validationStatus = normalizeText(
          upload && upload.validationStatus,
          48
        ).toLowerCase();
        completed = Boolean(
          result.complete === true ||
          result.canCreateDraft === true ||
          upload && upload.canCreateDraft === true ||
          validationStatus === "client_manifest_validated" ||
          upload &&
            upload.clientImageProgressKnown === true &&
            upload.clientImageCount > 0 &&
            upload.remainingClientImageCount === 0
        );
        if (completed) {
          break;
        }

        const signature = [
          upload && upload.clientImageCount,
          upload && upload.confirmedClientImageCount,
          upload && upload.remainingClientImageCount,
          validationStatus
        ].join(":");
        if (signature === previousSignature) {
          stalledRounds += 1;
        } else {
          previousSignature = signature;
          stalledRounds = 0;
        }
        if (stalledRounds >= 2) {
          throw new Error("图片确认进度没有更新，请稍后再试");
        }
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }

      if (!completed) {
        throw new Error("本轮已确认较多图片，请再次点击继续确认");
      }
      await this.loadHistory({ quiet: true, append: false });
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId &&
        typeof wx.showToast === "function"
      ) {
        wx.showToast({ title: "图片确认完成", icon: "success" });
      }
    } catch (error) {
      console.error("resume client images error:", error);
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(
            error,
            "图片确认暂时中断，请稍后重试。"
          )
        });
      }
    } finally {
      if (
        !this.pageDestroyed &&
        operationId === this.resumeClientImagesOperationId
      ) {
        this.setData({ resumingClientImagesId: "" });
      }
    }
  },

  async runCanceledUploadCleanup(
    uploadId,
    { quiet = false, maximumRounds = 20 } = {}
  ) {
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      this.data.cleaningUpUploadId
    ) {
      return false;
    }
    const operationId =
      (this.cleanupCanceledUploadOperationId || 0) + 1;
    this.cleanupCanceledUploadOperationId = operationId;
    this.setData({
      cleaningUpUploadId: uploadId,
      historyError: quiet ? this.data.historyError : ""
    });
    let completed = false;

    try {
      for (let round = 0; round < maximumRounds; round += 1) {
        const result = await this.callAdminContentWithRetry(
          {
            action: "cleanupCanceledUpload",
            uploadId,
            requestId: adminContent.createMutationId("cleanup-upload")
          },
          {
            fallback: "取消任务的云文件尚未清理完成",
            isActive: () =>
              !this.pageDestroyed &&
              this.isPageVisible &&
              operationId === this.cleanupCanceledUploadOperationId,
            maximumRetries: 1
          }
        );
        if (!result) {
          return false;
        }
        const upload = this.updateHistoryUploadFromResult(uploadId, result);
        const remaining = firstNonNegativeInteger(
          result.cleanupRemainingCount,
          result.remainingCleanupCount,
          upload && upload.cleanupRemainingCount
        );
        completed = Boolean(
          result.complete === true ||
          result.cleanupRequired === false ||
          upload && upload.cleanupRequired === false ||
          remaining === 0
        );
        if (completed) {
          break;
        }
        await this.waitForClientImageDelay(
          CLIENT_IMAGE_CONFIRM_BATCH_GAP_MS
        );
      }
      await this.loadHistory({ quiet: true, append: false });
      if (
        completed &&
        !quiet &&
        typeof wx.showToast === "function"
      ) {
        wx.showToast({ title: "云文件清理完成", icon: "success" });
      }
      return completed;
    } catch (error) {
      console.warn("cleanup canceled admin upload error:", error);
      if (
        !quiet &&
        !this.pageDestroyed &&
        operationId === this.cleanupCanceledUploadOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(
            error,
            "云文件尚未清理完成，请稍后重试。"
          )
        });
      }
      return false;
    } finally {
      if (
        !this.pageDestroyed &&
        operationId === this.cleanupCanceledUploadOperationId
      ) {
        this.setData({ cleaningUpUploadId: "" });
      }
    }
  },

  continueCanceledUploadCleanup(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    return this.runCanceledUploadCleanup(uploadId);
  },

  async reconcileCreatedDraft(uploadId, operationId) {
    try {
      const result = await this.callAdminContentWithRetry(
        {
          action: "getDraft",
          draftId: uploadId
        },
        {
          maximumRetries: 1,
          fallback: "草稿创建结果核对失败",
          isActive: () => this.isDraftOperationActive(operationId)
        }
      );
      if (!result || !this.isDraftOperationActive(operationId)) return null;
      const draft = adminContent.normalizeDraft(result.draft);
      return draft && draft.id === uploadId ? draft : null;
    } catch (error) {
      const code = normalizeText(
        error && (error.code || error.errCode),
        80
      ).toUpperCase();
      if (code !== "DRAFT_NOT_FOUND") {
        console.warn("reconcile admin draft error:", error);
      }
      return null;
    }
  },

  async createOrOpenDraft(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.creatingDraftId
    ) {
      return;
    }
    if (!this.draftMutationIds[uploadId]) {
      this.draftMutationIds[uploadId] = adminContent.createMutationId("create-draft");
    }
    const operationId = (this.draftOperationId || 0) + 1;
    this.draftOperationId = operationId;
    this.setData({ creatingDraftId: uploadId, historyError: "" });
    try {
      const result = await this.callAdminContentWithRetry(
        {
          action: "createDraftFromUpload",
          uploadId,
          requestId: this.draftMutationIds[uploadId]
        },
        {
          fallback: "创建草稿失败",
          isActive: () => this.isDraftOperationActive(operationId)
        }
      );
      if (!result) return;
      if (!this.isDraftOperationActive(operationId)) return;
      const draft = adminContent.normalizeDraft(result.draft);
      if (!draft || draft.id !== uploadId) {
        throw new Error("服务端返回的草稿状态无效");
      }
      delete this.draftMutationIds[uploadId];
      this.navigateToCreatedDraft(draft.id, uploadId, operationId);
    } catch (error) {
      console.error("create admin draft error:", error);
      let reconciledDraft = null;
      const retryable = isRetryableAdminContentError(error);
      if (retryable) {
        reconciledDraft = await this.reconcileCreatedDraft(uploadId, operationId);
      } else {
        delete this.draftMutationIds[uploadId];
      }
      if (
        reconciledDraft &&
        this.isDraftOperationActive(operationId)
      ) {
        delete this.draftMutationIds[uploadId];
        this.navigateToCreatedDraft(
          reconciledDraft.id,
          uploadId,
          operationId
        );
        return;
      }
      if (this.isDraftOperationActive(operationId)) {
        this.setData({
          historyError: retryable
            ? "创建结果暂未确认，已保留本次请求；请稍后点击“创建草稿”继续核对。"
            : getErrorMessage(error, "创建草稿失败，请稍后重试。")
        });
      }
    } finally {
      if (this.isDraftOperationActive(operationId)) {
        this.setData({ creatingDraftId: "" });
      }
    }
  },

  async cancelUpload(event) {
    const uploadId = normalizeText(
      event && event.currentTarget && event.currentTarget.dataset.uploadId,
      32
    ).toLowerCase();
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !this.data.capabilities.drafts ||
      this.data.cancelingUploadId ||
      this.data.resumingClientImagesId ||
      this.data.cleaningUpUploadId
    ) {
      return;
    }
    const confirmed = await confirmModal(
      "取消上传任务",
      "未绑定草稿的原件会进入安全清理流程，取消后不能恢复。",
      "取消任务"
    );
    if (!confirmed) return;
    const operationId = (this.cancelOperationId || 0) + 1;
    this.cancelOperationId = operationId;
    this.setData({ cancelingUploadId: uploadId, historyError: "" });
    try {
      const response = await wx.cloud.callFunction({
        name: "adminContentCenter",
        data: { action: "cancelUpload", uploadId }
      });
      const result = response.result || {};
      if (this.pageDestroyed || operationId !== this.cancelOperationId) return;
      if (!result.success) {
        throw createAdminContentError(result, "取消上传失败");
      }
      const canceledFromResponse = this.updateHistoryUploadFromResult(
        uploadId,
        {
          ...result,
          status: "canceled",
          upload: {
            ...(result.upload && typeof result.upload === "object"
              ? result.upload
              : {}),
            status: "canceled"
          }
        }
      );
      const refreshed = await this.loadHistory({
        quiet: true,
        append: false
      });
      const canceledUpload = (
        Array.isArray(refreshed) ? refreshed : this.data.uploads
      ).find((item) => item.uploadId === uploadId) ||
        canceledFromResponse ||
        null;
      if (
        canceledUpload &&
        canceledUpload.status === "canceled" &&
        canceledUpload.cleanupRequired
      ) {
        this.runCanceledUploadCleanup(uploadId, {
          quiet: true,
          maximumRounds: 10
        });
      }
    } catch (error) {
      console.error("cancel admin upload error:", error);
      let canceledAfterRefresh = false;
      let refreshedUpload = null;
      if (
        isRetryableAdminContentError(error) &&
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        const refreshed = await this.loadHistory({
          quiet: true,
          append: false
        });
        refreshedUpload = (
          Array.isArray(refreshed) ? refreshed : this.data.uploads
        ).find((item) => item.uploadId === uploadId) || null;
        canceledAfterRefresh = Boolean(
          refreshedUpload && refreshedUpload.status === "canceled"
        );
      }
      if (
        canceledAfterRefresh &&
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        this.setData({ historyError: "" });
        if (typeof wx.showToast === "function") {
          wx.showToast({ title: "任务已取消", icon: "success" });
        }
        if (refreshedUpload.cleanupRequired) {
          this.runCanceledUploadCleanup(uploadId, {
            quiet: true,
            maximumRounds: 10
          });
        }
      } else if (
        !this.pageDestroyed &&
        operationId === this.cancelOperationId
      ) {
        this.setData({
          historyError: getErrorMessage(error, "取消上传失败，请稍后重试。")
        });
      }
    } finally {
      if (!this.pageDestroyed && operationId === this.cancelOperationId) {
        this.setData({ cancelingUploadId: "" });
      }
    }
  },

  uploadCloudFile(ticket, operationId) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || typeof wx.cloud.uploadFile !== "function") {
        reject(new Error("当前微信版本不支持文件上传，请更新微信后重试"));
        return;
      }

      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handler(value);
      };
      const fail = (error) => {
        console.error("cloud storage upload raw error:", error);
        const failure = wrapCloudUploadError(error);
        finish(reject, failure);
      };
      let task = null;

      try {
        task = wx.cloud.uploadFile({
          cloudPath: ticket.cloudPath,
          filePath: ticket.filePath,
          success: (result) => finish(resolve, result),
          fail
        });
      } catch (error) {
        fail(error);
        return;
      }

      this.uploadTask = task;

      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((progressResult) => {
          if (
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
          ) {
            const progress = Math.max(
              0,
              Math.min(100, Math.round(Number(progressResult.progress) || 0))
            );
            this.setData({ uploadProgress: progress });
          }
        });
      }

      if (task && typeof task.then === "function") {
        task.then(
          (result) => finish(resolve, result),
          fail
        );
      }
    }).finally(() => {
      this.uploadTask = null;
    });
  },

  uploadFile(ticket, operationId) {
    return new Promise((resolve, reject) => {
      if (typeof wx.uploadFile !== "function") {
        reject(new Error("当前微信版本不支持安全文件上传"));
        return;
      }

      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handler(value);
      };
      let task = null;

      try {
        task = wx.uploadFile({
          url: ticket.brokerUrl,
          filePath: ticket.filePath,
          name: ticket.fieldName,
          header: {
            Authorization: `Bearer ${ticket.brokerTicket}`
          },
          success: (result) => finish(resolve, result),
          fail: (error) => finish(reject, error)
        });
      } catch (error) {
        finish(reject, error);
        return;
      }

      this.uploadTask = task;

      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((progressResult) => {
          if (
            !this.pageDestroyed &&
            operationId === this.uploadOperationId
          ) {
            const progress = Math.max(
              0,
              Math.min(100, Math.round(Number(progressResult.progress) || 0))
            );
            this.setData({ uploadProgress: progress });
          }
        });
      }

      if (task && typeof task.then === "function") {
        task.then(
          (result) => finish(resolve, result),
          (error) => finish(reject, error)
        );
      }
    }).finally(() => {
      this.uploadTask = null;
    });
  }
});
