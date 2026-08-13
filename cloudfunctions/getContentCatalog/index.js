const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 10000;
const STATE_QUERY_BATCH_SIZE = 10;
const MAX_PUBLISHED_AUDIO_TRACKS = 20;
const VALID_VIEWS = new Set(["book", "summary"]);
const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOME_ASSET_MANIFEST_ID = "app-home-v1";
const HOME_ASSET_REVISION = "app-home-v1";
const HOME_ASSET_CLOUD_PREFIX = "published/images/app-home/v1";
const HOME_ASSET_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "banner02", fileName: "banner-02.jpg" }),
  Object.freeze({ key: "banner03", fileName: "banner-03.jpg" }),
  Object.freeze({ key: "banner04", fileName: "banner-04.jpg" }),
  Object.freeze({ key: "banner05", fileName: "banner-05.jpg" }),
  Object.freeze({ key: "banner06", fileName: "banner-06.jpg" }),
  Object.freeze({ key: "banner07", fileName: "banner-07.jpg" }),
  Object.freeze({ key: "banner08", fileName: "banner-08.jpg" }),
  Object.freeze({ key: "banner09", fileName: "banner-09.jpg" }),
  Object.freeze({ key: "banner10", fileName: "banner-10.jpg" }),
  Object.freeze({ key: "banner11", fileName: "banner-11.jpg" }),
  Object.freeze({ key: "banner12", fileName: "banner-12.jpg" }),
  Object.freeze({ key: "banner13", fileName: "banner-13.jpg" }),
  Object.freeze({ key: "banner14", fileName: "banner-14.jpg" }),
  Object.freeze({ key: "bookRehab", fileName: "book-rehab.jpg" }),
  Object.freeze({ key: "bookSummary", fileName: "book-summary.jpg" })
]);
const HOME_ASSET_KEYS = new Set(
  HOME_ASSET_DEFINITIONS.map((asset) => asset.key)
);

function normalizeText(value, maximum = 0) {
  const result = typeof value === "string" ? value.trim() : "";
  return maximum > 0 ? result.slice(0, maximum) : result;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, number));
}

function createSessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function isDocumentNotFoundError(error) {
  const code = String(error && (error.errCode || error.code || ""));
  const message = String(error && (error.errMsg || error.message || ""));

  return (
    code === "-502004" ||
    code === "DATABASE_DOCUMENT_NOT_FOUND" ||
    code === "DOCUMENT_NOT_FOUND" ||
    /(?:document|doc).*(?:not found|does not exist)/i.test(message) ||
    /文档.*不存在/.test(message)
  );
}

async function readDocumentOrNull(collectionName, documentId) {
  try {
    const result = await db.collection(collectionName).doc(documentId).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function getTimeValue(value) {
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

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isActiveUser(user) {
  return Boolean(
    user && (!user.registerStatus || user.registerStatus === "active")
  );
}

async function getOptionalMember(openid) {
  if (!openid) {
    return null;
  }

  const session = await readDocumentOrNull(
    "memberSessions",
    createSessionId(openid)
  );
  const expiresAt = getTimeValue(session && session.expiresAt);

  if (
    !session ||
    session.status !== "active" ||
    !normalizeText(session.userId, 128) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return null;
  }

  const userId = normalizeText(session.userId, 128);
  const user = await readDocumentOrNull("users", userId);

  if (
    !isActiveUser(user) ||
    normalizeText(user._id, 128) !== userId ||
    normalizeText(user.openid, 128) !== openid
  ) {
    return null;
  }

  return {
    userId,
    memberId: normalizeText(session.memberId || user.memberId, 128)
  };
}

function getPublishedAudioTrackCount(value) {
  const count = Number(value);

  return Number.isInteger(count) && count > 0 && count <= MAX_PUBLISHED_AUDIO_TRACKS
    ? count
    : 0;
}

function normalizePublishedImageFileId(...values) {
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      !value.startsWith("cloud://") ||
      /[\s\\\u0000-\u001f]/.test(value) ||
      value.includes("..")
    ) {
      continue;
    }

    const pathSeparatorIndex = value.indexOf("/", "cloud://".length);
    const environment = pathSeparatorIndex >= 0
      ? value.slice("cloud://".length, pathSeparatorIndex)
      : "";
    const cloudPath = pathSeparatorIndex >= 0
      ? value.slice(pathSeparatorIndex + 1)
      : "";

    if (
      environment &&
      cloudPath.startsWith("published/images/") &&
      cloudPath.length > "published/images/".length
    ) {
      return value;
    }
  }

  return "";
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

async function createSignedPublishedImageURLs(fileIDs) {
  const requested = Array.from(new Set(fileIDs.filter(Boolean)));
  const requestedSet = new Set(requested);
  const signedByFileID = new Map();

  if (requested.length === 0 || typeof cloud.getTempFileURL !== "function") {
    return signedByFileID;
  }

  try {
    for (let offset = 0; offset < requested.length; offset += 50) {
      const batch = requested.slice(offset, offset + 50);
      const result = await cloud.getTempFileURL({ fileList: batch });
      const signedFiles = result && Array.isArray(result.fileList)
        ? result.fileList
        : [];

      signedFiles.forEach((file) => {
        if (
          file &&
          requestedSet.has(file.fileID) &&
          (file.status === undefined || Number(file.status) === 0) &&
          isSafeTemporaryURL(file.tempFileURL)
        ) {
          signedByFileID.set(file.fileID, file.tempFileURL);
        }
      });
    }
  } catch (error) {
    console.warn("getContentCatalog cover URL signing failed");
    return new Map();
  }

  return signedByFileID;
}

function getHomeAssetCloudPath(asset) {
  return `${HOME_ASSET_CLOUD_PREFIX}/${asset.fileName}`;
}

function normalizeExactHomeAssetFileID(value, asset) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("cloud://") ||
    /[\s\\\u0000-\u001f]/.test(value) ||
    value.includes("..")
  ) {
    return "";
  }

  const pathSeparatorIndex = value.indexOf("/", "cloud://".length);
  const environment = pathSeparatorIndex >= 0
    ? value.slice("cloud://".length, pathSeparatorIndex)
    : "";
  const cloudPath = pathSeparatorIndex >= 0
    ? value.slice(pathSeparatorIndex + 1)
    : "";

  return environment && cloudPath === getHomeAssetCloudPath(asset)
    ? value
    : "";
}

