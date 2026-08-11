"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfig } = require("../src/config");

test("uses the explicit CloudBase environment ID first", () => {
  const config = loadConfig({
    CLOUDBASE_ENV_ID: "explicit-env",
    TCB_ENV_ID: "tcb-env",
    ENV_ID: "generic-env",
    CLOUDBASE_USE_RUNTIME_IDENTITY: "true"
  });

  assert.equal(config.cloudBaseEnvId, "explicit-env");
  assert.equal(config.useRuntimeIdentity, true);
});

test("accepts CloudBase Run environment ID aliases", () => {
  const fromTcb = loadConfig({
    TCB_ENV_ID: "tcb-env",
    CLOUDBASE_USE_RUNTIME_IDENTITY: "true"
  });
  const fromGeneric = loadConfig({
    ENV_ID: "generic-env",
    CLOUDBASE_USE_RUNTIME_IDENTITY: "true"
  });

  assert.equal(fromTcb.cloudBaseEnvId, "tcb-env");
  assert.equal(fromGeneric.cloudBaseEnvId, "generic-env");
});
