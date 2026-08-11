const assert = require("assert");
const vm = require("vm");
const {
  chunkDocxImageFiles,
  createCancellationController,
  transferDocxImages
} = require("./miniprogram/pages/adminUploads/docxImageTransfer");

function imageBytes(seed) {
  return new Uint8Array([seed, seed + 1, seed + 2, seed + 3]).buffer;
}

function createFileSystem(entries) {
  const temporaryFiles = new Map();
  const reads = [];
  const writes = [];
  const unlinks = [];

  return {
    temporaryFiles,
    reads,
    writes,
    unlinks,
    readZipEntry(options) {
      const output = {};
      options.entries.forEach((entry) => {
        reads.push(entry.path);
        if (Object.prototype.hasOwnProperty.call(entries, entry.path)) {
          output[entry.path] = {
            data: entries[entry.path],
            errMsg: "readZipEntry:ok"
          };
        } else {
          output[entry.path] = {
            errMsg: "readZipEntry:fail no such entry"
          };
        }
      });
      options.success({ entries: output });
    },
    writeFile(options) {
      writes.push(options.filePath);
      temporaryFiles.set(options.filePath, options.data);
      options.success({ errMsg: "writeFile:ok" });
    },
    stat(options) {
      if (!temporaryFiles.has(options.path)) {
        options.fail({ errMsg: "stat:fail no such file" });
        return;
      }
      const data = temporaryFiles.get(options.path);
      options.success({
        stats: {
          size: Number(data && data.byteLength) || 0
        }
      });
    },
    unlink(options) {
      unlinks.push(options.filePath);
      temporaryFiles.delete(options.filePath);
      options.success({ errMsg: "unlink:ok" });
    }
  };
}

function createRuntime(fileSystem, behavior) {
  const uploads = [];
  let activeUploads = 0;
  let maximumActiveUploads = 0;

  const runtime = {
    env: {
      USER_DATA_PATH: "wxfile://user-data"
    },
    getFileSystemManager() {
      return fileSystem;
    },
    cloud: {
      uploadFile(options) {
        const record = {
          cloudPath: options.cloudPath,
          filePath: options.filePath,
          aborted: false,
          settled: false
        };
        uploads.push(record);
        activeUploads += 1;
        maximumActiveUploads = Math.max(
          maximumActiveUploads,
          activeUploads
        );

        const finish = (handler, result) => {
          if (record.settled) {
            return;
          }
          record.settled = true;
          activeUploads -= 1;
          handler(result);
        };
        const task = {
          abort() {
            record.aborted = true;
            finish(options.fail, { errMsg: "uploadFile:fail abort" });
          }
        };

        behavior({
          fail(error) {
            finish(options.fail, error);
          },
          record,
          succeed(result) {
            finish(options.success, result);
          },
          task
        });
        return task;
      }
    }
  };

  return {
    runtime,
    uploads,
    getMaximumActiveUploads() {
      return maximumActiveUploads;
    }
  };
}

function cloudFileID(cloudPath) {
  return `cloud://test-environment/${cloudPath}`;
}

async function testSuccessfulBoundedTransfer() {
  const fileSystem = createFileSystem({
    "word/media/cover.png": imageBytes(1),
    "word/media/photo.jpg": imageBytes(5)
  });
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) => {
      setTimeout(
        () => succeed({ fileID: cloudFileID(record.cloudPath) }),
        5
      );
    }
  );
  const progressEvents = [];
  const result = await transferDocxImages({
    filePath: "wxfile://book.docx",
    images: [
      {
        order: 1,
        packagePath: "word/media/cover.png",
        extension: ".png"
      },
      {
        imageOrder: 2,
        packagePath: "word/media/photo.jpg",
        extension: ".jpg"
      }
    ],
    uploadPlan: [
      {
        order: 2,
        packagePath: "word/media/photo.jpg",
        extension: ".jpg",
        cloudPath: "protected/contents/article-1/assets/upload1/embedded/0002.jpg"
      },
      {
        imageOrder: 1,
        packagePath: "word/media/cover.png",
        extension: ".png",
        cloudPath: "protected/contents/article-1/assets/upload1/embedded/0001.png"
      }
    ],
    wx: runtimeState.runtime,
    fileSystem,
    concurrency: 20,
    onProgress(event) {
      progressEvents.push(event);
    }
  });

  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(
    result.files.map((file) => file.imageOrder),
    [1, 2]
  );
  assert.ok(
    result.files.every(
      (file) => !Object.prototype.hasOwnProperty.call(file, "order")
    )
  );
  assert.strictEqual(
    result.files[0].fileID,
    cloudFileID(
      "protected/contents/article-1/assets/upload1/embedded/0001.png"
    )
  );
  assert.ok(runtimeState.getMaximumActiveUploads() <= 4);
  assert.ok(runtimeState.getMaximumActiveUploads() >= 2);
  assert.strictEqual(fileSystem.temporaryFiles.size, 0);
  assert.strictEqual(fileSystem.writes.length, 2);
  assert.strictEqual(fileSystem.unlinks.length, 2);
  assert.strictEqual(result.confirmationBatches.length, 1);
  assert.deepStrictEqual(
    chunkDocxImageFiles(Array.from({ length: 41 }, (_, index) => index))
      .map((batch) => batch.length),
    [20, 20, 1]
  );
  assert.strictEqual(progressEvents[0].phase, "start");
  assert.strictEqual(
    progressEvents[progressEvents.length - 1].phase,
    "complete"
  );
  assert.strictEqual(
    progressEvents[progressEvents.length - 1].percent,
    100
  );
}

