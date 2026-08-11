const path = require("path");
const { CLOUD_ENV_ID } = require(path.resolve(
  __dirname,
  "../miniprogram/config/cloud"
));

const targetEnvironment = String(process.argv[2] || "").trim();
const validEnvironmentPattern = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

if (!validEnvironmentPattern.test(CLOUD_ENV_ID)) {
  console.error("miniprogram/config/cloud.js 中的 CLOUD_ENV_ID 格式无效");
  process.exitCode = 1;
} else if (targetEnvironment && targetEnvironment !== CLOUD_ENV_ID) {
  console.error(
    `部署目标 ${targetEnvironment} 与小程序云环境 ${CLOUD_ENV_ID} 不一致`
  );
  process.exitCode = 1;
} else {
  console.log(
    targetEnvironment
      ? `部署目标检查通过：${targetEnvironment}`
      : `小程序云环境配置检查通过：${CLOUD_ENV_ID}`
  );
}
