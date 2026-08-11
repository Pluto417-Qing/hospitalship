const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const MAX_TRACKS = 20;
const CONTENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createMemberSessionId(openid) {
  return sha256(JSON.stringify(["member-session", openid])).slice(0, 32);
}

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizePositiveNumber(value, maximum) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  return Math.min(number, maximum);
}

function isCloudFileID(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.length > 1024
  ) {
    return false;
  }

  const pathSeparatorIndex = value.indexOf("/", "cloud://".length);
  const cloudPath = pathSeparatorIndex >= 0
    ? value.slice(pathSeparatorIndex + 1)
    : "";

  return (
    cloudPath.startsWith("published/audio/") &&
    cloudPath.length > "published/audio/".length &&
    !cloudPath.split("/").includes("..")
  );
}

function createSafeTrack(track) {
  const id = normalizeText(track && track._id, 128);

  if (!id || !track || !isCloudFileID(track.fileID)) {
    return null;
  }

  const trackNo = Math.max(
    1,
    Math.min(1000, Math.floor(normalizePositiveNumber(track.trackNo, 1000) || 1))
  );
  const mimeType = normalizeText(track.mimeType, 64);

  if (!mimeType.startsWith("audio/")) {
    return null;
  }

  return {
    id,
    title: normalizeText(track.title, 120),
    narrator: normalizeText(track.narrator, 80),
    language: normalizeText(track.language, 32),
    mimeType,
    durationSeconds: normalizePositiveNumber(track.durationSeconds, 24 * 60 * 60),
    trackNo,
    fileID: track.fileID
  };
}

function isSafeTemporaryURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("https://") ||
    /[\s\\\u0000-\u001f]/.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch (error) {
    return false;
  }
}

async function createSignedTracks(tracks) {
  if (typeof cloud.getTempFileURL !== "function") {
    return [];
  }

  const result = await cloud.getTempFileURL({
    fileList: tracks.map((track) => track.fileID)
  });
  const signedFiles = result && Array.isArray(result.fileList)
    ? result.fileList
    : [];
  const signedByFileID = new Map();

  signedFiles.forEach((file) => {
    if (
      file &&
      typeof file.fileID === "string" &&
      (file.status === undefined || Number(file.status) === 0) &&
      isSafeTemporaryURL(file.tempFileURL)
    ) {
      signedByFileID.set(file.fileID, file.tempFileURL);
    }
  });

  return tracks
    .map((track) => {
      const src = signedByFileID.get(track.fileID);

      if (!src) {
        return null;
      }

      return {
        id: track.id,
        title: track.title,
        narrator: track.narrator,
        language: track.language,
        mimeType: track.mimeType,
        durationSeconds: track.durationSeconds,
        trackNo: track.trackNo,
        src
      };
    })
    .filter(Boolean);
}

function isDocumentNotFoundError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "-502005" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc|collection).*(?:not found|does not exist)/i.test(message) ||
    /(?:文档|集合).*不存在/.test(message)
  );
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value.toMillis === "function") {
    return toTimestamp(value.toMillis());
  }

  if (typeof value.toDate === "function") {
    return toTimestamp(value.toDate());
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function readDocument(documentReference) {
  try {
    const result = await documentReference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isActiveUser(user) {
  return Boolean(user) &&
    (!user.registerStatus || user.registerStatus === "active");
}

async function getActiveMember(openid) {
  if (!openid) {
    return null;
  }

  const sessionId = createMemberSessionId(openid);
  const session = await readDocument(
    db.collection("memberSessions").doc(sessionId)
  );
  const active = Boolean(session && session.status === "active");
  const userId = normalizeText(session && session.userId, 128);

  if (
    !active ||
    !userId ||
    toTimestamp(session.expiresAt) <= Date.now() ||
    (session.openid && session.openid !== openid)
  ) {
    return null;
  }

  const user = await readDocument(db.collection("users").doc(userId));

  if (
    !isActiveUser(user) ||
    normalizeText(user._id, 128) !== userId ||
    normalizeText(user.openid, 128) !== openid
  ) {
    return null;
  }

  return user;
}

async function readContent(contentId) {
  try {
    const result = await db.collection("contents").doc(contentId).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

exports.main = async (event = {}) => {
  const contentId = normalizeText(event.contentId, 64);

  if (!contentId || !CONTENT_ID_PATTERN.test(contentId)) {
    return {
      success: false,
      code: "INVALID_CONTENT_ID",
      message: "内容编号无效"
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(event, "url") ||
    Object.prototype.hasOwnProperty.call(event, "src") ||
    Object.prototype.hasOwnProperty.call(event, "fileID")
  ) {
    return {
      success: false,
      code: "CLIENT_AUDIO_SOURCE_NOT_ALLOWED",
      message: "音频资源必须由服务端提供"
    };
  }

  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);
    const member = await getActiveMember(openid);

    if (!member) {
      return {
        success: false,
        code: "MEMBER_LOGIN_REQUIRED",
        message: "请先登录少年会员后收听"
      };
    }

    const content = await readContent(contentId);

    if (!content || content.status !== "published") {
      return {
        success: true,
        available: false,
        manifest: null
      };
    }

    if (content._id !== contentId || content.contentId !== contentId) {
      return {
        success: false,
        code: "CONTENT_SCHEMA_INVALID",
        message: "内容主键配置无效"
      };
    }

    const contentRevision = normalizeText(content.currentRevision, 128);
    const audioRevision = normalizeText(content.audioRevision, 128);
    const expectedTrackCount = Number(content.publishedAudioTrackCount);

    if (
      content.audioStatus !== "published" ||
      !contentRevision ||
      !Number.isInteger(expectedTrackCount) ||
      expectedTrackCount < 1 ||
      expectedTrackCount > MAX_TRACKS
    ) {
      return {
        success: true,
        available: false,
        manifest: null
      };
    }

    const trackFilter = {
      contentId,
      contentRevision: content.currentRevision,
      status: "published"
    };
    if (audioRevision) {
      trackFilter.audioRevision = audioRevision;
    }

    const trackResult = await db
      .collection("audioTracks")
      .where(trackFilter)
      .orderBy("trackNo", "asc")
      .orderBy("_id", "asc")
      .limit(MAX_TRACKS)
      .get();

    if (!trackResult || !Array.isArray(trackResult.data)) {
      throw new Error("audioTracks returned an invalid result");
    }

    const tracks = trackResult.data
      .map(createSafeTrack)
      .filter(Boolean)
      .sort(
        (left, right) =>
          left.trackNo - right.trackNo || left.id.localeCompare(right.id)
      );

    if (tracks.length !== expectedTrackCount) {
      return {
        success: true,
        available: false,
        manifest: null
      };
    }

    const signedTracks = await createSignedTracks(tracks);

    if (signedTracks.length !== expectedTrackCount) {
      return {
        success: false,
        code: "AUDIO_URL_CREATE_FAILED",
        message: "音频播放地址生成失败，请稍后重试"
      };
    }

    return {
      success: true,
      available: true,
      manifest: {
        contentId,
        contentRevision,
        audioRevision,
        title: normalizeText(content.title, 120),
        accessPolicy: {
          text: "member",
          audio: "member"
        },
        tracks: signedTracks
      }
    };
  } catch (error) {
    console.error("getAudioManifest error:", error);

    return {
      success: false,
      code: "AUDIO_MANIFEST_READ_FAILED",
      message: "音频信息读取失败"
    };
  }
};
