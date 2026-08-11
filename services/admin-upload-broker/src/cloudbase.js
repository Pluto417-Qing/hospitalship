"use strict";

function createCloudBaseResources(config, sdkModule) {
  const tcb = sdkModule || require("@cloudbase/node-sdk");
  const initOptions = { env: config.cloudBaseEnvId };

  if (config.cloudBaseSecretId && config.cloudBaseSecretKey) {
    initOptions.secretId = config.cloudBaseSecretId;
    initOptions.secretKey = config.cloudBaseSecretKey;
  }

  const app = tcb.init(initOptions);
  return {
    database: app.database(),
    storage: {
      uploadFile: (options) => app.uploadFile(options),
      deleteFile: (options) => app.deleteFile(options)
    }
  };
}

module.exports = { createCloudBaseResources };