async function testRepeatedReferenceUploadsOnce() {
  const fileSystem = createFileSystem({
    "word/media/again.png": imageBytes(10)
  });
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) => {
      setImmediate(() =>
        succeed({ fileID: cloudFileID(record.cloudPath) })
      );
    }
  );
  const repeated = {
    order: 1,
    packagePath: "word/media/again.png",
    extension: ".png"
  };
  const result = await transferDocxImages({
    filePath: "wxfile://repeated.docx",
    images: [repeated, { ...repeated }],
    uploadPlan: [
      {
        imageOrder: 1,
        packagePath: repeated.packagePath,
        extension: repeated.extension,
        cloudPath: "protected/special-topics/topic-1/assets/upload2/embedded/0001.png"
      }
    ],
    wx: runtimeState.runtime,
    fileSystem
  });

  assert.strictEqual(result.files.length, 1);
  assert.deepStrictEqual(fileSystem.reads, ["word/media/again.png"]);
  assert.strictEqual(runtimeState.uploads.length, 1);
  assert.strictEqual(fileSystem.unlinks.length, 1);
}

async function testPlanMismatchRejectedBeforeReading() {
  const fileSystem = createFileSystem({
    "word/media/cover.png": imageBytes(20)
  });
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) =>
      succeed({ fileID: cloudFileID(record.cloudPath) })
  );

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://mismatch.docx",
        images: [
          {
            order: 1,
            packagePath: "word/media/cover.png",
            extension: ".png"
          }
        ],
        uploadPlan: [
          {
            imageOrder: 1,
            packagePath: "word/media/other.png",
            extension: ".png",
            cloudPath: "protected/contents/article-1/assets/upload3/embedded/0001.png"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) => error && error.code === "DOCX_IMAGE_PLAN_MISMATCH"
  );
  assert.strictEqual(fileSystem.reads.length, 0);
  assert.strictEqual(fileSystem.writes.length, 0);
  assert.strictEqual(runtimeState.uploads.length, 0);
}

async function testOrderConflictRejectedBeforeReading() {
  const fileSystem = createFileSystem({
    "word/media/conflict.png": imageBytes(25)
  });
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) =>
      succeed({ fileID: cloudFileID(record.cloudPath) })
  );
  const image = {
    order: 1,
    packagePath: "word/media/conflict.png",
    extension: ".png"
  };

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://conflict.docx",
        images: [image],
        uploadPlan: [
          {
            imageOrder: 1,
            order: 2,
            packagePath: image.packagePath,
            extension: image.extension,
            cloudPath: "protected/contents/article-1/assets/upload-conflict/embedded/0001.png"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) => error && error.code === "DOCX_IMAGE_PLAN_MISMATCH"
  );
  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://conflict.docx",
        images: [{ ...image, imageOrder: 2 }],
        uploadPlan: [],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) => error && error.code === "DOCX_IMAGE_PLAN_INVALID"
  );
  assert.strictEqual(fileSystem.reads.length, 0);
  assert.strictEqual(fileSystem.writes.length, 0);
  assert.strictEqual(runtimeState.uploads.length, 0);
}

