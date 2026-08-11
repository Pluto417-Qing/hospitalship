const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cloudfunctionsRoot = path.join(root, "cloudfunctions");
const securityRoot = path.join(root, "cloud-security");
const uploadBrokerRoot = path.join(root, "services", "admin-upload-broker");
const APPROVED_SDK_VERSION = "4.0.2";
const APPROVED_UPLOAD_BROKER_DEPENDENCIES = Object.freeze({
  "@cloudbase/node-sdk": "3.18.3",
  busboy: "1.6.0"
});
const errors = [];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(root, filePath)} 无法读取：${error.message}`);
    return {};
  }
}

const functionNames = fs
  .readdirSync(cloudfunctionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const invokeRules = readJson(
  path.join(securityRoot, "function-invoke-rules.json")
);
const storageRules = readJson(
  path.join(securityRoot, "storage-access-rules.json")
);

const creatorOnlyStorageRule =
  "resource.openid == auth.openid || resource.openid == auth.uid";
if (
  storageRules.read !== creatorOnlyStorageRule ||
  storageRules.write !== creatorOnlyStorageRule
) {
  errors.push(
    "云存储必须使用“仅创建者可读写”基线；它只承载管理员直传回退，直传文件仍须经云函数状态机确认且不得直接发布"
  );
}

if (!invokeRules["*"] || invokeRules["*"].invoke !== false) {
  errors.push("云函数调用规则必须以通配符默认拒绝");
}

functionNames.forEach((name) => {
  const rule = invokeRules[name];

  if (!rule || rule.invoke !== "auth != null") {
    errors.push(`云函数 ${name} 缺少已登录用户调用规则`);
  }
});

Object.keys(invokeRules)
  .filter((name) => name !== "*" && !functionNames.includes(name))
  .forEach((name) => errors.push(`调用规则包含不存在的云函数：${name}`));

const databaseAccess = readJson(
  path.join(securityRoot, "database-access.manifest.json")
);
const databaseIndexes = readJson(
  path.join(securityRoot, "database-indexes.manifest.json")
);
const requiredCollections = new Set([
  "adminAccounts",
  "adminUploads",
  "audioTracks",
  "books",
  "contents",
  "familyInvites",
  "familyInviteCounters",
  "familyRelationCounters",
  "familyRelations",
  "guardianPhoneClaims",
  "legalDocuments",
  "memberMessages",
  "moderationTerms",
  "readingStates",
  "records",
  "rewardLedger",
  "specialTopics",
  "specialTopicEntries",
  "users",
  "zhiEntries"
]);

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") {
      return [];
    }

    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

functionNames.forEach((name) => {
  const sources = listJavaScriptFiles(path.join(cloudfunctionsRoot, name))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  const pattern = /collection\s*\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g;
  let match = pattern.exec(sources);

  while (match) {
    requiredCollections.add(match[1]);
    match = pattern.exec(sources);
  }
});

if (databaseAccess.defaultAccess !== "ADMINONLY") {
  errors.push("数据库访问清单必须默认 ADMINONLY");
}

requiredCollections.forEach((name) => {
  if (
    !databaseAccess.collections ||
    databaseAccess.collections[name] !== "ADMINONLY"
  ) {
    errors.push(`业务集合 ${name} 未声明为 ADMINONLY`);
  }
});

Object.keys(databaseAccess.collections || {})
  .filter((name) => !requiredCollections.has(name))
  .forEach((name) => errors.push(`数据库访问清单包含未知集合：${name}`));

const requiredIndexCollections = new Set([
  "adminAccounts",
  "adminUploads",
  "audioTracks",
  "bookChapters",
  "contents",
  "familyInvites",
  "familyRelations",
  "memberMessages",
  "quizQuestions",
  "readingStates",
  "records",
  "rewardLedger",
  "specialTopicEntries",
  "specialTopics",
  "specialTopicUnlocks",
  "users",
  "zhiEntries"
]);
const allowedIndexModes = new Set(["asc", "desc"]);
const indexedCollections = new Set();
const indexSignatures = new Set();

if (
  databaseIndexes.deploymentMode !== "manual-console-checklist" ||
  databaseIndexes.autoDeployable !== false
) {
  errors.push(
    "数据库索引清单必须明确标记为人工控制台核对，且不得声称可以自动部署"
  );
}

if (!Array.isArray(databaseIndexes.indexes)) {
  errors.push("数据库索引清单缺少 indexes 数组");
} else {
  databaseIndexes.indexes.forEach((index, position) => {
    const label = `数据库索引清单第 ${position + 1} 项`;
    const collection = String((index && index.collection) || "");
    const fields = index && index.fields;

    if (!requiredCollections.has(collection)) {
      errors.push(`${label} 引用了未知集合：${collection || "(空)"}`);
    } else {
      indexedCollections.add(collection);
    }

    if (!Array.isArray(fields) || fields.length < 2) {
      errors.push(`${label} 必须声明至少两个复合索引字段`);
      return;
    }

    const fieldNames = new Set();
    const signatureFields = [];

    fields.forEach((field) => {
      const fieldName = String((field && field.field) || "");
      const mode = String((field && field.mode) || "");

      if (!fieldName || fieldNames.has(fieldName)) {
        errors.push(`${label} 包含空字段或重复字段：${fieldName || "(空)"}`);
      }

      if (!allowedIndexModes.has(mode)) {
        errors.push(`${label} 的字段 ${fieldName || "(空)"} 使用了未知模式 ${mode}`);
      }

      fieldNames.add(fieldName);
      signatureFields.push(`${fieldName}:${mode}`);
    });

    const signature = `${collection}|${signatureFields.join("|")}`;

    if (indexSignatures.has(signature)) {
      errors.push(`${label} 与另一项重复：${signature}`);
    }

    indexSignatures.add(signature);
  });
}

requiredIndexCollections.forEach((collection) => {
  if (!indexedCollections.has(collection)) {
    errors.push(`数据库索引人工清单缺少关键集合：${collection}`);
  }
});

functionNames.forEach((name) => {
  const packagePath = path.join(cloudfunctionsRoot, name, "package.json");
  const packageLockPath = path.join(
    cloudfunctionsRoot,
    name,
    "package-lock.json"
  );
  const packageConfig = readJson(packagePath);
  const packageLock = readJson(packageLockPath);
  const sdkVersion =
    packageConfig.dependencies && packageConfig.dependencies["wx-server-sdk"];

  if (sdkVersion !== APPROVED_SDK_VERSION) {
    errors.push(
      `${name}/package.json 的 wx-server-sdk 必须为批准版本 ` +
        APPROVED_SDK_VERSION
    );
  }

  const rootLockPackage = packageLock.packages && packageLock.packages[""];
  const lockedSdk =
    packageLock.packages &&
    packageLock.packages["node_modules/wx-server-sdk"];
  const rootDependencies =
    (rootLockPackage && rootLockPackage.dependencies) || {};

  if (
    packageLock.lockfileVersion !== 3 ||
    Object.keys(rootDependencies).length !== 1 ||
    rootDependencies["wx-server-sdk"] !== APPROVED_SDK_VERSION ||
    !lockedSdk ||
    lockedSdk.version !== APPROVED_SDK_VERSION ||
    typeof lockedSdk.integrity !== "string" ||
    !lockedSdk.integrity.startsWith("sha512-")
  ) {
    errors.push(`${name}/package-lock.json 不完整或包含未批准的直接依赖`);
  }
});

const brokerPackage = readJson(path.join(uploadBrokerRoot, "package.json"));
const brokerLock = readJson(path.join(uploadBrokerRoot, "package-lock.json"));
const brokerDependencies = brokerPackage.dependencies || {};
const brokerRootLock = brokerLock.packages && brokerLock.packages[""];
const brokerLockedDependencies = brokerRootLock && brokerRootLock.dependencies;

if (
  JSON.stringify(brokerDependencies) !==
    JSON.stringify(APPROVED_UPLOAD_BROKER_DEPENDENCIES) ||
  JSON.stringify(brokerLockedDependencies || {}) !==
    JSON.stringify(APPROVED_UPLOAD_BROKER_DEPENDENCIES)
) {
  errors.push("上传代理只能使用已批准并精确锁定的 CloudBase SDK 与 busboy 直接依赖");
}

if (brokerLock.lockfileVersion !== 3) {
  errors.push("上传代理 package-lock.json 必须使用 lockfileVersion 3");
}

Object.entries(APPROVED_UPLOAD_BROKER_DEPENDENCIES).forEach(
  ([dependency, version]) => {
    const locked =
      brokerLock.packages && brokerLock.packages[`node_modules/${dependency}`];

    if (
      !locked ||
      locked.version !== version ||
      typeof locked.integrity !== "string" ||
      !locked.integrity.startsWith("sha512-")
    ) {
      errors.push(`上传代理依赖 ${dependency}@${version} 缺少完整锁定信息`);
    }
  }
);

const brokerDockerfile = fs.readFileSync(
  path.join(uploadBrokerRoot, "Dockerfile"),
  "utf8"
);

if (!/\bUSER\s+10001:10001\b/.test(brokerDockerfile)) {
  errors.push("上传代理容器必须使用非 root 用户运行");
}

if (!/\bnpm ci --omit=dev --ignore-scripts\b/.test(brokerDockerfile)) {
  errors.push("上传代理容器必须使用锁文件和 npm ci 安装生产依赖");
}

if (errors.length) {
  console.error("云安全配置检查失败：");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    `云安全配置检查通过：${functionNames.length} 个云函数、` +
      `${requiredCollections.size} 个业务集合均为默认拒绝，` +
      `${indexSignatures.size} 项复合索引已列入人工部署清单。`
  );
}
