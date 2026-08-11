"use strict";

const os = require("os");
const path = require("path");
const { GLOBAL_MAX_BYTES, MULTIPART_OVERHEAD_BYTES } = require("./constants");

function integerEnvironment(environment, name, fallback, minimum, maximum) {
  if (!environment[name]) {
    return fallback;
  }

  const value = Number(environment[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }

  return value;
}

function loadConfig(environment = process.env) {
  const cloudBaseEnvId = String(
    environment.CLOUDBASE_ENV_ID ||
    environment.TCB_ENV_ID ||
    environment.ENV_ID ||
    ""
  ).trim();
  const cloudBaseSecretId = String(environment.CLOUDBASE_SECRET_ID || "").trim();
  const cloudBaseSecretKey = String(environment.CLOUDBASE_SECRET_KEY || "").trim();
  const useRuntimeIdentity = environment.CLOUDBASE_USE_RUNTIME_IDENTITY === "true";

  if (!cloudBaseEnvId) {
    throw new Error("CLOUDBASE_ENV_ID is required");
  }
  if (Boolean(cloudBaseSecretId) !== Boolean(cloudBaseSecretKey)) {
    throw new Error("CLOUDBASE_SECRET_ID and CLOUDBASE_SECRET_KEY must be set together");
  }
  if (!useRuntimeIdentity && !cloudBaseSecretId) {
    throw new Error(
      "set CloudBase credentials or CLOUDBASE_USE_RUNTIME_IDENTITY=true"
    );
  }

  const tempDirectory = path.resolve(
    String(
      environment.UPLOAD_TEMP_DIR ||
      path.join(os.tmpdir(), "admin-upload-broker")
    )
  );

  return {
    port: integerEnvironment(environment, "PORT", 8080, 1, 65535),
    requestTimeoutMs: integerEnvironment(
      environment,
      "REQUEST_TIMEOUT_MS",
      30 * 60 * 1000,
      60 * 1000,
      2 * 60 * 60 * 1000
    ),
    maximumRequestBytes: GLOBAL_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
    cloudBaseEnvId,
    cloudBaseSecretId,
    cloudBaseSecretKey,
    useRuntimeIdentity,
    tempDirectory
  };
}

module.exports = { loadConfig };
