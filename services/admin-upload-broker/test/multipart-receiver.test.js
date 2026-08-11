"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { MultipartReceiver } = require("../src/multipart-receiver");

function multipartRequest(body, boundary) {
  const request = new PassThrough();
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length)
  };
  process.nextTick(() => request.end(body));
  return request;
}

function multipartBody(boundary, content, options = {}) {
  const fieldName = options.fieldName || "file";
  const mimeType = options.mimeType || "application/pdf";
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="ignored.pdf"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

test("streams one exact file to a private temporary file", async (context) => {
  const tempDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "admin-upload-broker-test-")
  );
  context.after(() => fs.promises.rm(tempDirectory, { recursive: true, force: true }));
  const receiver = new MultipartReceiver({ tempDirectory });
  const content = Buffer.from("%PDF-mock-content");
  const boundary = "unit-test-boundary";
  const body = multipartBody(boundary, content);
  const result = await receiver.receive(
    multipartRequest(body, boundary),
    { declaredBytes: content.length, mimeType: "application/pdf" },
    "4".repeat(32)
  );

  assert.equal(result.actualBytes, content.length);
  assert.equal(
    result.sha256,
    crypto.createHash("sha256").update(content).digest("hex")
  );
  assert.deepEqual(await fs.promises.readFile(result.path), content);
  await result.cleanup();
  assert.equal(fs.existsSync(result.path), false);
});

test("rejects bytes or MIME that differ from the reservation", async (context) => {
  const tempDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "admin-upload-broker-test-")
  );
  context.after(() => fs.promises.rm(tempDirectory, { recursive: true, force: true }));
  const receiver = new MultipartReceiver({ tempDirectory });
  const boundary = "unit-test-boundary-two";
  const content = Buffer.from("five!");

  await assert.rejects(
    receiver.receive(
      multipartRequest(multipartBody(boundary, content), boundary),
      { declaredBytes: 4, mimeType: "application/pdf" },
      "5".repeat(32)
    ),
    (error) => ["UPLOAD_TOO_LARGE", "UPLOAD_SIZE_MISMATCH"].includes(error.code)
  );

  const anotherBoundary = "unit-test-boundary-three";
  await assert.rejects(
    receiver.receive(
      multipartRequest(
        multipartBody(anotherBoundary, Buffer.from("four"), {
          mimeType: "image/png"
        }),
        anotherBoundary
      ),
      { declaredBytes: 4, mimeType: "application/pdf" },
      "6".repeat(32)
    ),
    (error) => error.code === "UPLOAD_MIME_MISMATCH"
  );
});