async function testUploadFailureAlwaysCleansTemporaryFile() {
  const fileSystem = createFileSystem({
    "word/media/fail.webp": imageBytes(30)
  });
  const runtimeState = createRuntime(fileSystem, ({ fail }) => {
    setImmediate(() => fail({ errMsg: "uploadFile:fail network" }));
  });

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://failure.docx",
        images: [
          {
            imageOrder: 1,
            packagePath: "word/media/fail.webp",
            extension: ".webp"
          }
        ],
        uploadPlan: [
          {
            order: 1,
            packagePath: "word/media/fail.webp",
            extension: ".webp",
            cloudPath: "protected/contents/article-1/assets/upload4/embedded/0001.webp"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) =>
      error &&
      error.code === "DOCX_IMAGE_UPLOAD_FAILED" &&
      Array.isArray(error.uploadedFiles) &&
      error.uploadedFiles.length === 0
  );
  assert.strictEqual(fileSystem.writes.length, 1);
  assert.strictEqual(fileSystem.unlinks.length, 1);
  assert.strictEqual(fileSystem.temporaryFiles.size, 0);
}

async function testRetryOnlyUploadsMissingImages() {
  const entries = {
    "word/media/first.png": imageBytes(50),
    "word/media/second.png": imageBytes(60)
  };
  const images = [
    {
      order: 1,
      packagePath: "word/media/first.png",
      extension: ".png"
    },
    {
      order: 2,
      packagePath: "word/media/second.png",
      extension: ".png"
    }
  ];
  const uploadPlan = images.map((image) => ({
    imageOrder: image.order,
    packagePath: image.packagePath,
    extension: image.extension,
    cloudPath:
      `protected/contents/article-1/assets/upload-resume/embedded/` +
      `${String(image.order).padStart(4, "0")}.png`
  }));

  const firstFileSystem = createFileSystem(entries);
  let firstAttemptIndex = 0;
  const firstRuntime = createRuntime(
    firstFileSystem,
    ({ record, succeed, fail }) => {
      firstAttemptIndex += 1;
      if (firstAttemptIndex === 1) {
        setImmediate(() =>
          succeed({ fileID: cloudFileID(record.cloudPath) })
        );
      } else {
        setImmediate(() =>
          fail({ errMsg: "uploadFile:fail network" })
        );
      }
    }
  );
  let interrupted;
  try {
    await transferDocxImages({
      filePath: "wxfile://resume.docx",
      images,
      uploadPlan,
      wx: firstRuntime.runtime,
      fileSystem: firstFileSystem,
      concurrency: 1
    });
  } catch (error) {
    interrupted = error;
  }
  assert.ok(interrupted);
  assert.strictEqual(interrupted.code, "DOCX_IMAGE_UPLOAD_FAILED");
  assert.deepStrictEqual(
    interrupted.uploadedFiles.map((file) => file.imageOrder),
    [1]
  );
  assert.strictEqual(firstFileSystem.temporaryFiles.size, 0);

  const secondFileSystem = createFileSystem(entries);
  const secondRuntime = createRuntime(
    secondFileSystem,
    ({ record, succeed }) => {
      setImmediate(() =>
        succeed({ fileID: cloudFileID(record.cloudPath) })
      );
    }
  );
  const progress = [];
  const result = await transferDocxImages({
    filePath: "wxfile://resume.docx",
    images,
    uploadPlan,
    existingFiles: interrupted.uploadedFiles,
    wx: secondRuntime.runtime,
    fileSystem: secondFileSystem,
    concurrency: 1,
    onProgress(event) {
      progress.push(event);
    }
  });

  assert.deepStrictEqual(
    result.files.map((file) => file.imageOrder),
    [1, 2]
  );
  assert.strictEqual(secondRuntime.uploads.length, 1);
  assert.strictEqual(
    secondRuntime.uploads[0].cloudPath,
    uploadPlan[1].cloudPath
  );
  assert.strictEqual(secondFileSystem.reads.length, 1);
  assert.strictEqual(
    secondFileSystem.reads[0],
    "word/media/second.png"
  );
  assert.strictEqual(progress[0].completed, 1);
  assert.strictEqual(result.confirmationBatches[0].length, 2);

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://resume.docx",
        images,
        uploadPlan,
        existingFiles: [
          {
            ...interrupted.uploadedFiles[0],
            cloudPath: uploadPlan[1].cloudPath
          }
        ],
        wx: secondRuntime.runtime,
        fileSystem: secondFileSystem
      }),
    (error) => error && error.code === "DOCX_IMAGE_RESUME_INVALID"
  );
}

