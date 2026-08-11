"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { GLOBAL_MAX_BYTES } = require("./constants");
const { BrokerError } = require("./errors");

class MultipartReceiver {
  constructor(options = {}) {
    this.tempDirectory = options.tempDirectory;
    this.busboyFactory = options.busboyFactory || require("busboy");
    this.fs = options.fs || fs;
  }

  async ensureTempDirectory() {
    await this.fs.promises.mkdir(this.tempDirectory, {
      recursive: true,
      mode: 0o700
    });
  }

  async receive(request, reservation, attemptId) {
    await this.ensureTempDirectory();
    if (!/^[a-f0-9]{32}$/.test(attemptId)) {
      throw new Error("invalid internal upload attempt id");
    }

    const tempPath = path.join(this.tempDirectory, `${attemptId}.upload`);
    const relative = path.relative(this.tempDirectory, tempPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("temporary upload path escaped its directory");
    }

    let busboy;
    try {
      busboy = this.busboyFactory({
        headers: request.headers,
        limits: {
          fileSize: Math.min(reservation.declaredBytes + 1, GLOBAL_MAX_BYTES + 1),
          files: 1,
          fields: 0,
          // Busboy emits partsLimit when the configured count is reached.
          // Use one spare slot, while files/fields handlers still reject any
          // second part, so a valid single-file body does not trip the limit.
          parts: 2,
          headerPairs: 64
        }
      });
    } catch (error) {
      throw new BrokerError(
        "INVALID_MULTIPART_REQUEST",
        400,
        "上传请求不是有效的 multipart/form-data",
        { cause: error, markUploadFailed: true }
      );
    }

    let fileSeen = false;
    let receivedBytes = 0;
    let digest = null;
    let filePipeline = null;
    let firstError = null;

    const rememberError = (error) => {
      if (!firstError) {
        firstError = error;
      }
    };

    busboy.on("file", (fieldName, file, info) => {
      if (fileSeen || fieldName !== "file") {
        rememberError(
          new BrokerError(
            "UNEXPECTED_FILE_PART",
            400,
            "上传请求只能包含一个名为 file 的文件",
            { markUploadFailed: true }
          )
        );
        file.resume();
        return;
      }

      fileSeen = true;
      const suppliedMime = String(info && info.mimeType || "").toLowerCase();
      if (suppliedMime !== reservation.mimeType) {
        rememberError(
          new BrokerError(
            "UPLOAD_MIME_MISMATCH",
            415,
            "上传文件的 MIME 类型与预约不一致",
            { markUploadFailed: true }
          )
        );
      }

      const hasher = crypto.createHash("sha256");
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          receivedBytes += chunk.length;
          hasher.update(chunk);
          callback(null, chunk);
        }
      });
      const output = this.fs.createWriteStream(tempPath, {
        flags: "wx",
        mode: 0o600
      });

      file.once("limit", () => {
        rememberError(
          new BrokerError(
            "UPLOAD_TOO_LARGE",
            413,
            "上传文件超过预约大小或 500MB 上限",
            { markUploadFailed: true }
          )
        );
      });

      filePipeline = pipeline(file, meter, output)
        .then(() => {
          digest = hasher.digest("hex");
        })
        .catch((error) => {
          rememberError(
            new BrokerError(
              "UPLOAD_STREAM_FAILED",
              400,
              "上传数据流中断",
              { cause: error, markUploadFailed: true }
            )
          );
        });
    });

    busboy.on("field", () => {
      rememberError(
        new BrokerError(
          "UNEXPECTED_FORM_FIELD",
          400,
          "上传请求不得包含额外表单字段",
          { markUploadFailed: true }
        )
      );
    });
    busboy.on("filesLimit", () => {
      rememberError(
        new BrokerError(
          "TOO_MANY_FILES",
          400,
          "一次上传只能包含一个文件",
          { markUploadFailed: true }
        )
      );
    });
    busboy.on("fieldsLimit", () => {
      rememberError(
        new BrokerError(
          "UNEXPECTED_FORM_FIELD",
          400,
          "上传请求不得包含额外表单字段",
          { markUploadFailed: true }
        )
      );
    });
    busboy.on("partsLimit", () => {
      rememberError(
        new BrokerError(
          "TOO_MANY_PARTS",
          400,
          "上传请求包含过多数据段",
          { markUploadFailed: true }
        )
      );
    });

    const parsing = new Promise((resolve, reject) => {
      busboy.once("error", (error) => {
        reject(
          new BrokerError(
            "INVALID_MULTIPART_REQUEST",
            400,
            "上传请求不是有效的 multipart/form-data",
            { cause: error, markUploadFailed: true }
          )
        );
      });
      busboy.once("close", resolve);
      request.once("aborted", () => {
        reject(
          new BrokerError(
            "UPLOAD_STREAM_ABORTED",
            400,
            "上传连接已中断",
            { markUploadFailed: true }
          )
        );
      });
      request.once("error", (error) => {
        reject(
          new BrokerError(
            "UPLOAD_STREAM_FAILED",
            400,
            "上传数据流中断",
            { cause: error, markUploadFailed: true }
          )
        );
      });
    });

    request.pipe(busboy);

    try {
      await parsing;
      if (filePipeline) {
        await filePipeline;
      }

      if (firstError) {
        throw firstError;
      }
      if (!fileSeen || !filePipeline || !digest) {
        throw new BrokerError(
          "UPLOAD_FILE_MISSING",
          400,
          "上传请求缺少 file 文件",
          { markUploadFailed: true }
        );
      }
      if (receivedBytes !== reservation.declaredBytes) {
        throw new BrokerError(
          "UPLOAD_SIZE_MISMATCH",
          422,
          "实际文件大小与预约声明不一致",
          { markUploadFailed: true }
        );
      }

      return {
        path: tempPath,
        actualBytes: receivedBytes,
        sha256: digest,
        createReadStream: () => this.fs.createReadStream(tempPath),
        cleanup: () => this.fs.promises.rm(tempPath, { force: true })
      };
    } catch (error) {
      await this.fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { MultipartReceiver };
