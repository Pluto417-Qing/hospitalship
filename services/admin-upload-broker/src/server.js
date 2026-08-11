"use strict";

const http = require("http");
const { createApp } = require("./app");
const { UploadBroker } = require("./broker");
const { createCloudBaseResources } = require("./cloudbase");
const { loadConfig } = require("./config");
const { MultipartReceiver } = require("./multipart-receiver");
const { CloudBaseReservationStore } = require("./reservation-store");

function start() {
  const config = loadConfig();
  const resources = createCloudBaseResources(config);
  const store = new CloudBaseReservationStore(resources.database);
  const receiver = new MultipartReceiver({ tempDirectory: config.tempDirectory });
  const broker = new UploadBroker({ store, storage: resources.storage, receiver });
  const app = createApp({
    broker,
    maximumRequestBytes: config.maximumRequestBytes
  });
  const server = http.createServer(app);

  server.headersTimeout = 15 * 1000;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 5 * 1000;
  server.maxHeadersCount = 64;

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`admin upload broker listening on port ${config.port}`);
  });

  const shutDown = (signal) => {
    console.log(`received ${signal}; stopping admin upload broker`);
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGTERM", () => shutDown("SIGTERM"));
  process.once("SIGINT", () => shutDown("SIGINT"));

  return server;
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error("admin upload broker failed to start", {
      message: error && error.message
    });
    process.exitCode = 1;
  }
}

module.exports = { start };
