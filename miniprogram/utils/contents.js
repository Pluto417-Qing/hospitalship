// The mini-program bundle intentionally contains catalog metadata only.
// Reviewed manuscripts live in the protected contents collection and are
// returned by getContentDetail after server-side access checks.
const contentList = [
  {
    id: "esophageal-cancer-story",
    title: "食管癌的故事",
    subtitle: "爱与真 · 中国医院船",
    sourceLabel: "testarticle 待上传审定示例",
    department: "胸外科",
    accent: "#d95a3a",
    available: false,
    status: "draft",
    accessPolicy: {
      text: "member",
      audio: "member"
    },
    audioAvailable: false,
    audio: {
      available: false,
      title: "食管癌的故事（谢林彤配音）",
      narrator: "谢林彤",
      durationMs: 443925
    },
    sections: []
  },
  {
    id: "rehab-concepts",
    title: "康复概念及理念",
    subtitle: "正式书稿待录入",
    accent: "#78b8e5",
    available: false,
    status: "draft",
    sections: []
  },
  {
    id: "young-readers-notes",
    title: "中国少年读后感",
    subtitle: "优秀读后感展示待接入",
    accent: "#43ad91",
    available: false,
    status: "draft",
    sections: []
  }
];

const bookContentList = [
  {
    id: "book-preface",
    title: "本书编委会致辞",
    subtitle: "",
    accent: "#aa99c5",
    available: false,
    status: "draft",
    sections: []
  },
  {
    id: "rehab-concepts",
    title: "康复概念及理念",
    subtitle: "",
    accent: "#7ebdee",
    available: false,
    status: "draft",
    sections: []
  },
  {
    id: "esophageal-cancer-story",
    title: "康复科病人故事",
    subtitle: "testarticle 待上传审定示例",
    accent: "#f99f87",
    available: false,
    status: "draft",
    accessPolicy: {
      text: "member",
      audio: "member"
    },
    audioAvailable: false,
    sections: []
  },
  {
    id: "young-readers-notes",
    title: "中国少年读后感",
    subtitle: "",
    accent: "#41ac8e",
    available: false,
    status: "draft",
    sections: []
  }
];

function getLocalCatalog(view) {
  return view === "summary" ? contentList : bookContentList;
}

function getLocalContentById(contentId) {
  return (
    contentList.find((item) => item.id === contentId) ||
    bookContentList.find((item) => item.id === contentId) ||
    null
  );
}

function getContentById(contentId) {
  return contentList.find((item) => item.id === contentId) || null;
}

function normalizeAccessPolicy(value) {
  const source = value && typeof value === "object" ? value : {};

  return {
    text: source.text === "public" ? "public" : "member",
    audio: "member"
  };
}

function normalizeRemoteContent(remoteContent) {
  if (!remoteContent || typeof remoteContent !== "object") {
    return null;
  }

  const id = String(remoteContent.id || remoteContent.contentId || "").trim();

  if (!id) {
    return null;
  }

  const localContent = getLocalContentById(id) || {};
  const status =
    remoteContent.status === "published" || remoteContent.available === true
      ? "published"
      : "draft";
  const remoteAudio =
    remoteContent.audio && typeof remoteContent.audio === "object"
      ? remoteContent.audio
      : {};
  const audioAvailable = Boolean(
    remoteContent.audioAvailable || remoteAudio.available
  );

  return {
    ...localContent,
    ...remoteContent,
    id,
    bookId: typeof remoteContent.bookId === "string"
      ? remoteContent.bookId.trim().slice(0, 64)
      : "",
    currentRevision: typeof remoteContent.currentRevision === "string"
      ? remoteContent.currentRevision.trim().slice(0, 128)
      : "",
    cover: remoteContent.cover || remoteContent.coverUrl || "",
    available: status === "published",
    status,
    accessPolicy: normalizeAccessPolicy(remoteContent.accessPolicy),
    sections: Array.isArray(remoteContent.sections)
      ? remoteContent.sections
      : [],
    audioAvailable,
    audio: {
      ...((localContent.audio && typeof localContent.audio === "object")
        ? localContent.audio
        : {}),
      ...remoteAudio,
      available: audioAvailable
    }
  };
}

function mergeContentCatalog(remoteItems, localItems) {
  const normalizedItems = remoteItems
    .map(normalizeRemoteContent)
    .filter(Boolean);
  const remoteMap = new Map(normalizedItems.map((item) => [item.id, item]));
  const localIds = new Set(localItems.map((item) => item.id));
  const mergedItems = localItems.map((item) =>
    remoteMap.has(item.id)
      ? remoteMap.get(item.id)
      : {
          ...item,
          available: false,
          status: "draft",
          audioAvailable: false
        }
  );

  normalizedItems.forEach((item) => {
    if (!localIds.has(item.id)) {
      mergedItems.push(item);
    }
  });

  return mergedItems;
}

