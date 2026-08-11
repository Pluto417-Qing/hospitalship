"use strict";

const { BrokerError, asBrokerError } = require("./errors");
const { UPLOAD_ID_PATTERN, readBearerTicket } = require("./security");

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function readContentLength(request, maximumRequestBytes) {
  const rawValue = request.headers["content-length"];
  if (rawValue === undefined) {
    return null;
  }

  if (!/^[0-9]{1,12}$/.test(String(rawValue))) {
    throw new BrokerError("INVALID_CONTENT_LENGTH", 400, "Content-Length 无效");
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrokerError("INVALID_CONTENT_LENGTH", 400, "Content-Length 无效");
  }
  if (value > maximumRequestBytes) {
    throw new BrokerError("REQUEST_TOO_LARGE", 413, "上传请求超过 500MB 上限");
  }

  return value;
}

function createApp(options) {
  const broker = options.broker;
  const maximumRequestBytes = options.maximumRequestBytes;
  const logger = options.logger || console;

  return async function app(request, response) {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const match = /^\/v1\/admin\/uploads\/([a-f0-9]{32})$/.exec(
      String(request.url || "").split("?", 1)[0]
    );
    if (request.method !== "POST" || !match || !UPLOAD_ID_PATTERN.test(match[1])) {
      sendJson(response, 404, {
        success: false,
        code: "NOT_FOUND",
        message: "接口不存在"
      });
      return;
    }

    try {
      const contentType = String(request.headers["content-type"] || "");
      if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
        throw new BrokerError(
          "INVALID_CONTENT_TYPE",
          415,
          "请使用 multipart/form-data 上传文件"
        );
      }

      const ticket = readBearerTicket(request.headers.authorization);
      const contentLength = readContentLength(request, maximumRequestBytes);
      const result = await broker.process({
        uploadId: match[1],
        ticket,
        request,
        contentLength
      });
      sendJson(response, 201, result);
    } catch (error) {
      const brokerError = asBrokerError(error);
      if (request.readable && !request.readableEnded) {
        request.resume();
      }
      if (brokerError.status >= 500) {
        logger.error("admin upload request failed", {
          uploadId: match[1],
          code: brokerError.code
        });
      }
      sendJson(response, brokerError.status, {
        success: false,
        code: brokerError.code,
        message: brokerError.publicMessage
      });
    }
  };
}

module.exports = { createApp, readContentLength, sendJson };
