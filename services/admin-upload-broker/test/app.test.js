"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createApp } = require("../src/app");
const { BrokerError } = require("../src/errors");
const {
  TEST_TICKET,
  TEST_UPLOAD_ID,
  responseStub
} = require("./helpers");

function makeRequest(overrides = {}) {
  const request = new PassThrough();
  request.method = "POST";
  request.url = `/v1/admin/uploads/${TEST_UPLOAD_ID}`;
  request.headers = {
    authorization: `Bearer ${TEST_TICKET}`,
    "content-type": "multipart/form-data; boundary=mock-boundary"
  };
  return Object.assign(request, overrides);
}

async function invoke(app, request) {
  const response = responseStub();
  const ended = new Promise((resolve) => response.once("ended", resolve));
  await app(request, response);
  await ended;
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body)
  };
}

test("exposes the wx.uploadFile-compatible HTTPS route contract", async () => {
  const calls = [];
  const app = createApp({
    maximumRequestBytes: 501 * 1024 * 1024,
    broker: {
      async process(value) {
        calls.push(value);
        return {
          success: true,
          uploadId: value.uploadId,
          published: false
        };
      }
    },
    logger: { error() {} }
  });
  const result = await invoke(app, makeRequest());

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.body.published, false);
  assert.equal(Object.hasOwn(result.body, "fileID"), false);
  assert.equal(Object.hasOwn(result.body, "cloudPath"), false);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls[0].ticket, TEST_TICKET);
  assert.equal(calls[0].uploadId, TEST_UPLOAD_ID);
});

test("rejects a missing ticket before invoking the broker", async () => {
  let called = false;
  const app = createApp({
    maximumRequestBytes: 501 * 1024 * 1024,
    broker: {
      async process() {
        called = true;
      }
    },
    logger: { error() {} }
  });
  const request = makeRequest();
  delete request.headers.authorization;
  const result = await invoke(app, request);

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "INVALID_UPLOAD_TICKET");
  assert.equal(called, false);
});

test("does not leak internal errors to the client", async () => {
  const app = createApp({
    maximumRequestBytes: 501 * 1024 * 1024,
    broker: {
      async process() {
        throw new Error("mock-secret-key-should-never-leak");
      }
    },
    logger: { error() {} }
  });
  const result = await invoke(app, makeRequest());

  assert.equal(result.statusCode, 500);
  assert.equal(result.body.code, "UPLOAD_BROKER_FAILED");
  assert.equal(JSON.stringify(result.body).includes("mock-secret-key"), false);
});

test("preserves safe public error codes", async () => {
  const app = createApp({
    maximumRequestBytes: 501 * 1024 * 1024,
    broker: {
      async process() {
        throw new BrokerError("UPLOAD_TICKET_EXPIRED", 401, "expired");
      }
    },
    logger: { error() {} }
  });
  const result = await invoke(app, makeRequest());

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, "UPLOAD_TICKET_EXPIRED");
});