async function loadContentCatalogResult(
  view = "book",
  { offset = 0, limit = 50 } = {}
) {
  const normalizedView = view === "summary" ? "summary" : "book";
  const localItems = getLocalCatalog(normalizedView);
  const normalizedOffset = Number.isInteger(Number(offset))
    ? Math.max(0, Math.min(10000, Number(offset)))
    : 0;
  const normalizedLimit = Number.isInteger(Number(limit))
    ? Math.max(1, Math.min(50, Number(limit)))
    : 50;
  const closedItems = normalizedOffset === 0
    ? mergeContentCatalog([], localItems)
    : [];

  if (
    typeof wx === "undefined" ||
    !wx.cloud ||
    typeof wx.cloud.callFunction !== "function"
  ) {
    return {
      success: false,
      items: closedItems,
      hasMore: false,
      nextOffset: null
    };
  }

  try {
    const response = await wx.cloud.callFunction({
      name: "getContentCatalog",
      data: {
        view: normalizedView,
        offset: normalizedOffset,
        limit: normalizedLimit
      }
    });
    const result = response.result || {};

    if (!result.success || !Array.isArray(result.items)) {
      return {
        success: false,
        items: closedItems,
        hasMore: false,
        nextOffset: null
      };
    }

    const nextOffset = Number(result.nextOffset);
    const hasMore = Boolean(
      result.hasMore &&
      Number.isInteger(nextOffset) &&
      nextOffset > normalizedOffset &&
      nextOffset <= 10000
    );
    const items = normalizedOffset === 0
      ? mergeContentCatalog(result.items, localItems)
      : result.items.map(normalizeRemoteContent).filter(Boolean);

    return {
      success: true,
      items,
      hasMore,
      nextOffset: hasMore ? nextOffset : null
    };
  } catch (error) {
    console.error("loadContentCatalog failed closed:", error);
    return {
      success: false,
      items: closedItems,
      hasMore: false,
      nextOffset: null
    };
  }
}

async function loadContentCatalog(view = "book") {
  const result = await loadContentCatalogResult(view);
  return result.items;
}

function createDetailFailure(contentId, code, message) {
  return {
    success: false,
    code: String(code || "CONTENT_READ_FAILED"),
    message: String(message || "内容读取失败"),
    contentId
  };
}

async function loadContentDetailResult(contentId, mode = "text") {
  const normalizedId = String(contentId || "").trim();
  const normalizedMode = mode === "audio" ? "audio" : "text";

  if (!normalizedId) {
    return createDetailFailure("", "INVALID_CONTENT_ID", "内容编号无效");
  }

  if (
    typeof wx === "undefined" ||
    !wx.cloud ||
    typeof wx.cloud.callFunction !== "function"
  ) {
    return createDetailFailure(
      normalizedId,
      "CLOUD_UNAVAILABLE",
      "云服务不可用"
    );
  }

  try {
    const response = await wx.cloud.callFunction({
      name: "getContentDetail",
      data: {
        contentId: normalizedId,
        mode: normalizedMode
      }
    });
    const result = response.result || {};

    if (!result.success) {
      return createDetailFailure(
        normalizedId,
        result.code,
        result.message
      );
    }

    const content = normalizeRemoteContent(result.content);

    if (!content || !content.available) {
      return createDetailFailure(
        normalizedId,
        "CONTENT_INVALID",
        "内容数据不完整"
      );
    }

    return {
      success: true,
      content
    };
  } catch (error) {
    console.error("loadContentDetail failed closed:", error);
    return createDetailFailure(
      normalizedId,
      "CONTENT_REQUEST_FAILED",
      "内容读取失败，请检查网络后重试"
    );
  }
}

async function loadContentDetail(contentId, mode = "text") {
  const result = await loadContentDetailResult(contentId, mode);

  if (result.success) {
    return result.content;
  }

  return {
    id: String(contentId || ""),
    available: false,
    errorCode: result.code,
    errorMessage: result.message,
    requiresMembership: [
      "MEMBER_REQUIRED",
      "MEMBER_LOGIN_REQUIRED",
      "MEMBER_SESSION_EXPIRED",
      "ACCOUNT_INACTIVE"
    ].includes(result.code)
  };
}

async function markContentRead(contentId, contentRevision) {
  if (
    !contentId ||
    typeof wx === "undefined" ||
    !wx.cloud ||
    typeof wx.cloud.callFunction !== "function"
  ) {
    return {
      success: false,
      code: "READ_STATE_UNAVAILABLE",
      message: "云端阅读状态暂不可用"
    };
  }

  try {
    const response = await wx.cloud.callFunction({
      name: "markContentRead",
      data: { contentId, contentRevision }
    });

    const result = response.result || {};

    return {
      success: Boolean(result.success),
      code: String(result.code || ""),
      message: String(result.message || ""),
      state: result.state || null
    };
  } catch (error) {
    console.error("markContentRead failed:", error);
    return {
      success: false,
      code: "READ_STATE_UNAVAILABLE",
      message: "阅读状态同步失败，请检查网络后重试"
    };
  }
}

module.exports = {
  bookContentList,
  contentList,
  getContentById,
  loadContentCatalog,
  loadContentCatalogResult,
  loadContentDetail,
  loadContentDetailResult,
  markContentRead
};
