"use strict";

class BrokerError extends Error {
  constructor(code, status, publicMessage, options = {}) {
    super(publicMessage, options);
    this.name = "BrokerError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    this.markUploadFailed = Boolean(options.markUploadFailed);
  }
}

function asBrokerError(error) {
  if (error instanceof BrokerError) {
    return error;
  }

  return new BrokerError(
    "UPLOAD_BROKER_FAILED",
    500,
    "上传服务暂时不可用",
    { cause: error, markUploadFailed: true }
  );
}

module.exports = { BrokerError, asBrokerError };