function createHomeAssetSchemaError() {
  const error = new Error("The fixed home asset manifest is invalid");
  error.code = "HOME_ASSET_MANIFEST_INVALID";
  return error;
}

async function readHomeAssets() {
  const manifest = await readDocumentOrNull(
    "publicAssets",
    HOME_ASSET_MANIFEST_ID
  );

  if (!manifest) {
    return {
      success: false,
      code: "HOME_ASSETS_NOT_READY",
      message: "Home assets have not been initialized",
      source: "cloud",
      revision: HOME_ASSET_REVISION,
      assets: {}
    };
  }

  if (
    manifest.manifestId !== HOME_ASSET_MANIFEST_ID ||
    manifest.revision !== HOME_ASSET_REVISION ||
    Number(manifest.schemaVersion) !== 1 ||
    Number(manifest.assetCount) !== HOME_ASSET_DEFINITIONS.length ||
    !manifest.assets ||
    typeof manifest.assets !== "object" ||
    Array.isArray(manifest.assets) ||
    Object.keys(manifest.assets).some((key) => !HOME_ASSET_KEYS.has(key))
  ) {
    throw createHomeAssetSchemaError();
  }

  const fileIDByKey = new Map();
  for (const definition of HOME_ASSET_DEFINITIONS) {
    if (!Object.prototype.hasOwnProperty.call(manifest.assets, definition.key)) {
      continue;
    }

    const entry = manifest.assets[definition.key];
    const fileID = normalizeExactHomeAssetFileID(
      entry && entry.fileID,
      definition
    );
    if (!fileID) {
      throw createHomeAssetSchemaError();
    }

    fileIDByKey.set(definition.key, fileID);
  }

  const signedByFileID = await createSignedPublishedImageURLs(
    Array.from(fileIDByKey.values())
  );
  const assets = {};
  const missingAssetKeys = [];

  HOME_ASSET_DEFINITIONS.forEach((definition) => {
    const fileID = fileIDByKey.get(definition.key);
    const temporaryURL = fileID ? signedByFileID.get(fileID) : "";

    if (temporaryURL) {
      assets[definition.key] = temporaryURL;
    } else {
      missingAssetKeys.push(definition.key);
    }
  });

  return {
    success: true,
    source: "cloud",
    revision: HOME_ASSET_REVISION,
    complete: missingAssetKeys.length === 0,
    assets,
    missingAssetKeys
  };
}

function normalizeViews(document) {
  if (!Array.isArray(document.catalogViews)) {
    return [];
  }

  return Array.from(
    new Set(
      document.catalogViews
        .map((item) => normalizeText(item, 32).toLowerCase())
        .filter((item) => VALID_VIEWS.has(item))
    )
  );
}

function normalizeCatalogView(event) {
  const input = event && typeof event === "object" ? event : {};
  const candidate = normalizeText(
    input.view || input.catalogView || input.kind,
    32
  ).toLowerCase() || "summary";

  return VALID_VIEWS.has(candidate) ? candidate : "summary";
}