async function testCancellationAbortsAndCleansTemporaryFile() {
  const fileSystem = createFileSystem({
    "word/media/cancel.gif": imageBytes(40)
  });
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const runtimeState = createRuntime(fileSystem, () => {
    signalStarted();
  });
  const controller = createCancellationController();
  const transfer = transferDocxImages({
    filePath: "wxfile://cancel.docx",
    images: [
      {
        imageOrder: 1,
        packagePath: "word/media/cancel.gif",
        extension: ".gif"
      }
    ],
    uploadPlan: [
      {
        order: 1,
        packagePath: "word/media/cancel.gif",
        extension: ".gif",
        cloudPath: "protected/contents/article-1/assets/upload5/embedded/0001.gif"
      }
    ],
    wx: runtimeState.runtime,
    fileSystem,
    cancelToken: controller.token
  });

  await started;
  controller.cancel();
  await assert.rejects(
    () => transfer,
    (error) =>
      error &&
      error.code === "DOCX_IMAGE_UPLOAD_CANCELLED" &&
      error.message === "Word 图片上传已取消"
  );
  assert.strictEqual(runtimeState.uploads.length, 1);
  assert.strictEqual(runtimeState.uploads[0].aborted, true);
  assert.strictEqual(fileSystem.unlinks.length, 1);
  assert.strictEqual(fileSystem.temporaryFiles.size, 0);
}

async function testArchiveReadsAreSerialized() {
  const fileSystem = createFileSystem({});
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) => {
      setTimeout(
        () => succeed({ fileID: cloudFileID(record.cloudPath) }),
        15
      );
    }
  );
  const images = Array.from({ length: 4 }, (_, index) => ({
    imageOrder: index + 1,
    packagePath: `word/media/serial-${index + 1}.png`,
    extension: ".png"
  }));
  const uploadPlan = images.map((image) => ({
    ...image,
    cloudPath:
      `protected/contents/article-1/assets/upload-serial/embedded/` +
      `${String(image.imageOrder).padStart(4, "0")}.png`
  }));
  let activeReads = 0;
  let maximumActiveReads = 0;

  const result = await transferDocxImages({
    filePath: "wxfile://serial.docx",
    images,
    uploadPlan,
    wx: runtimeState.runtime,
    fileSystem,
    concurrency: 4,
    async readImage() {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReads -= 1;
      return imageBytes(70);
    }
  });

  assert.strictEqual(result.files.length, 4);
  assert.strictEqual(maximumActiveReads, 1);
  assert.ok(runtimeState.getMaximumActiveUploads() >= 2);
}

async function testExtractionFailureDoesNotCleanAnUnwrittenFile() {
  const fileSystem = createFileSystem({});
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) =>
      succeed({ fileID: cloudFileID(record.cloudPath) })
  );

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://extract-failure.docx",
        images: [
          {
            imageOrder: 1,
            packagePath: "word/media/unreadable.png",
            extension: ".png"
          }
        ],
        uploadPlan: [
          {
            imageOrder: 1,
            packagePath: "word/media/unreadable.png",
            extension: ".png",
            cloudPath:
              "protected/contents/article-1/assets/upload-extract/embedded/0001.png"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem,
        async readImage() {
          const error = new Error("native bridge returned an unknown value");
          error.code = "DOCX_ENTRY_READ_FAILED";
          throw error;
        }
      }),
    (error) => error && error.code === "DOCX_IMAGE_EXTRACT_FAILED"
  );
  assert.strictEqual(fileSystem.writes.length, 0);
  assert.strictEqual(fileSystem.unlinks.length, 0);
  assert.strictEqual(runtimeState.uploads.length, 0);
}

