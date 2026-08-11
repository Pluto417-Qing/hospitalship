"use strict";

const MIB = 1024 * 1024;

const GLOBAL_MAX_BYTES = 500 * MIB;
const TICKET_MAX_AGE_MS = 15 * 60 * 1000;
// A claim is never silently re-used. This lease only bounds how long an
// interrupted broker process may leave the reservation in `uploading` before
// a same-ticket retry can quarantine its deterministic storage targets.
const UPLOAD_LEASE_MAX_AGE_MS = 10 * 60 * 1000;
const UPLOAD_ATTEMPT_MAX = 3;
const MULTIPART_OVERHEAD_BYTES = 1 * MIB;
const KNOWN_CHAPTER_SOURCE_PDF_SHA256S = Object.freeze([
  "d443f7dcbbecedd15e4e12fd6dba8bd37d3568401fdb24597a2d7ffabeebc07f"
]);

const ASSET_POLICIES = Object.freeze({
  manuscript: Object.freeze({
    maximumBytes: 100 * MIB,
    formats: Object.freeze({
      ".docx": Object.freeze([
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ])
    })
  }),
  audio: Object.freeze({
    maximumBytes: 500 * MIB,
    formats: Object.freeze({
      ".mp3": Object.freeze(["audio/mpeg", "audio/mp3"]),
      ".m4a": Object.freeze(["audio/mp4", "audio/x-m4a"]),
      ".wav": Object.freeze(["audio/wav", "audio/x-wav", "audio/wave"])
    })
  }),
  "special-topic": Object.freeze({
    maximumBytes: 100 * MIB,
    formats: Object.freeze({
      ".docx": Object.freeze([
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ])
    })
  }),
  "full-book-pdf": Object.freeze({
    maximumBytes: 50 * MIB,
    formats: Object.freeze({
      ".pdf": Object.freeze(["application/pdf"])
    })
  }),
  "topic-image": Object.freeze({
    maximumBytes: 20 * MIB,
    formats: Object.freeze({
      ".jpg": Object.freeze(["image/jpeg"]),
      ".jpeg": Object.freeze(["image/jpeg"]),
      ".png": Object.freeze(["image/png"]),
      ".webp": Object.freeze(["image/webp"])
    })
  })
});

module.exports = {
  ASSET_POLICIES,
  GLOBAL_MAX_BYTES,
  KNOWN_CHAPTER_SOURCE_PDF_SHA256S,
  MULTIPART_OVERHEAD_BYTES,
  TICKET_MAX_AGE_MS,
  UPLOAD_ATTEMPT_MAX,
  UPLOAD_LEASE_MAX_AGE_MS
};