function normalizeContent(document, requestedView) {
  const id = normalizeText(document && document._id, 64);
  const contentId = normalizeText(document && document.contentId, 64);
  const catalogViews = normalizeViews(document || {});
  const title = normalizeText(document && document.title, 120);
  const currentRevision = normalizeText(
    document && document.currentRevision,
    128
  );

  if (
    !id ||
    contentId !== id ||
    !title ||
    !currentRevision ||
    !catalogViews.includes(requestedView)
  ) {
    const error = new Error("contents document schema mismatch");
    error.code = "CONTENT_SCHEMA_INVALID";
    throw error;
  }

  return {
    id,
    bookId: STABLE_ID_PATTERN.test(normalizeText(document.bookId, 64))
      ? normalizeText(document.bookId, 64)
      : "",
    currentRevision,
    title,
    subtitle: normalizeText(document.subtitle, 240),
    sourceLabel: normalizeText(document.sourceLabel, 120),
    status: "published",
    accessPolicy: {
      text: "member",
      audio: "member"
    },
    publishedAt: document.publishedAt || null,
    audioAvailable:
      document.audioStatus === "published" &&
      Boolean(normalizeText(document.currentRevision, 128)) &&
      getPublishedAudioTrackCount(document.publishedAudioTrackCount) > 0,
    cover: normalizePublishedImageFileId(
      document.coverUrl,
      document.coverFileId,
      document.cover
    ),
    sortOrder: Number.isFinite(Number(document.sortOrder))
      ? Number(document.sortOrder)
      : 0,
    catalogViews
  };
}

async function readPublishedContents(view, offset, limit) {
  const result = await db
    .collection("contents")
    .where({
      status: "published",
      catalogViews: db.command.all([view])
    })
    .orderBy("sortOrder", "asc")
    .orderBy("_id", "asc")
    .skip(offset)
    .limit(limit + 1)
    .get();

  if (!result || !Array.isArray(result.data)) {
    throw new Error("contents returned an invalid result");
  }

  const hasMore = result.data.length > limit;
  const page = result.data.slice(0, limit);

  return {
    hasMore,
    items: page.map((document) => normalizeContent(document, view))
  };
}

async function readStates(userId, contents) {
  if (!userId || contents.length === 0) {
    return new Map();
  }

  const contentIds = contents.map((item) => item.id);
  const revisions = new Map(
    contents.map((item) => [item.id, item.currentRevision])
  );

  const batches = [];

  for (let offset = 0; offset < contentIds.length; offset += STATE_QUERY_BATCH_SIZE) {
    batches.push(contentIds.slice(offset, offset + STATE_QUERY_BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map((batch) =>
      db
        .collection("readingStates")
        .where({
          userId,
          contentId: db.command.in(batch)
        })
        .limit(batch.length)
        .get()
    )
  );
  const documents = [];

  results.forEach((result) => {
    if (!result || !Array.isArray(result.data)) {
      throw new Error("readingStates returned an invalid result");
    }

    documents.push(...result.data);
  });

  return new Map(
    documents
      .map((item) => {
        const contentId = normalizeText(item && item.contentId, 64);
        const viewed = Boolean(
          contentId &&
            normalizeText(item && item.contentRevision, 128) ===
              revisions.get(contentId)
        );

        return [
          contentId,
          {
            viewed,
            readAt: viewed
              ? item.lastReadAt || item.revisionFirstReadAt || item.firstReadAt || null
              : null
          }
        ];
      })
      .filter(([contentId]) => Boolean(contentId))
  );
}

exports.main = async (event = {}) => {
  const action = normalizeText(event && event.action, 32);

  if (action === "homeAssets") {
    try {
      return await readHomeAssets();
    } catch (error) {
      console.error("getContentCatalog homeAssets error:", error);

      return {
        success: false,
        code: error && error.code === "HOME_ASSET_MANIFEST_INVALID"
          ? "HOME_ASSET_MANIFEST_INVALID"
          : "HOME_ASSET_READ_FAILED",
        message: "Home assets could not be read",
        source: "cloud",
        revision: HOME_ASSET_REVISION,
        assets: {}
      };
    }
  }

  const view = normalizeCatalogView(event);
  const limit = normalizeInteger(
    event.limit,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  const offset = normalizeInteger(event.offset, 0, 0, MAX_OFFSET);

  try {
    const wxContext = cloud.getWXContext();
    const openid = normalizeText(wxContext && wxContext.OPENID, 128);
    const page = await readPublishedContents(view, offset, limit);
    const [member, signedCovers] = await Promise.all([
      getOptionalMember(openid),
      createSignedPublishedImageURLs(page.items.map((item) => item.cover))
    ]);
    const states = await readStates(
      member ? member.userId : "",
      page.items
    );
    const items = page.items.map((item) => {
      const state = states.get(item.id);

      return {
        ...item,
        cover: signedCovers.get(item.cover) || "",
        viewed: Boolean(state && state.viewed),
        readAt: state ? state.readAt : null
      };
    });
    const candidateNextOffset = offset + items.length;
    const nextOffset =
      page.hasMore &&
      candidateNextOffset > offset &&
      candidateNextOffset <= MAX_OFFSET
        ? candidateNextOffset
        : null;

    return {
      success: true,
      view,
      source: "cloud",
      items,
      offset,
      limit,
      hasMore: nextOffset !== null,
      nextOffset
    };
  } catch (error) {
    console.error("getContentCatalog error:", error);

    return {
      success: false,
      code: error && error.code === "CONTENT_SCHEMA_INVALID"
        ? "CONTENT_SCHEMA_INVALID"
        : "CONTENT_CATALOG_READ_FAILED",
      message: "内容目录读取失败",
      view,
      source: "cloud",
      items: [],
      offset,
      limit,
      hasMore: false,
      nextOffset: null
    };
  }
};
