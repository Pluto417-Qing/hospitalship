const { loadContentDetail } = require("../../utils/contents");

const SEEK_STEP_SECONDS = 15;
const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const MEMBER_LOGIN_CODES = new Set([
  "MEMBER_LOGIN_REQUIRED",
  "MEMBER_REQUIRED",
  "NOT_REGISTERED"
]);
const AUDIO_STATUS_TITLES = Object.freeze({
  loading: "音频正在加载",
  unavailable: "配音资源尚未开放",
  error: "音频加载失败，点击播放重试"
});

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(Number(seconds))
    ? Math.max(0, Math.floor(Number(seconds)))
    : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = String(safeSeconds % 60).padStart(2, "0");

  return `${minutes}:${remainingSeconds}`;
}

function formatRemaining(currentTime, duration) {
  if (!duration) {
    return "−--:--";
  }

  return `−${formatTime(Math.max(0, duration - currentTime))}`;
}

function isSafeHTTPSURL(value) {
  return Boolean(
    typeof value === "string" &&
      value.length <= 4096 &&
      /^https:\/\/[^/?#\s\\]+(?:[/?#]|$)/.test(value) &&
      !/[\s\\\u0000-\u001f]/.test(value)
  );
}

function getSafeTracks(result) {
  const tracks = result && result.manifest && result.manifest.tracks;

  if (
    !result ||
    !result.success ||
    !result.available ||
    !Array.isArray(tracks)
  ) {
    return [];
  }

  return tracks
    .map((track, index) => {
      const source = track && track.src;

      if (!isSafeHTTPSURL(source)) {
        return null;
      }

      const trackNo = Number(track.trackNo);

      return {
        src: source,
        title: typeof track.title === "string" ? track.title.trim() : "",
        durationSeconds: Math.max(0, Number(track.durationSeconds) || 0),
        trackNo: Number.isFinite(trackNo) && trackNo > 0 ? trackNo : index + 1,
        sourceIndex: index
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.trackNo === right.trackNo
        ? left.sourceIndex - right.sourceIndex
        : left.trackNo - right.trackNo
    );
}

Page({
  data: {
    content: null,
    hasAudio: false,
    isPlaying: false,
    currentTimeText: "0:00",
    durationText: "--:--",
    remainingTimeText: "−--:--",
    progressPercent: 0,
    audioStatus: "idle",
    playbackRate: 1,
    playbackRateText: "1倍"
  },

  async onLoad(options = {}) {
    let contentId = "";

    try {
      contentId = decodeURIComponent(options.id || "");
    } catch (error) {
      contentId = "";
    }

    this.pendingContentId = contentId;
    await this.loadContentMetadata(contentId);
  },

  async loadContentMetadata(contentId) {
    if (!contentId || this.contentMetadataPending || this.isUnloaded) {
      return;
    }

    this.contentMetadataPending = true;
    const content = await loadContentDetail(contentId, "audio");
    this.contentMetadataPending = false;

    if (this.isUnloaded) {
      return;
    }

    if (!content || !content.available) {
      if (content && MEMBER_LOGIN_CODES.has(content.errorCode)) {
        this.requestMemberLogin();
        return;
      }

      if (
        content &&
        ["CLOUD_UNAVAILABLE", "CONTENT_REQUEST_FAILED", "CONTENT_READ_FAILED"].includes(
          content.errorCode
        )
      ) {
        wx.showModal({
          title: "音频信息读取失败",
          content: content.errorMessage || "请检查网络后重试。",
          cancelText: "返回",
          confirmText: "重试",
          success: (result) => {
            if (result.confirm) {
              this.loadContentMetadata(this.pendingContentId);
            } else {
              this.leaveUnavailablePage();
            }
          },
          fail: () => this.leaveUnavailablePage()
        });
        return;
      }

      wx.showToast({
        title: (content && content.errorMessage) || "有声内容尚未开放",
        icon: "none"
      });
      this.returnTimer = setTimeout(() => this.leaveUnavailablePage(), 700);
      return;
    }

    if (!content.audioAvailable) {
      wx.showToast({
        title: "配音资源尚未开放",
        icon: "none"
      });
      this.returnTimer = setTimeout(() => this.leaveUnavailablePage(), 700);
      return;
    }

    this.setData({ content });
    this.loadAudioManifest(content.id);
  },

  leaveUnavailablePage() {
    this.returnTimer = null;
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];

    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }

    wx.switchTab({
      url: "/pages/index/index"
    });
  },

  requestMemberLogin() {
    if (this.memberLoginPromptVisible || this.isUnloaded) {
      return;
    }

    this.memberLoginPromptVisible = true;
    this.destroyAudioContext();
    this.setAudioStatus("unavailable");
    wx.showModal({
      title: "请先登录少年会员",
      content: "登录后即可继续收听当前音频。",
      cancelText: "返回",
      confirmText: "去少年我",
      success: (result) => {
        this.memberLoginPromptVisible = false;

        if (this.isUnloaded) {
          return;
        }

        if (!result.confirm) {
          this.leaveUnavailablePage();
          return;
        }

        if (typeof wx.setStorageSync === "function") {
          wx.setStorageSync("pendingMemberIntent", {
            type: "audio",
            page: "articleAudio",
            contentId: this.pendingContentId,
            createdAt: Date.now()
          });
        }

        wx.switchTab({
          url: "/pages/member/member",
          fail: () => this.leaveUnavailablePage()
        });
      },
      fail: () => {
        this.memberLoginPromptVisible = false;
        this.leaveUnavailablePage();
      }
    });
  },

  setAudioStatus(status, { notify = false } = {}) {
    this.setData({
      audioStatus: status,
      hasAudio: status === "ready",
      isPlaying: status === "ready" ? this.data.isPlaying : false
    });

    if (notify && AUDIO_STATUS_TITLES[status]) {
      wx.showToast({
        title: AUDIO_STATUS_TITLES[status],
        icon: "none"
      });
    }
  },

  async loadAudioManifest(contentId) {
    if (this.audioManifestPending || this.isUnloaded) {
      return;
    }

    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") {
      this.setAudioStatus("error", { notify: true });
      return;
    }

    this.audioManifestPending = true;
    this.destroyAudioContext();
    this.tracks = [];
    this.currentTrackIndex = 0;
    this.setAudioStatus("loading");

    try {
      const response = await wx.cloud.callFunction({
        name: "getAudioManifest",
        data: {
          contentId
        }
      });

      if (this.isUnloaded) {
        return;
      }

      const result = response.result || {};

      if (!result.success) {
        if (MEMBER_LOGIN_CODES.has(result.code)) {
          this.requestMemberLogin();
          return;
        }

        this.setAudioStatus("error", { notify: true });
        return;
      }

      if (!result.available) {
        this.setAudioStatus("unavailable", { notify: true });
        return;
      }

      const tracks = getSafeTracks(result);

      if (tracks.length === 0) {
        this.setAudioStatus("error", { notify: true });
        return;
      }

      this.tracks = tracks;
      this.setAudioStatus("ready");
      this.activateTrack(0);
    } catch (error) {
      if (this.isUnloaded) {
        return;
      }

      console.error("loadAudioManifest error:", error);
      this.setAudioStatus("error", { notify: true });
    } finally {
      this.audioManifestPending = false;
    }
  },

  activateTrack(index, { notify = false, autoplay = false } = {}) {
    const track = Array.isArray(this.tracks) ? this.tracks[index] : null;

    if (!track) {
      this.setAudioStatus("error", { notify: true });
      return;
    }

    this.currentTrackIndex = index;
    this.trackDuration = Number(track.durationSeconds) || 0;
    this.setData({
      isPlaying: false,
      currentTimeText: "0:00",
      durationText: this.trackDuration
        ? formatTime(this.trackDuration)
        : "--:--",
      remainingTimeText: formatRemaining(0, this.trackDuration),
      progressPercent: 0
    });
    this.createAudioContext(track.src, { autoplay });

    if (notify) {
      wx.showToast({
        title: `已切换至第${index + 1}轨`,
        icon: "none"
      });
    }
  },

  createAudioContext(source, { autoplay = false } = {}) {
    if (!isSafeHTTPSURL(source)) {
      this.setAudioStatus("error", { notify: true });
      return;
    }

    this.destroyAudioContext();

    const audioContext = wx.createInnerAudioContext();

    this.audioContext = audioContext;
    audioContext.playbackRate = this.data.playbackRate;
    audioContext.autoplay = autoplay;

    audioContext.onPlay(() => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      this.setData({ isPlaying: true });
    });
    audioContext.onPause(() => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      this.setData({ isPlaying: false });
    });
    audioContext.onCanplay(() => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      const duration = Number(audioContext.duration) || this.trackDuration;

      if (duration) {
        this.trackDuration = duration;
        this.setData({
          durationText: formatTime(duration),
          remainingTimeText: formatRemaining(0, duration)
        });
      }
    });
    audioContext.onTimeUpdate(() => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      const currentTime = Number(audioContext.currentTime) || 0;
      const duration = Number(audioContext.duration) || this.trackDuration || 0;
      const progressPercent = duration
        ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
        : 0;

      this.setData({
        currentTimeText: formatTime(currentTime),
        durationText: duration ? formatTime(duration) : "--:--",
        remainingTimeText: formatRemaining(currentTime, duration),
        progressPercent
      });
    });
    audioContext.onEnded(() => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      const duration = Number(audioContext.duration) || this.trackDuration || 0;

      this.setData({
        isPlaying: false,
        currentTimeText: duration ? formatTime(duration) : "0:00",
        remainingTimeText: duration ? "−0:00" : "−--:--",
        progressPercent: duration ? 100 : 0
      });
    });
    audioContext.onError((error) => {
      if (this.audioContext !== audioContext || this.isUnloaded) {
        return;
      }
      console.error("article audio error:", error);
      this.destroyAudioContext();
      this.setAudioStatus("error", { notify: true });
    });

    audioContext.src = source;
  },

  togglePlayback() {
    if (this.data.audioStatus === "error") {
      this.retryAudio();
      return;
    }

    if (this.data.audioStatus !== "ready" || !this.audioContext) {
      wx.showToast({
        title:
          AUDIO_STATUS_TITLES[this.data.audioStatus] || "音频暂时不可播放",
        icon: "none"
      });
      return;
    }

    if (this.data.isPlaying) {
      this.audioContext.pause();
    } else {
      this.audioContext.play();
    }
  },

  retryAudio() {
    if (this.audioManifestPending) {
      wx.showToast({
        title: AUDIO_STATUS_TITLES.loading,
        icon: "none"
      });
      return;
    }

    if (!this.data.content) {
      return;
    }

    wx.showToast({
      title: "正在重新加载音频",
      icon: "none"
    });
    this.loadAudioManifest(this.data.content.id);
  },

  seekBy(deltaSeconds) {
    if (this.data.audioStatus === "error") {
      this.retryAudio();
      return;
    }

    if (this.data.audioStatus !== "ready" || !this.audioContext) {
      wx.showToast({
        title:
          AUDIO_STATUS_TITLES[this.data.audioStatus] || "音频暂时不可播放",
        icon: "none"
      });
      return;
    }

    const currentTime = Number(this.audioContext.currentTime) || 0;
    const duration =
      Number(this.audioContext.duration) || Number(this.trackDuration) || 0;

    if (!duration) {
      wx.showToast({
        title: "音频时长正在读取",
        icon: "none"
      });
      return;
    }

    const targetTime = Math.min(
      duration,
      Math.max(0, currentTime + deltaSeconds)
    );
    this.audioContext.seek(targetTime);
    this.setData({
      currentTimeText: formatTime(targetTime),
      remainingTimeText: formatRemaining(targetTime, duration),
      progressPercent: Math.min(100, Math.max(0, (targetTime / duration) * 100))
    });
  },

  seekBackward() {
    if (Array.isArray(this.tracks) && this.tracks.length > 1) {
      this.switchTrack(-1);
      return;
    }

    this.seekBy(-SEEK_STEP_SECONDS);
  },

  seekForward() {
    if (Array.isArray(this.tracks) && this.tracks.length > 1) {
      this.switchTrack(1);
      return;
    }

    this.seekBy(SEEK_STEP_SECONDS);
  },

  switchTrack(direction) {
    if (this.data.audioStatus !== "ready" || !Array.isArray(this.tracks)) {
      this.seekBy(direction * SEEK_STEP_SECONDS);
      return;
    }

    const nextIndex = this.currentTrackIndex + direction;

    if (nextIndex < 0 || nextIndex >= this.tracks.length) {
      wx.showToast({
        title: direction < 0 ? "已经是第一轨" : "已经是最后一轨",
        icon: "none"
      });
      return;
    }

    this.activateTrack(nextIndex, {
      notify: true,
      autoplay: this.data.isPlaying
    });
  },

  cyclePlaybackRate() {
    const currentIndex = PLAYBACK_RATES.indexOf(this.data.playbackRate);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];

    if (this.audioContext) {
      this.audioContext.playbackRate = nextRate;
    }

    this.setData({
      playbackRate: nextRate,
      playbackRateText: `${nextRate}倍`
    });

    wx.showToast({
      title: `已切换为${nextRate}倍速`,
      icon: "none"
    });
  },

  destroyAudioContext() {
    if (this.audioContext) {
      const audioContext = this.audioContext;
      this.audioContext = null;
      audioContext.destroy();
    }
  },

  onUnload() {
    this.isUnloaded = true;
    if (this.returnTimer) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
    this.destroyAudioContext();
  }
});
