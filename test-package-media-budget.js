const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const miniprogramRoot = path.join(projectRoot, "miniprogram");
const referenceRoots = [
  miniprogramRoot,
  path.join(projectRoot, "seed-data")
];

// Keep this list aligned with the media extensions checked by WeChat DevTools.
const MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".amr",
  ".ape",
  ".caf",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".wav",
  ".webp",
  ".wma"
]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".scss",
  ".ts",
  ".txt",
  ".wxml",
  ".wxss",
  ".xml",
  ".yaml",
  ".yml"
]);
const MEDIA_LIMIT_BYTES = 200 * 1024;
const FORBIDDEN_HOME_JPG_PATTERN = /\/images\/home\/[^"'`\s?#)]+\.jpe?g(?=$|["'`\s?#)])/gi;

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];

  const files = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  entries.forEach((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  });
  return files;
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} B`;
}

function collectMediaFiles() {
  return walkFiles(miniprogramRoot)
    .filter((filePath) => MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .map((filePath) => ({
      bytes: fs.statSync(filePath).size,
      path: relativePath(filePath)
    }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
}

function collectForbiddenReferences() {
  const references = [];

  referenceRoots.forEach((root) => {
    walkFiles(root)
      .filter((filePath) => TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .forEach((filePath) => {
        const source = fs.readFileSync(filePath, "utf8");
        source.split(/\r?\n/).forEach((line, index) => {
          const matches = line.match(FORBIDDEN_HOME_JPG_PATTERN) || [];
          matches.forEach((reference) => {
            references.push({
              line: index + 1,
              path: relativePath(filePath),
              reference
            });
          });
        });
      });
  });

  return references.sort(
    (left, right) => left.path.localeCompare(right.path) || left.line - right.line
  );
}

function printMediaReport(mediaFiles, totalBytes) {
  console.log(
    `Client media budget: ${formatBytes(totalBytes)}; required: < ${formatBytes(MEDIA_LIMIT_BYTES)}`
  );
  mediaFiles.forEach((file) => {
    console.log(`  ${formatBytes(file.bytes).padStart(13)}  ${file.path}`);
  });

  if (totalBytes < MEDIA_LIMIT_BYTES) {
    console.log(`  Headroom: ${formatBytes(MEDIA_LIMIT_BYTES - totalBytes - 1)}`);
  } else {
    console.log(`  Over budget by: ${formatBytes(totalBytes - MEDIA_LIMIT_BYTES + 1)}`);
  }
}

function printReferenceReport(references) {
  if (references.length === 0) {
    console.log("Forbidden /images/home/*.jpg references: none");
    return;
  }

  console.log(`Forbidden /images/home/*.jpg references: ${references.length}`);
  references.forEach((item) => {
    console.log(`  ${item.path}:${item.line}  ${item.reference}`);
  });
}

function run() {
  assert.ok(fs.existsSync(miniprogramRoot), "miniprogram root must exist");

  const mediaFiles = collectMediaFiles();
  const totalBytes = mediaFiles.reduce((sum, file) => sum + file.bytes, 0);
  const forbiddenReferences = collectForbiddenReferences();
  const failures = [];

  printMediaReport(mediaFiles, totalBytes);
  printReferenceReport(forbiddenReferences);

  try {
    assert.ok(
      totalBytes < MEDIA_LIMIT_BYTES,
      `client image/audio aggregate must be strictly below ${MEDIA_LIMIT_BYTES} bytes; got ${totalBytes}`
    );
  } catch (error) {
    failures.push(error.message);
  }

  try {
    assert.strictEqual(
      forbiddenReferences.length,
      0,
      "forbidden /images/home/*.jpg textual references must be migrated out of miniprogram and seed-data"
    );
  } catch (error) {
    failures.push(error.message);
  }

  assert.strictEqual(failures.length, 0, failures.join("\n"));
  console.log("Package media budget checks passed.");
}

run();