async function testCrossRealmBytesAreCopiedBeforeUpload() {
  const foreignBytes = vm.runInNewContext(
    "new Uint8Array([255, 216, 255, 224, 1, 2]).buffer"
  );
  const fileSystem = createFileSystem({
    "word/media/foreign.jpeg": foreignBytes
  });
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) => {
      const persisted = fileSystem.temporaryFiles.get(record.filePath);
      assert.ok(persisted instanceof ArrayBuffer);
      assert.deepStrictEqual(
        Array.from(new Uint8Array(persisted)),
        [255, 216, 255, 224, 1, 2]
      );
      succeed({ fileID: cloudFileID(record.cloudPath) });
    }
  );

  const result = await transferDocxImages({
    filePath: "wxfile://foreign.docx",
    images: [
      {
        imageOrder: 1,
        packagePath: "word/media/foreign.jpeg",
        extension: ".jpeg"
      }
    ],
    uploadPlan: [
      {
        imageOrder: 1,
        packagePath: "word/media/foreign.jpeg",
        extension: ".jpeg",
        cloudPath:
          "protected/contents/article-1/assets/upload-foreign/embedded/0001.jpeg"
      }
    ],
    wx: runtimeState.runtime,
    fileSystem
  });

  assert.strictEqual(result.files.length, 1);
  assert.strictEqual(fileSystem.temporaryFiles.size, 0);
}

async function testCloudPermissionFailureKeepsNativeDiagnostics() {
  const fileSystem = createFileSystem({
    "word/media/permission.png": imageBytes(70)
  });
  const runtimeState = createRuntime(fileSystem, ({ fail }) => {
    setImmediate(() =>
      fail({
        errMsg: "uploadFile:fail Have no access right to the storage",
        errCode: -503002,
        requestId: "storage-request-1"
      })
    );
  });

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://permission.docx",
        images: [
          {
            imageOrder: 1,
            packagePath: "word/media/permission.png",
            extension: ".png"
          }
        ],
        uploadPlan: [
          {
            imageOrder: 1,
            packagePath: "word/media/permission.png",
            extension: ".png",
            cloudPath:
              "protected/contents/article-1/assets/upload-permission/embedded/0001.png"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) => {
      assert.strictEqual(error.code, "DOCX_IMAGE_UPLOAD_FAILED");
      assert.strictEqual(error.nativeErrorCode, "-503002");
      assert.strictEqual(
        error.nativeErrorMessage,
        "uploadFile:fail Have no access right to the storage"
      );
      assert.strictEqual(error.requestId, "storage-request-1");
      assert.ok(error.message.includes("云存储"));
      assert.ok(!error.message.includes("检查网络"));
      assert.ok(!error.message.includes("Have no access right"));
      assert.strictEqual(error.temporaryFileSize, 4);
      return true;
    }
  );
}

async function testTemporaryFileSizeMismatchStopsBeforeUpload() {
  const fileSystem = createFileSystem({
    "word/media/empty.png": imageBytes(80)
  });
  fileSystem.stat = (options) => {
    options.success({ stats: { size: 0 } });
  };
  const runtimeState = createRuntime(
    fileSystem,
    ({ record, succeed }) =>
      succeed({ fileID: cloudFileID(record.cloudPath) })
  );

  await assert.rejects(
    () =>
      transferDocxImages({
        filePath: "wxfile://empty.docx",
        images: [
          {
            imageOrder: 1,
            packagePath: "word/media/empty.png",
            extension: ".png"
          }
        ],
        uploadPlan: [
          {
            imageOrder: 1,
            packagePath: "word/media/empty.png",
            extension: ".png",
            cloudPath:
              "protected/contents/article-1/assets/upload-empty/embedded/0001.png"
          }
        ],
        wx: runtimeState.runtime,
        fileSystem
      }),
    (error) => error && error.code === "DOCX_IMAGE_TEMP_VERIFY_FAILED"
  );
  assert.strictEqual(runtimeState.uploads.length, 0);
  assert.strictEqual(fileSystem.unlinks.length, 1);
  assert.strictEqual(fileSystem.temporaryFiles.size, 0);
}

async function main() {
  await testSuccessfulBoundedTransfer();
  await testRepeatedReferenceUploadsOnce();
  await testPlanMismatchRejectedBeforeReading();
  await testOrderConflictRejectedBeforeReading();
  await testUploadFailureAlwaysCleansTemporaryFile();
  await testRetryOnlyUploadsMissingImages();
  await testCancellationAbortsAndCleansTemporaryFile();
  await testArchiveReadsAreSerialized();
  await testExtractionFailureDoesNotCleanAnUnwrittenFile();
  await testCrossRealmBytesAreCopiedBeforeUpload();
  await testCloudPermissionFailureKeepsNativeDiagnostics();
  await testTemporaryFileSizeMismatchStopsBeforeUpload();
  console.log(
    "Word 图片直传测试通过：严格计划校验、去重、并发、失败清理与取消均正常。"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
