const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

function loadCloudFunction(relativePath, cloud) {
  const filename = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const localRequire = Module.createRequire(filename);
  const sandbox = {
    Buffer,
    URL,
    clearTimeout,
    console: {
      error: () => {},
      log: console.log,
      warn: () => {}
    },
    __dirname: path.dirname(filename),
    __filename: filename,
    module,
    exports: module.exports,
    require(request) {
      return request === "wx-server-sdk" ? cloud : localRequire(request);
    },
    setTimeout
  };

  vm.runInNewContext(source, sandbox, { filename });
  return module.exports.main;
}

function matchesExactFilter(item, filter) {
  return Object.entries(filter).every(([key, value]) => item[key] === value);
}

function createMemberSessionId(openid) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["member-session", openid]))
    .digest("hex")
    .slice(0, 32);
}

function attachTempFileURLMock(cloud, options) {
  if (options.tempURL === false) {
    return;
  }

  cloud.getTempFileURL = async ({ fileList }) => {
    if (options.tempURLThrows) {
      throw new Error("temporary URL service unavailable");
    }

    if (typeof options.tempURLResponse === "function") {
      return options.tempURLResponse(fileList);
    }

    return {
      fileList: fileList.map((fileID, index) => ({
        fileID,
        status: 0,
        tempFileURL:
          `https://signed.example/display-${index + 1}.png?token=test`
      }))
    };
  };
}

function createContentDetailHarness(options = {}) {
  const queries = [];
  const openid = Object.prototype.hasOwnProperty.call(options, "openid")
    ? options.openid
    : "detail-member";
  const contents = options.contents || [
    {
      _id: "published-story",
      contentId: "published-story",
      currentRevision: "revision-1",
      status: "published",
      audioStatus: "published",
      publishedAudioTrackCount: 1,
      title: "Published story",
      sections: [
        {
          kind: "story",
          heading: "Story",
          paragraphs: ["Member-only paragraph"]
        }
      ],
      audio: {
        title: "Audio title",
        narrator: "Narrator",
        durationMs: 60000,
        fileID: "cloud://must-not-leak/audio.mp3"
      },
      internalSecret: "must-not-leak"
    }
  ];
  const users = options.users || [
    {
      _id: "detail-user",
      openid: "detail-member",
      registerStatus: "active"
    }
  ];
  const selectedUser =
    users.find((user) => user.openid === openid) || users[0] || null;
  const sessions = new Map(
    (options.sessions || (openid
      ? [
          {
            _id: createMemberSessionId(openid),
            openid,
            userId: selectedUser ? selectedUser._id : "detail-user",
            memberId: selectedUser && selectedUser.memberId
              ? selectedUser.memberId
              : "DETAILMEMBER01",
            status: "active",
            expiresAt: new Date("2099-01-01T00:00:00.000Z")
          }
        ]
      : [])).map((session) => [session._id, { ...session }])
  );
  const db = {
    collection(name) {
      if (name === "contents") {
        return {
          doc(documentId) {
            queries.push({ name, operation: "doc", documentId });

            return {
              async get() {
                if (options.contentReadError) {
                  throw options.contentReadError;
                }

                return {
                  data: contents.find((item) => item._id === documentId) || null
                };
              }
            };
          }
        };
      }

      assert(["memberSessions", "users"].includes(name));

      return {
        doc(documentId) {
          queries.push({ name, operation: "doc", documentId });

          return {
            async get() {
              if (name === "memberSessions") {
                return { data: sessions.get(documentId) || null };
              }

              return {
                data: users.find((item) => item._id === documentId) || null
              };
            }
          };
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };
  attachTempFileURLMock(cloud, options);

  return {
    main: loadCloudFunction(
      "cloudfunctions/getContentDetail/index.js",
      cloud
    ),
    queries
  };
}

function createCatalogHarness(options = {}) {
  const queries = [];
  const openid = Object.prototype.hasOwnProperty.call(options, "openid")
    ? options.openid
    : "reader-catalog";
  const contents = options.contents || [];
  const readingStates = options.readingStates || [];
  const users = options.users || [
    {
      _id: "reader-catalog-user",
      openid: "reader-catalog",
      memberId: "CATALOGMEMBER01",
      registerStatus: "active"
    }
  ];
  const selectedUser =
    users.find((user) => user.openid === openid) || users[0] || null;
  const sessions = new Map(
    (options.sessions || (openid
      ? [
          {
            _id: createMemberSessionId(openid),
            openid,
            userId: selectedUser ? selectedUser._id : "reader-catalog-user",
            memberId: selectedUser && selectedUser.memberId
              ? selectedUser.memberId
              : "CATALOGMEMBER01",
            status: "active",
            expiresAt: new Date("2099-01-01T00:00:00.000Z")
          }
        ]
      : [])).map((session) => [session._id, { ...session }])
  );
  const matchesFilter = (item, filter) =>
    Object.entries(filter).every(([key, value]) => {
      if (value && value.__all) {
        return (
          Array.isArray(item[key]) &&
          value.__all.every((candidate) => item[key].includes(candidate))
        );
      }

      if (value && value.__in) {
        return Array.isArray(item[key])
          ? item[key].some((candidate) => value.__in.includes(candidate))
          : value.__in.includes(item[key]);
      }

      return item[key] === value;
    });
  const db = {
    command: {
      all(values) {
        return { __all: values };
      },
      in(values) {
        return { __in: values };
      }
    },
    collection(name) {
      return {
        doc(documentId) {
          queries.push({ name, operation: "doc", documentId });

          return {
            async get() {
              if (name === "memberSessions") {
                return { data: sessions.get(documentId) || null };
              }

              assert.strictEqual(name, "users");
              return {
                data: users.find((item) => item._id === documentId) || null
              };
            }
          };
        },
        where(filter) {
          assert(["contents", "readingStates"].includes(name));
          const query = { name, filter, orderBy: [], offset: 0 };
          queries.push(query);
          const chain = {
            orderBy(field, direction) {
              query.orderBy.push({ field, direction });
              return chain;
            },
            skip(offset) {
              query.offset = offset;
              return chain;
            },
            limit(limit) {
              query.limit = limit;

              return {
                async get() {
                  if (name === "contents" && options.contentsMissing) {
                    const error = new Error("collection does not exist");
                    error.errCode = -502005;
                    throw error;
                  }

                  if (
                    name === "readingStates" &&
                    options.readingStatesMissing
                  ) {
                    const error = new Error("collection does not exist");
                    error.errCode = -502005;
                    throw error;
                  }

                  const source = name === "contents" ? contents : readingStates;
                  const rows = source
                    .filter((item) => matchesFilter(item, filter))
                    .slice();

                  for (let index = query.orderBy.length - 1; index >= 0; index -= 1) {
                    const order = query.orderBy[index];
                    const factor = order.direction === "desc" ? -1 : 1;

                    rows.sort((left, right) => {
                      const leftValue = left[order.field];
                      const rightValue = right[order.field];

                      if (leftValue === rightValue) {
                        return 0;
                      }

                      return (leftValue < rightValue ? -1 : 1) * factor;
                    });
                  }

                  return {
                    data: rows.slice(query.offset, query.offset + limit)
                  };
                }
              };
            }
          };

          return chain;
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };
  attachTempFileURLMock(cloud, options);

  return {
    main: loadCloudFunction(
      "cloudfunctions/getContentCatalog/index.js",
      cloud
    ),
    queries
  };
}

function createMarkContentReadHarness(options = {}) {
  const states = new Map(options.states || []);
  const writes = [];
  const openid = Object.prototype.hasOwnProperty.call(options, "openid")
    ? options.openid
    : "reader-mark";
  const contentId = options.contentId || "published-story";
  const publishedContent = Object.prototype.hasOwnProperty.call(options, "content")
    ? options.content
    : {
        _id: contentId,
        contentId,
        status: "published",
        currentRevision: "revision-1"
      };
  const users = options.users || [
    {
      _id: "reader-user",
      openid: "reader-mark",
      memberId: "READERMEMBER01",
      registerStatus: "active"
    }
  ];
  const selectedUser =
    users.find((user) => user.openid === openid) || users[0] || null;
  const userId = selectedUser ? selectedUser._id : "reader-user";
  const memberId = selectedUser && selectedUser.memberId
    ? selectedUser.memberId
    : "READERMEMBER01";
  const sessions = new Map(
    (options.sessions || (openid
      ? [
          {
            _id: createMemberSessionId(openid),
            openid,
            userId,
            memberId,
            status: "active",
            expiresAt: new Date("2099-01-01T00:00:00.000Z")
          }
        ]
      : [])).map((session) => [session._id, { ...session }])
  );
  let transactionCalls = 0;

  function collection(name) {
    if (name === "memberSessions") {
      return {
        doc(documentId) {
          return {
            async get() {
              return { data: sessions.get(documentId) || null };
            }
          };
        }
      };
    }

    if (name === "users") {
      return {
        doc(documentId) {
          return {
            async get() {
              return {
                data: users.find((item) => item._id === documentId) || null
              };
            }
          };
        }
      };
    }

    if (name === "contents") {
      return {
        doc(id) {
          return {
            async get() {
              if (options.contentReadError) {
                throw options.contentReadError;
              }

              return {
                data: publishedContent && id === contentId
                  ? publishedContent
                  : null
              };
            }
          };
        }
      };
    }

    assert.strictEqual(name, "readingStates");

    return {
      doc(documentId) {
        return {
          async get() {
            if (options.stateReadError) {
              throw options.stateReadError;
            }

            if (!states.has(documentId)) {
              const error = new Error("document not found");
              error.code = "DOCUMENT_NOT_FOUND";
              throw error;
            }

            return { data: states.get(documentId) };
          },
          async set({ data }) {
            writes.push({ operation: "set", documentId, data });
            states.set(documentId, { ...data });
          },
          async update({ data }) {
            writes.push({ operation: "update", documentId, data });
            states.set(documentId, {
              ...states.get(documentId),
              ...data
            });
          }
        };
      }
    };
  }

  const db = {
    serverDate: () => new Date("2026-07-13T00:00:00.000Z"),
    collection,
    async runTransaction(callback) {
      transactionCalls += 1;
      const result = await callback({ collection });

      return options.wrapTransactionResult
        ? { result, errMsg: "runTransaction:ok" }
        : result;
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };

  return {
    contentRevision: publishedContent && publishedContent.currentRevision
      ? publishedContent.currentRevision
      : "revision-1",
    contentId,
    main: loadCloudFunction("cloudfunctions/markContentRead/index.js", cloud),
    openid,
    states,
    userId,
    get transactionCalls() {
      return transactionCalls;
    },
    writes
  };
}

function createTimelineHarness(entries) {
  const queries = [];
  const command = {
    gte(start) {
      return {
        and(next) {
          return {
            start,
            end: next.end
          };
        }
      };
    },
    lt(end) {
      return { end };
    }
  };
  const db = {
    command,
    collection(name) {
      assert.strictEqual(name, "zhiEntries");

      return {
        where(filter) {
          queries.push(filter);
          const query = { offset: 0, orderBy: [] };
          const chain = {
            orderBy(field, direction) {
              query.orderBy.push({ field, direction });
              return chain;
            },
            skip(offset) {
              query.offset = offset;
              return chain;
            },
            limit(limit) {
              return {
                async get() {
                  const rows = entries
                    .filter((item) => {
                      const eventAt = new Date(item.eventAt).getTime();

                      return (
                        item.status === filter.status &&
                        eventAt >= filter.eventAt.start.getTime() &&
                        eventAt < filter.eventAt.end.getTime()
                      );
                    })
                    .slice();

                  for (
                    let index = query.orderBy.length - 1;
                    index >= 0;
                    index -= 1
                  ) {
                    const order = query.orderBy[index];
                    const factor = order.direction === "desc" ? -1 : 1;

                    rows.sort((left, right) => {
                      const leftValue = order.field === "eventAt"
                        ? new Date(left[order.field]).getTime()
                        : left[order.field];
                      const rightValue = order.field === "eventAt"
                        ? new Date(right[order.field]).getTime()
                        : right[order.field];

                      if (leftValue === rightValue) {
                        return 0;
                      }

                      return (leftValue < rightValue ? -1 : 1) * factor;
                    });
                  }

                  return {
                    data: rows.slice(query.offset, query.offset + limit)
                  };
                }
              };
            }
          };

          return chain;
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    init: () => {}
  };

  return {
    main: loadCloudFunction(
      "cloudfunctions/getYouthTimeline/index.js",
      cloud
    ),
    queries
  };
}

function createAudioManifestHarness(options = {}) {
  const queries = [];
  const openid = Object.prototype.hasOwnProperty.call(options, "openid")
    ? options.openid
    : "audio-member";
  const contents = options.contents || [];
  const tracks = options.tracks || [];
  const users = options.users || [
    {
      _id: "audio-user",
      openid: "audio-member",
      memberId: "AUDIOMEMBER01",
      registerStatus: "active"
    }
  ];
  const selectedUser =
    users.find((user) => user.openid === openid) || users[0] || null;
  const sessions = new Map(
    (options.sessions || (openid
      ? [
          {
            _id: createMemberSessionId(openid),
            openid,
            userId: selectedUser ? selectedUser._id : "audio-user",
            memberId: selectedUser && selectedUser.memberId
              ? selectedUser.memberId
              : "AUDIOMEMBER01",
            status: "active",
            expiresAt: new Date("2099-01-01T00:00:00.000Z")
          }
        ]
      : [])).map((session) => [session._id, { ...session }])
  );
  const db = {
    collection(name) {
      if (name === "memberSessions" || name === "users") {
        return {
          doc(documentId) {
            queries.push({ name, operation: "doc", documentId });

            return {
              async get() {
                if (name === "memberSessions") {
                  return { data: sessions.get(documentId) || null };
                }

                return {
                  data: users.find((item) => item._id === documentId) || null
                };
              }
            };
          }
        };
      }

      if (name === "contents") {
        return {
          doc(documentId) {
            queries.push({ name, operation: "doc", documentId });

            return {
              async get() {
                if (options.contentReadError) {
                  throw options.contentReadError;
                }

                return {
                  data: contents.find((item) => item._id === documentId) || null
                };
              }
            };
          }
        };
      }

      assert.strictEqual(name, "audioTracks");

      return {
        where(filter) {
          const query = { name, operation: "where", filter, orderBy: [] };
          queries.push(query);
          const chain = {
            orderBy(field, direction) {
              query.orderBy.push({ field, direction });
              return chain;
            },
            limit(limit) {
              return {
                async get() {
                  if (options.trackReadError) {
                    throw options.trackReadError;
                  }

                  const rows = tracks
                    .filter((item) => matchesExactFilter(item, filter))
                    .slice();

                  for (
                    let index = query.orderBy.length - 1;
                    index >= 0;
                    index -= 1
                  ) {
                    const order = query.orderBy[index];
                    const directionFactor =
                      order.direction === "desc" ? -1 : 1;

                    rows.sort((left, right) => {
                      const leftValue = left[order.field];
                      const rightValue = right[order.field];

                      if (leftValue === rightValue) {
                        return 0;
                      }

                      return (leftValue < rightValue ? -1 : 1) * directionFactor;
                    });
                  }

                  return { data: rows.slice(0, limit) };
                }
              };
            }
          };

          return chain;
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getTempFileURL: async ({ fileList }) => ({
      fileList: fileList.map((fileID) => ({
        fileID,
        status: 0,
        tempFileURL: `https://signed.example/${encodeURIComponent(fileID)}`
      }))
    }),
    getWXContext: () => ({ OPENID: openid }),
    init: () => {}
  };

  return {
    main: loadCloudFunction(
      "cloudfunctions/getAudioManifest/index.js",
      cloud
    ),
    queries
  };
}

function createFamilyCenterHarness(options = {}) {
  const users = options.users || [
    {
      _id: "user-inviter",
      openid: "family-inviter",
      registerStatus: "active",
      nickname: "少年甲"
    },
    {
      _id: "user-relative-a",
      openid: "family-relative-a",
      registerStatus: "active",
      nickname: "亲友乙"
    },
    {
      _id: "user-relative-b",
      openid: "family-relative-b",
      registerStatus: "active",
      nickname: "亲友丙"
    }
  ];
  const invites = new Map();
  const inviteCounters = new Map();
  const relations = new Map();
  const relationCounters = new Map();
  const sessions = new Map(
    (options.sessions || users.map((user) => ({
      _id: createMemberSessionId(user.openid),
      openid: user.openid,
      userId: user._id,
      memberId: user.memberId || "",
      status: "active",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    }))).map((session) => [session._id, { ...session }])
  );
  const writes = [];
  let currentOpenid = options.openid || "family-inviter";
  let beforeTransaction = null;

  function getRows(name) {
    if (name === "users") {
      return users;
    }

    if (name === "familyInvites") {
      return Array.from(invites.values());
    }

    if (name === "familyInviteCounters") {
      return Array.from(inviteCounters.values());
    }

    if (name === "familyRelationCounters") {
      return Array.from(relationCounters.values());
    }

    if (name === "memberSessions") {
      return Array.from(sessions.values());
    }

    assert.strictEqual(name, "familyRelations");
    return Array.from(relations.values());
  }

  function getStore(name) {
    if (name === "familyInvites") {
      return invites;
    }

    if (name === "familyInviteCounters") {
      return inviteCounters;
    }

    if (name === "familyRelationCounters") {
      return relationCounters;
    }

    if (name === "memberSessions") {
      return sessions;
    }

    assert.strictEqual(name, "familyRelations");
    return relations;
  }

  function collection(name) {
    return {
      where(filter) {
        const matchingRows = () =>
          getRows(name).filter((item) =>
            Object.entries(filter).every(([key, value]) => {
              if (value && value.__gte) {
                return new Date(item[key]).getTime() >= value.__gte.getTime();
              }

              return item[key] === value;
            })
          );

        return {
          async count() {
            return { total: matchingRows().length };
          },
          async get() {
            return { data: matchingRows() };
          },
          limit(limit) {
            return {
              async get() {
                return { data: matchingRows().slice(0, limit) };
              }
            };
          }
        };
      },
      doc(documentId) {
        return {
          async get() {
            const readFailure = options.documentReadFailure;

            if (
              readFailure &&
              (!readFailure.collection || readFailure.collection === name) &&
              (!readFailure.documentId ||
                readFailure.documentId === documentId)
            ) {
              const error = new Error(
                readFailure.message || "database request failed"
              );
              error.errCode = readFailure.errCode || -502001;
              throw error;
            }

            if (name === "users") {
              const user = users.find((item) => item._id === documentId);

              if (!user) {
                const error = new Error("document does not exist");
                error.code = "DOCUMENT_NOT_FOUND";
                throw error;
              }

              return { data: user };
            }

            const store = getStore(name);

            if (!store.has(documentId)) {
              const error = new Error("document does not exist");
              error.code = "DOCUMENT_NOT_FOUND";
              throw error;
            }

            return { data: store.get(documentId) };
          },
          async set({ data }) {
            const store = getStore(name);
            const document = { _id: documentId, ...data };

            store.set(documentId, document);
            writes.push({ operation: "set", name, documentId, data });
          },
          async update({ data }) {
            if (
              options.failFamilyInviteCounterUpdate &&
              name === "familyInviteCounters"
            ) {
              throw new Error("family invite counter update must not run");
            }

            const store = getStore(name);
            const existing = store.get(documentId);

            if (!existing) {
              throw new Error("document does not exist");
            }

            store.set(documentId, { ...existing, ...data });
            writes.push({ operation: "update", name, documentId, data });
          }
        };
      }
    };
  }

  const db = {
    command: {
      gte(value) {
        return { __gte: value };
      }
    },
    collection,
    async runTransaction(callback) {
      if (beforeTransaction) {
        const callbackBeforeTransaction = beforeTransaction;
        beforeTransaction = null;
        await callbackBeforeTransaction();
      }

      const result = await callback({ collection });

      if (options.transactionThrowsAfterCommit) {
        const error = new Error("transaction commit response unavailable");
        error.code = "COMMIT_RESPONSE_UNAVAILABLE";
        throw error;
      }

      return options.transactionReturnsVoid ? undefined : result;
    },
    serverDate: () => new Date("2026-07-13T08:00:00.000Z")
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getWXContext: () => ({ OPENID: currentOpenid }),
    init: () => {}
  };

  return {
    inviteCounters,
    invites,
    main: loadCloudFunction("cloudfunctions/familyCenter/index.js", cloud),
    relationCounters,
    relations,
    sessions,
    setBeforeTransaction(callback) {
      beforeTransaction = callback;
    },
    setOpenid(openid) {
      currentOpenid = openid;
    },
    users,
    writes
  };
}

function createMemberInboxHarness(options = {}) {
  const messages = new Map(
    (options.messages || []).map((message) => [message._id, { ...message }])
  );
  const updates = [];
  let currentOpenid = options.openid || "inbox-owner";
  const users = options.users || [
    {
      _id: "inbox-owner-user",
      openid: "inbox-owner",
      memberId: "INBOXOWNER001",
      registerStatus: "active"
    }
  ];
  const sessions = new Map(
    (options.sessions || users.map((user) => ({
      _id: createMemberSessionId(user.openid),
      openid: user.openid,
      userId: user._id,
      memberId: user.memberId,
      status: "active",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    }))).map((session) => [session._id, { ...session }])
  );
  const db = {
    command: {
      lte(value) {
        return { __lte: value };
      }
    },
    serverDate: () => new Date("2026-07-13T08:00:00.000Z"),
    collection(name) {
      if (name === "memberSessions") {
        return {
          doc(documentId) {
            return {
              async get() {
                if (!sessions.has(documentId)) {
                  const error = new Error("document does not exist");
                  error.code = "DOCUMENT_NOT_FOUND";
                  throw error;
                }

                return { data: sessions.get(documentId) };
              }
            };
          }
        };
      }

      if (name === "users") {
        return {
          doc(documentId) {
            return {
              async get() {
                const user = users.find((item) => item._id === documentId);

                if (!user) {
                  const error = new Error("document does not exist");
                  error.code = "DOCUMENT_NOT_FOUND";
                  throw error;
                }

                return { data: user };
              }
            };
          }
        };
      }

      assert.strictEqual(name, "memberMessages");

      return {
        where(filter) {
          const matchingRows = () =>
            Array.from(messages.values()).filter((item) =>
              Object.entries(filter).every(([key, value]) => {
                if (value && value.__lte) {
                  return new Date(item[key]).getTime() <= value.__lte.getTime();
                }

                return item[key] === value;
              })
            );
          const query = { offset: 0, orderBy: [] };
          const readRows = (limit) => {
            const rows = matchingRows();

            for (let index = query.orderBy.length - 1; index >= 0; index -= 1) {
              const order = query.orderBy[index];
              const factor = order.direction === "desc" ? -1 : 1;

              rows.sort((left, right) => {
                const rawLeft = left[order.field];
                const rawRight = right[order.field];
                const leftValue = order.field === "publishedAt"
                  ? new Date(rawLeft).getTime()
                  : rawLeft;
                const rightValue = order.field === "publishedAt"
                  ? new Date(rawRight).getTime()
                  : rawRight;

                if (leftValue === rightValue) {
                  return 0;
                }

                return (leftValue < rightValue ? -1 : 1) * factor;
              });
            }

            return {
              data: rows.slice(query.offset, query.offset + limit)
            };
          };

          const chain = {
            orderBy(field, direction) {
              query.orderBy.push({ field, direction });
              return chain;
            },
            skip(offset) {
              query.offset = offset;
              return chain;
            },
            limit(limit) {
              return {
                async get() {
                  return readRows(limit);
                }
              };
            }
          };

          return chain;
        },
        doc(documentId) {
          return {
            async update({ data }) {
              assert.strictEqual(messages.has(documentId), true);
              messages.set(documentId, {
                ...messages.get(documentId),
                ...data
              });
              updates.push({ documentId, data });
            }
          };
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => db,
    getWXContext: () => ({ OPENID: currentOpenid }),
    init: () => {}
  };

  return {
    main: loadCloudFunction("cloudfunctions/memberInbox/index.js", cloud),
    messages,
    sessions,
    setOpenid(openid) {
      currentOpenid = openid;
    },
    updates
  };
}

async function legacyTestContentCatalog() {
  const fallbackHarness = createCatalogHarness({
    contentsMissing: true
  });
  const fallback = await fallbackHarness.main({ view: "summary" });

  assert.strictEqual(fallback.success, true);
  assert.strictEqual(fallback.source, "fallback");
  assert.strictEqual(fallback.view, "summary");
  assert.deepStrictEqual(
    Array.from(fallback.items, (item) => item.id),
    ["esophageal-cancer-story"]
  );

  const readAt = "2026-07-13T08:00:00.000Z";
  const harness = createCatalogHarness({
    contents: [
      {
        _id: "published-later",
        status: "published",
        title: "后发布内容",
        catalogViews: ["book"],
        sortOrder: 20
      },
      {
        _id: "draft-hidden",
        status: "draft",
        title: "草稿内容",
        catalogViews: ["book"],
        sortOrder: 0
      },
      {
        _id: "published-first",
        status: "published",
        title: "先发布内容",
        catalogViews: ["book"],
        sortOrder: 10
      }
    ],
    readingStates: [
      {
        userId: "reader-catalog-user",
        contentId: "published-first",
        contentRevision: "revision-1",
        lastReadAt: readAt
      },
      {
        userId: "another-reader-user",
        contentId: "published-later",
        contentRevision: "revision-1",
        lastReadAt: "ignored"
      }
    ]
  });
  const result = await harness.main({ view: "book" });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.source, "cloud");
  assert.deepStrictEqual(
    Array.from(result.items, (item) => item.id),
    ["published-first", "published-later"]
  );
  assert.strictEqual(result.items.some((item) => item.id === "draft-hidden"), false);
  assert.strictEqual(result.items[0].viewed, true);
  assert.strictEqual(result.items[0].readAt, readAt);
  assert.strictEqual(result.items[1].viewed, false);

  const isolatedSummary = await harness.main({ view: "summary" });
  assert.strictEqual(isolatedSummary.view, "summary");
  assert.strictEqual(isolatedSummary.source, "fallback");
  assert.deepStrictEqual(
    Array.from(isolatedSummary.items, (item) => item.id),
    ["esophageal-cancer-story"]
  );

  const defaultViewHarness = createCatalogHarness({
    contents: [
      {
        _id: "summary-by-default",
        status: "published",
        title: "Default summary content",
        sortOrder: 0
      }
    ]
  });
  const defaultSummary = await defaultViewHarness.main({});
  const isolatedBook = await defaultViewHarness.main({ catalogView: "book" });

  assert.strictEqual(defaultSummary.view, "summary");
  assert.strictEqual(defaultSummary.source, "cloud");
  assert.deepStrictEqual(
    Array.from(defaultSummary.items, (item) => item.id),
    ["summary-by-default"]
  );
  assert.strictEqual(isolatedBook.view, "book");
  assert.strictEqual(isolatedBook.source, "fallback");
  assert.deepStrictEqual(Array.from(isolatedBook.items), []);

  const contentQuery = harness.queries.find(
    (query) => query.name === "contents"
  );
  const stateQuery = harness.queries.find(
    (query) => query.name === "readingStates"
  );

  assert.strictEqual(contentQuery.filter.status, "published");
  assert.strictEqual(stateQuery.filter.openid, "reader-catalog");
}

async function legacyTestMarkContentRead() {
  const harness = createMarkContentReadHarness();
  const first = await harness.main({ contentId: harness.contentId });
  const second = await harness.main({ contentId: harness.contentId });
  const expectedId = crypto
    .createHash("sha256")
    .update(JSON.stringify([harness.openid, harness.contentId]))
    .digest("hex")
    .slice(0, 32);

  assert.strictEqual(first.success, true);
  assert.strictEqual(second.success, true);
  assert.strictEqual(harness.states.size, 1);
  assert.strictEqual(harness.writes.length, 2);
  assert.strictEqual(harness.writes[0].operation, "set");
  assert.strictEqual(harness.writes[1].operation, "update");
  assert.strictEqual(harness.writes[0].documentId, expectedId);
  assert.strictEqual(harness.writes[1].documentId, expectedId);
  assert.strictEqual(harness.states.get(expectedId).openid, harness.openid);
  assert.strictEqual(
    harness.states.get(expectedId).contentId,
    harness.contentId
  );
}

async function testYouthTimeline() {
  const harness = createTimelineHarness([
    {
      _id: "published-entry",
      status: "published",
      eventAt: new Date("2026-07-10T09:30:00+08:00"),
      content: "已发布消息\r\n第二段",
      fileID: "cloud://env/private/should-not-leak.jpg",
      image: "cloud://env/private/should-not-leak-either.jpg"
    },
    {
      _id: "draft-entry",
      status: "draft",
      eventAt: new Date("2026-07-11T09:30:00+08:00"),
      content: "草稿消息"
    },
    {
      _id: "x".repeat(129),
      status: "published",
      eventAt: new Date("2026-07-10T10:30:00+08:00"),
      content: "Invalid oversized id"
    },
    {
      _id: "oversized-source",
      status: "published",
      eventAt: new Date("2026-07-10T10:20:00+08:00"),
      source: "x".repeat(121),
      content: "Invalid oversized source"
    },
    {
      _id: "invalid-label",
      status: "published",
      eventAt: new Date("2026-07-10T10:10:00+08:00"),
      label: "Invalid\u0000label",
      content: "Invalid control character"
    },
    {
      _id: "oversized-content",
      status: "published",
      eventAt: new Date("2026-07-10T10:00:00+08:00"),
      content: "x".repeat(2001)
    },
    {
      _id: "outside-entry",
      status: "published",
      eventAt: new Date("2026-06-30T23:59:59+08:00"),
      content: "上月消息"
    }
  ]);
  const result = await harness.main({
    year: "2026",
    month: "07",
    limit: 20
  });

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(
    Array.from(result.entries, (entry) => entry.id),
    ["published-entry"]
  );
  assert.strictEqual(result.entries[0].content, "已发布消息\n第二段");
  assert.strictEqual(JSON.stringify(result).includes("cloud://"), false);
  assert.strictEqual(JSON.stringify(result).includes("fileID"), false);
  assert.strictEqual(harness.queries[0].status, "published");

  const invalidInputs = [
    { year: "1999", month: "1" },
    { year: "2026", month: "0" },
    { year: "2026", month: "13" },
    { year: "26", month: "7" }
  ];
  const queryCountBeforeInvalidInputs = harness.queries.length;

  for (const input of invalidInputs) {
    const invalid = await harness.main(input);

    assert.strictEqual(invalid.success, false);
    assert.strictEqual(invalid.code, "INVALID_DATE");
  }

  assert.strictEqual(harness.queries.length, queryCountBeforeInvalidInputs);

  const paginationHarness = createTimelineHarness([
    {
      _id: "timeline-c",
      status: "published",
      eventAt: new Date("2026-07-12T09:00:00+08:00"),
      content: "第三条"
    },
    {
      _id: "timeline-b",
      status: "published",
      eventAt: new Date("2026-07-13T09:00:00+08:00"),
      content: "第二条"
    },
    {
      _id: "timeline-a",
      status: "published",
      eventAt: new Date("2026-07-13T09:00:00+08:00"),
      content: "第一条"
    }
  ]);
  const firstPage = await paginationHarness.main({
    year: "2026",
    month: "07",
    limit: 2,
    offset: 0
  });
  const secondPage = await paginationHarness.main({
    year: "2026",
    month: "07",
    limit: 2,
    offset: firstPage.nextOffset
  });

  assert.deepStrictEqual(
    Array.from(firstPage.entries, (entry) => entry.id),
    ["timeline-b", "timeline-a"]
  );
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 2);
  assert.deepStrictEqual(
    Array.from(secondPage.entries, (entry) => entry.id),
    ["timeline-c"]
  );
  assert.strictEqual(secondPage.hasMore, false);
  assert.strictEqual(secondPage.nextOffset, null);

  const boundaryEntries = Array.from({ length: 10051 }, (_, index) => ({
    _id: `timeline-boundary-${String(index).padStart(5, "0")}`,
    status: "published",
    eventAt: new Date("2026-07-13T09:00:00+08:00"),
    content: `Boundary entry ${index}`
  }));
  const boundaryHarness = createTimelineHarness(boundaryEntries);
  const boundaryPage = await boundaryHarness.main({
    year: "2026",
    month: "07",
    limit: 50,
    offset: 10000
  });

  assert.strictEqual(boundaryPage.success, true);
  assert.strictEqual(boundaryPage.entries.length, 50);
  assert.strictEqual(boundaryPage.hasMore, false);
  assert.strictEqual(boundaryPage.nextOffset, null);
}

async function legacyTestAudioManifest() {
  const clientSourceHarness = createAudioManifestHarness();
  const clientSource = await clientSourceHarness.main({
    contentId: "audio-story",
    src: "https://client.example/audio.mp3"
  });

  assert.strictEqual(clientSource.success, false);
  assert.strictEqual(clientSource.code, "CLIENT_AUDIO_SOURCE_NOT_ALLOWED");
  assert.strictEqual(clientSourceHarness.queries.length, 0);

  const draftHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        status: "draft",
        currentRevision: 7,
        title: "未发布内容"
      }
    ]
  });
  const draft = await draftHarness.main({ contentId: "audio-story" });

  assert.strictEqual(draft.success, true);
  assert.strictEqual(draft.available, false);
  assert.strictEqual(draft.manifest, null);
  assert.strictEqual(
    draftHarness.queries.some((query) => query.name === "audioTracks"),
    false
  );

  const publishedHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        status: "published",
        currentRevision: 7,
        title: "正式音频"
      }
    ],
    tracks: [
      {
        _id: "track-two",
        contentId: "audio-story",
        contentRevision: 7,
        status: "published",
        title: "第二轨",
        trackNo: 2,
        fileID: "cloud://env/published/audio/track-two.mp3",
        mimeType: "audio/mpeg"
      },
      {
        _id: "track-draft",
        contentId: "audio-story",
        contentRevision: 7,
        status: "draft",
        title: "草稿音轨",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-draft.mp3"
      },
      {
        _id: "track-one",
        contentId: "audio-story",
        contentRevision: 7,
        status: "published",
        title: "第一轨",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-one.mp3",
        mimeType: "audio/mp4"
      },
      {
        _id: "track-unsafe",
        contentId: "audio-story",
        contentRevision: 7,
        status: "published",
        title: "外链音轨",
        trackNo: 3,
        fileID: "https://client.example/track.mp3"
      },
      {
        _id: "track-staging",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Staging track",
        trackNo: 4,
        fileID: "cloud://env/staging/audio/track.mp3",
        mimeType: "audio/mpeg"
      }
    ]
  });
  const published = await publishedHarness.main({
    contentId: "audio-story"
  });

  assert.strictEqual(published.success, true);
  assert.strictEqual(published.available, true);
  assert.strictEqual(published.manifest.contentId, "audio-story");
  assert.strictEqual(published.manifest.contentRevision, "7");
  assert.deepStrictEqual(
    Array.from(published.manifest.tracks, (track) => track.id),
    ["track-one", "track-two"]
  );
  const trackQuery = publishedHarness.queries.find(
    (query) => query.name === "audioTracks"
  );

  assert.strictEqual(trackQuery.filter.contentId, "audio-story");
  assert.strictEqual(trackQuery.filter.contentRevision, 7);
  assert.strictEqual(trackQuery.filter.status, "published");
}

async function testFamilyCenter() {
  const harness = createFamilyCenterHarness();
  const firstInvite = await harness.main({ action: "createInvite" });
  const firstTokenHash = crypto
    .createHash("sha256")
    .update(firstInvite.inviteToken)
    .digest("hex");
  const storedFirstInvite = harness.invites.get(firstTokenHash);

  assert.strictEqual(firstInvite.success, true);
  assert.match(firstInvite.inviteToken, /^[a-f0-9]{64}$/);
  assert.strictEqual(harness.invites.size, 1);
  assert.strictEqual(Boolean(storedFirstInvite), true);
  assert.strictEqual(harness.inviteCounters.size, 1);
  assert.strictEqual(
    Array.from(harness.inviteCounters.values())[0].inviteCount,
    1
  );
  assert.strictEqual(storedFirstInvite.inviteToken, undefined);
  assert.strictEqual(
    JSON.stringify(storedFirstInvite).includes(firstInvite.inviteToken),
    false
  );

  const repeatInviteHarness = createFamilyCenterHarness({
    failFamilyInviteCounterUpdate: true
  });
  const repeatFirstInvite = await repeatInviteHarness.main({
    action: "createInvite"
  });
  const originalCounterCreatedAt = Array.from(
    repeatInviteHarness.inviteCounters.values()
  )[0].createdAt;
  const repeatSecondInvite = await repeatInviteHarness.main({
    action: "createInvite"
  });
  const repeatedCounter = Array.from(
    repeatInviteHarness.inviteCounters.values()
  )[0];

  assert.strictEqual(repeatFirstInvite.success, true);
  assert.strictEqual(repeatSecondInvite.success, true);
  assert.notStrictEqual(
    repeatFirstInvite.inviteToken,
    repeatSecondInvite.inviteToken
  );
  assert.strictEqual(repeatInviteHarness.invites.size, 2);
  assert.strictEqual(repeatInviteHarness.inviteCounters.size, 1);
  assert.strictEqual(repeatedCounter.inviteCount, 2);
  assert.strictEqual(repeatedCounter.createdAt, originalCounterCreatedAt);
  assert.strictEqual(
    repeatInviteHarness.writes.some(
      (write) =>
        write.name === "familyInviteCounters" &&
        write.operation === "update"
    ),
    false
  );

  const voidResultHarness = createFamilyCenterHarness({
    transactionReturnsVoid: true
  });
  const recoveredVoidResult = await voidResultHarness.main({
    action: "createInvite"
  });

  assert.strictEqual(recoveredVoidResult.success, true);
  assert.match(recoveredVoidResult.inviteToken, /^[a-f0-9]{64}$/);
  assert.strictEqual(voidResultHarness.invites.size, 1);
  assert.strictEqual(voidResultHarness.inviteCounters.size, 1);

  const commitResponseHarness = createFamilyCenterHarness({
    transactionThrowsAfterCommit: true
  });
  const recoveredCommitResponse = await commitResponseHarness.main({
    action: "createInvite"
  });
  const recoveredCommitTokenHash = crypto
    .createHash("sha256")
    .update(recoveredCommitResponse.inviteToken)
    .digest("hex");

  assert.strictEqual(recoveredCommitResponse.success, true);
  assert.match(recoveredCommitResponse.inviteToken, /^[a-f0-9]{64}$/);
  assert.strictEqual(commitResponseHarness.invites.size, 1);
  assert.strictEqual(commitResponseHarness.inviteCounters.size, 1);
  assert.strictEqual(
    commitResponseHarness.invites.has(recoveredCommitTokenHash),
    true
  );

  const selfAccept = await harness.main({
    action: "acceptInvite",
    inviteToken: firstInvite.inviteToken
  });

  assert.strictEqual(selfAccept.success, false);
  assert.strictEqual(selfAccept.code, "SELF_INVITE");
  assert.strictEqual(storedFirstInvite.status, "pending");

  const expiredInvite = await harness.main({ action: "createInvite" });
  const expiredTokenHash = crypto
    .createHash("sha256")
    .update(expiredInvite.inviteToken)
    .digest("hex");

  harness.invites.get(expiredTokenHash).expiresAt = new Date(Date.now() - 1);
  harness.setOpenid("family-relative-a");

  const expiredAccept = await harness.main({
    action: "acceptInvite",
    inviteToken: expiredInvite.inviteToken
  });

  assert.strictEqual(expiredAccept.success, false);
  assert.strictEqual(expiredAccept.code, "INVITE_EXPIRED");
  assert.strictEqual(harness.invites.get(expiredTokenHash).status, "expired");
  assert.strictEqual(harness.relations.size, 0);

  harness.setOpenid("family-inviter");
  const acceptedInvite = await harness.main({ action: "createInvite" });

  harness.setOpenid("family-relative-a");
  const firstAccept = await harness.main({
    action: "acceptInvite",
    inviteToken: acceptedInvite.inviteToken
  });
  const repeatedAccept = await harness.main({
    action: "acceptInvite",
    inviteToken: acceptedInvite.inviteToken
  });

  assert.strictEqual(firstAccept.success, true);
  assert.strictEqual(firstAccept.alreadyAccepted, false);
  assert.strictEqual(repeatedAccept.success, true);
  assert.strictEqual(repeatedAccept.alreadyAccepted, true);
  assert.strictEqual(repeatedAccept.relationId, firstAccept.relationId);
  assert.strictEqual(harness.relations.size, 1);
  assert.strictEqual(harness.relationCounters.size, 2);
  assert.strictEqual(
    Array.from(harness.relationCounters.values()).every(
      (counter) => counter.activeCount === 1
    ),
    true
  );

  const relationCounterWritesBeforeReverseInvite = harness.writes.filter(
    (write) => write.name === "familyRelationCounters"
  ).length;
  const reverseInvite = await harness.main({ action: "createInvite" });
  const reverseTokenHash = crypto
    .createHash("sha256")
    .update(reverseInvite.inviteToken)
    .digest("hex");

  harness.setOpenid("family-inviter");
  const reverseAccept = await harness.main({
    action: "acceptInvite",
    inviteToken: reverseInvite.inviteToken
  });

  assert.strictEqual(reverseAccept.success, true);
  assert.strictEqual(reverseAccept.alreadyAccepted, true);
  assert.strictEqual(reverseAccept.relationId, firstAccept.relationId);
  assert.strictEqual(harness.relations.size, 1);
  assert.strictEqual(harness.relationCounters.size, 2);
  assert.strictEqual(
    harness.writes.filter((write) => write.name === "familyRelationCounters")
      .length,
    relationCounterWritesBeforeReverseInvite
  );
  assert.strictEqual(harness.invites.get(reverseTokenHash).status, "accepted");
  assert.strictEqual(
    harness.invites.get(reverseTokenHash).acceptedByUserId,
    "user-inviter"
  );

  harness.setOpenid("family-relative-b");
  const usedByAnotherUser = await harness.main({
    action: "acceptInvite",
    inviteToken: acceptedInvite.inviteToken
  });

  assert.strictEqual(usedByAnotherUser.success, false);
  assert.strictEqual(usedByAnotherUser.code, "INVITE_USED");
  assert.strictEqual(harness.relations.size, 1);

  harness.setOpenid("family-inviter");
  const familyList = await harness.main({ action: "list" });
  const familyListJson = JSON.stringify(familyList);

  assert.strictEqual(familyList.success, true);
  assert.strictEqual(familyList.familyMembers.length, 1);
  assert.strictEqual(
    Object.keys(familyList.familyMembers[0]).some((key) => /openid/i.test(key)),
    false
  );
  assert.strictEqual(familyListJson.includes("family-inviter"), false);
  assert.strictEqual(familyListJson.includes("family-relative-a"), false);

  const sharedGuardianOpenid = "shared-guardian";
  const sharedSessionId = createMemberSessionId(sharedGuardianOpenid);
  const siblingHarness = createFamilyCenterHarness({
    openid: sharedGuardianOpenid,
    users: [
      {
        _id: "shared-child-a",
        openid: sharedGuardianOpenid,
        registerStatus: "active",
        nickname: "孩子甲"
      },
      {
        _id: "shared-child-b",
        openid: sharedGuardianOpenid,
        registerStatus: "active",
        nickname: "孩子乙"
      },
      {
        _id: "shared-relative",
        openid: "shared-relative-openid",
        registerStatus: "active",
        nickname: "亲友"
      }
    ],
    sessions: [
      {
        _id: sharedSessionId,
        openid: sharedGuardianOpenid,
        userId: "shared-child-a",
        status: "active",
        expiresAt: new Date("2099-01-01T00:00:00.000Z")
      }
    ]
  });
  siblingHarness.relations.set("shared-child-a-relation", {
    _id: "shared-child-a-relation",
    memberUserId: "shared-child-a",
    relativeUserId: "shared-relative",
    memberDisplayName: "孩子甲",
    relativeDisplayName: "亲友",
    status: "active"
  });
  const childAFamily = await siblingHarness.main({ action: "list" });

  siblingHarness.sessions.get(sharedSessionId).userId = "shared-child-b";
  const childBFamily = await siblingHarness.main({ action: "list" });

  assert.strictEqual(childAFamily.success, true);
  assert.strictEqual(childAFamily.familyMembers.length, 1);
  assert.strictEqual(childBFamily.success, true);
  assert.strictEqual(childBFamily.familyMembers.length, 0);

  const limitedHarness = createFamilyCenterHarness();
  const limitedInvite = await limitedHarness.main({ action: "createInvite" });

  for (let index = 0; index < 50; index += 1) {
    limitedHarness.relations.set(`existing-${index}`, {
      _id: `existing-${index}`,
      memberUserId: "user-inviter",
      relativeUserId: `existing-relative-${index}`,
      status: "active"
    });
  }

  limitedHarness.setOpenid("family-relative-a");
  const limitedAccept = await limitedHarness.main({
    action: "acceptInvite",
    inviteToken: limitedInvite.inviteToken
  });

  assert.strictEqual(limitedAccept.success, false);
  assert.strictEqual(limitedAccept.code, "FAMILY_LIMIT_REACHED");
  assert.strictEqual(limitedHarness.relations.size, 50);

  const rateHarness = createFamilyCenterHarness();

  for (let index = 0; index < 20; index += 1) {
    const invite = await rateHarness.main({ action: "createInvite" });
    assert.strictEqual(invite.success, true);
  }

  const rateLimited = await rateHarness.main({ action: "createInvite" });
  assert.strictEqual(rateLimited.success, false);
  assert.strictEqual(rateLimited.code, "INVITE_RATE_LIMITED");
  assert.strictEqual(rateHarness.invites.size, 20);
  assert.strictEqual(
    Array.from(rateHarness.inviteCounters.values())[0].inviteCount,
    20
  );

  const legacyHarness = createFamilyCenterHarness({
    users: [
      {
        _id: "legacy-inviter",
        openid: "legacy-family-inviter",
        nickname: "Legacy member"
      },
      {
        _id: "legacy-relative",
        openid: "legacy-family-relative",
        nickname: "Legacy relative"
      }
    ],
    openid: "legacy-family-inviter"
  });
  const legacyInvite = await legacyHarness.main({ action: "createInvite" });

  legacyHarness.setOpenid("legacy-family-relative");
  const legacyAccept = await legacyHarness.main({
    action: "acceptInvite",
    inviteToken: legacyInvite.inviteToken
  });

  assert.strictEqual(legacyInvite.success, true);
  assert.strictEqual(legacyAccept.success, true);
  assert.strictEqual(legacyHarness.relations.size, 1);

  const unregisteredHarness = createFamilyCenterHarness({
    users: [
      {
        _id: "user-inviter",
        openid: "family-inviter",
        registerStatus: "active",
        nickname: "Member"
      }
    ]
  });
  const unregisteredInvite = await unregisteredHarness.main({
    action: "createInvite"
  });

  unregisteredHarness.setOpenid("unregistered-relative");
  const unregisteredAccept = await unregisteredHarness.main({
    action: "acceptInvite",
    inviteToken: unregisteredInvite.inviteToken
  });

  assert.strictEqual(unregisteredAccept.success, false);
  assert.strictEqual(unregisteredAccept.code, "MEMBER_LOGIN_REQUIRED");
  assert.strictEqual(unregisteredHarness.relations.size, 0);

  const deactivatedHarness = createFamilyCenterHarness();
  const deactivatedInvite = await deactivatedHarness.main({
    action: "createInvite"
  });
  const deactivatedTokenHash = crypto
    .createHash("sha256")
    .update(deactivatedInvite.inviteToken)
    .digest("hex");

  deactivatedHarness.setOpenid("family-relative-a");
  deactivatedHarness.setBeforeTransaction(() => {
    const acceptingUser = deactivatedHarness.users.find(
      (user) => user.openid === "family-relative-a"
    );
    acceptingUser.registerStatus = "inactive";
  });
  const deactivatedAccept = await deactivatedHarness.main({
    action: "acceptInvite",
    inviteToken: deactivatedInvite.inviteToken
  });

  assert.strictEqual(deactivatedAccept.success, false);
  assert.strictEqual(deactivatedAccept.code, "MEMBER_LOGIN_REQUIRED");
  assert.strictEqual(deactivatedHarness.relations.size, 0);
  assert.strictEqual(
    deactivatedHarness.invites.get(deactivatedTokenHash).status,
    "pending"
  );

  const collectionFailureHarness = createFamilyCenterHarness({
    documentReadFailure: {
      collection: "familyInvites",
      errCode: -502005,
      message: "collection does not exist"
    }
  });
  collectionFailureHarness.setOpenid("family-relative-a");
  const collectionFailure = await collectionFailureHarness.main({
    action: "acceptInvite",
    inviteToken: "a".repeat(64)
  });

  assert.strictEqual(collectionFailure.success, false);
  assert.strictEqual(collectionFailure.code, "FAMILY_CENTER_ERROR");
}

async function testMemberInbox() {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const harness = createMemberInboxHarness({
    messages: [
      {
        _id: "own-active",
        userId: "inbox-owner-user",
        status: "published",
        type: "notice",
        title: "当前消息",
        content: "只应返回给当前用户",
        publishedAt: new Date("2026-07-13T07:00:00.000Z"),
        expiresAt: future,
        internalSecret: "must-not-leak"
      },
      {
        _id: "other-active",
        userId: "inbox-other-user",
        status: "published",
        title: "其他用户消息",
        content: "不可越权读取",
        publishedAt: new Date("2026-07-13T08:00:00.000Z"),
        expiresAt: future
      },
      {
        _id: "own-expired",
        userId: "inbox-owner-user",
        status: "published",
        title: "过期消息",
        content: "不可返回",
        publishedAt: new Date("2026-07-13T09:00:00.000Z"),
        expiresAt: past
      },
      {
        _id: "own-draft",
        userId: "inbox-owner-user",
        status: "draft",
        title: "草稿消息",
        content: "不可返回",
        publishedAt: new Date("2026-07-13T10:00:00.000Z"),
        expiresAt: future
      }
    ]
  });
  const list = await harness.main({
    action: "list",
    limit: 50,
    openid: "inbox-other"
  });

  assert.strictEqual(list.success, true);
  assert.deepStrictEqual(
    Array.from(list.messages, (message) => message.id),
    ["own-active"]
  );
  assert.deepStrictEqual(Object.keys(list.messages[0]).sort(), [
    "content",
    "expiresAt",
    "id",
    "isRead",
    "publishedAt",
    "readAt",
    "title",
    "type"
  ]);
  assert.strictEqual(JSON.stringify(list).includes("inbox-owner"), false);
  assert.strictEqual(JSON.stringify(list).includes("inbox-other"), false);
  assert.strictEqual(JSON.stringify(list).includes("must-not-leak"), false);

  const sharedPublishedAt = new Date("2026-07-13T06:00:00.000Z");
  const paginationHarness = createMemberInboxHarness({
    messages: ["a", "b", "c"].map((suffix) => ({
      _id: `same-time-${suffix}`,
      userId: "inbox-owner-user",
      status: "published",
      title: `同刻消息 ${suffix}`,
      content: "分页不能遗漏",
      publishedAt: sharedPublishedAt,
      expiresAt: future
    }))
  });
  const firstPage = await paginationHarness.main({
    action: "list",
    limit: 2,
    offset: 0
  });
  const secondPage = await paginationHarness.main({
    action: "list",
    limit: 2,
    offset: firstPage.nextOffset
  });

  assert.deepStrictEqual(
    Array.from(
      new Set([...firstPage.messages, ...secondPage.messages].map((item) => item.id))
    ).sort(),
    ["same-time-a", "same-time-b", "same-time-c"]
  );
  assert.strictEqual(firstPage.nextOffset, 2);
  assert.strictEqual(secondPage.nextOffset, null);

  const otherMessage = await harness.main({
    action: "markRead",
    messageId: "other-active"
  });
  const expiredMessage = await harness.main({
    action: "markRead",
    messageId: "own-expired"
  });

  assert.strictEqual(otherMessage.success, false);
  assert.strictEqual(otherMessage.code, "MESSAGE_NOT_AVAILABLE");
  assert.strictEqual(expiredMessage.success, false);
  assert.strictEqual(expiredMessage.code, "MESSAGE_NOT_AVAILABLE");
  assert.strictEqual(harness.updates.length, 0);

  const firstRead = await harness.main({
    action: "markRead",
    messageId: "own-active"
  });
  const repeatedRead = await harness.main({
    action: "markRead",
    messageId: "own-active"
  });

  assert.strictEqual(firstRead.success, true);
  assert.strictEqual(firstRead.message.alreadyRead, false);
  assert.strictEqual(repeatedRead.success, true);
  assert.strictEqual(repeatedRead.message.alreadyRead, true);
  assert.strictEqual(harness.updates.length, 1);
  assert.strictEqual(harness.updates[0].documentId, "own-active");
  assert.strictEqual(Boolean(harness.messages.get("own-active").readAt), true);

  const sharedGuardianOpenid = "inbox-shared-guardian";
  const sharedSessionId = createMemberSessionId(sharedGuardianOpenid);
  const isolatedHarness = createMemberInboxHarness({
    openid: sharedGuardianOpenid,
    users: [
      {
        _id: "inbox-child-a",
        openid: sharedGuardianOpenid,
        memberId: "INBOXCHILDA01",
        registerStatus: "active"
      },
      {
        _id: "inbox-child-b",
        openid: sharedGuardianOpenid,
        memberId: "INBOXCHILDB01",
        registerStatus: "active"
      }
    ],
    sessions: [
      {
        _id: sharedSessionId,
        openid: sharedGuardianOpenid,
        userId: "inbox-child-a",
        status: "active",
        expiresAt: new Date("2099-01-01T00:00:00.000Z")
      }
    ],
    messages: [
      {
        _id: "child-a-message",
        userId: "inbox-child-a",
        status: "published",
        title: "甲的消息",
        content: "只属于甲",
        publishedAt: new Date("2026-07-13T07:00:00.000Z")
      },
      {
        _id: "child-b-message",
        userId: "inbox-child-b",
        status: "published",
        title: "乙的消息",
        content: "只属于乙",
        publishedAt: new Date("2026-07-13T07:00:00.000Z")
      }
    ]
  });
  const childAInbox = await isolatedHarness.main({ action: "list" });

  isolatedHarness.sessions.get(sharedSessionId).userId = "inbox-child-b";
  isolatedHarness.sessions.get(sharedSessionId).memberId = "INBOXCHILDB01";
  const childBInbox = await isolatedHarness.main({ action: "list" });

  assert.deepStrictEqual(
    Array.from(childAInbox.messages, (message) => message.id),
    ["child-a-message"]
  );
  assert.deepStrictEqual(
    Array.from(childBInbox.messages, (message) => message.id),
    ["child-b-message"]
  );
}

async function testContentDetail() {
  const memberHarness = createContentDetailHarness();
  const memberText = await memberHarness.main({ contentId: "published-story" });

  assert.strictEqual(memberText.success, true);
  assert.strictEqual(memberText.source, "cloud");
  assert.strictEqual(memberText.mode, "text");
  assert.strictEqual(memberText.content.id, "published-story");
  assert.strictEqual(memberText.content.sections.length, 1);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(memberText.content.accessPolicy)),
    { text: "member", audio: "member" }
  );
  assert.strictEqual(
    memberHarness.queries.some(
      (query) =>
        query.name === "memberSessions" &&
        query.operation === "doc" &&
        query.documentId === createMemberSessionId("detail-member")
    ),
    true
  );
  assert.strictEqual(
    memberHarness.queries.some(
      (query) =>
        query.name === "users" &&
        query.operation === "doc" &&
        query.documentId === "detail-user"
    ),
    true
  );

  const embeddedFileID =
    "cloud://env-id/protected/contents/published-story/assets/" +
    "0123456789abcdef0123456789abcdef/embedded/0001.png";
  const embeddedHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-2",
        status: "published",
        title: "Published story with image",
        embeddedAssets: [
          {
            id: "embedded-0001",
            order: 1,
            fileID: embeddedFileID,
            cloudPath:
              "protected/contents/published-story/assets/" +
              "0123456789abcdef0123456789abcdef/embedded/0001.png",
            extension: ".png",
            caption: "图片默认说明"
          }
        ],
        sections: [
          {
            kind: "story",
            heading: "图文正文",
            paragraphs: ["图片前", "图片后"],
            blocks: [
              { type: "text", text: "图片前" },
              {
                type: "image",
                embeddedAssetId: "embedded-0001",
                caption: "正文图片说明"
              },
              { type: "text", text: "图片后" }
            ]
          }
        ]
      }
    ]
  });
  const embeddedResult = await embeddedHarness.main({
    contentId: "published-story",
    mode: "text"
  });

  assert.strictEqual(embeddedResult.success, true);
  assert.deepStrictEqual(
    Array.from(
      embeddedResult.content.sections[0].blocks,
      (block) => block.type
    ),
    ["text", "image", "text"]
  );
  assert.strictEqual(
    embeddedResult.content.sections[0].blocks[1].src,
    "https://signed.example/display-1.png?token=test"
  );
  assert.strictEqual(
    embeddedResult.content.sections[0].blocks[1].caption,
    "正文图片说明"
  );
  assert.strictEqual(
    JSON.stringify(embeddedResult).includes("cloud://"),
    false
  );
  assert.strictEqual(
    JSON.stringify(embeddedResult).includes("fileID"),
    false
  );

  const missingSignedImageHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-2",
        status: "published",
        title: "Published story with image",
        embeddedAssets: [
          {
            id: "embedded-0001",
            order: 1,
            fileID: embeddedFileID,
            cloudPath:
              "protected/contents/published-story/assets/" +
              "0123456789abcdef0123456789abcdef/embedded/0001.png",
            extension: ".png"
          }
        ],
        sections: [
          {
            paragraphs: ["正文"],
            blocks: [
              { type: "text", text: "正文" },
              { type: "image", embeddedAssetId: "embedded-0001" }
            ]
          }
        ]
      }
    ],
    tempURLResponse: () => ({ fileList: [] })
  });
  const missingSignedImage = await missingSignedImageHarness.main({
    contentId: "published-story",
    mode: "text"
  });

  assert.strictEqual(missingSignedImage.success, false);
  assert.strictEqual(
    missingSignedImage.code,
    "CONTENT_ASSET_SIGN_FAILED"
  );

  const safeCover = "cloud://env-id/published/images/story-cover.png";
  const safeCoverHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-1",
        status: "published",
        title: "Published story",
        coverUrl: "https://example.com/untrusted-cover.png",
        coverFileId: safeCover
      }
    ]
  });
  const safeCoverResult = await safeCoverHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(safeCoverResult.success, true);
  assert.strictEqual(
    safeCoverResult.content.cover,
    "https://signed.example/display-1.png?token=test"
  );
  assert.strictEqual(JSON.stringify(safeCoverResult).includes("cloud://"), false);

  const unsignedCoverHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-1",
        status: "published",
        title: "Published story",
        coverFileId: safeCover
      }
    ],
    tempURL: false
  });
  const unsignedCoverResult = await unsignedCoverHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(unsignedCoverResult.success, true);
  assert.strictEqual(unsignedCoverResult.content.cover, "");
  assert.strictEqual(
    JSON.stringify(unsignedCoverResult).includes("cloud://"),
    false
  );

  const invalidSignedCoverHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-1",
        status: "published",
        title: "Published story",
        coverFileId: safeCover
      }
    ],
    tempURLResponse: (fileList) => ({
      fileList: fileList.map((fileID) => ({
        fileID,
        status: 0,
        tempFileURL: "http://signed.example/insecure.png"
      }))
    })
  });
  const invalidSignedCover = await invalidSignedCoverHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(invalidSignedCover.success, true);
  assert.strictEqual(invalidSignedCover.content.cover, "");

  const unsafeCoverHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        currentRevision: "revision-1",
        status: "published",
        title: "Published story",
        coverUrl: "cloud://env-id/published/images/bad name.png",
        coverFileId: "cloud://env-id\\published\\images\\bad.png",
        cover: "cloud://env-id/published/images/../private.png"
      }
    ]
  });
  const unsafeCoverResult = await unsafeCoverHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(unsafeCoverResult.success, true);
  assert.strictEqual(unsafeCoverResult.content.cover, "");

  const guestHarness = createContentDetailHarness({ openid: "" });
  const guestText = await guestHarness.main({ contentId: "published-story" });
  const guestAudio = await guestHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(guestText.success, false);
  assert.strictEqual(guestText.code, "OPENID_UNAVAILABLE");
  assert.strictEqual(guestAudio.success, false);
  assert.strictEqual(guestAudio.code, "OPENID_UNAVAILABLE");
  assert.strictEqual(JSON.stringify(guestAudio).includes("must-not-leak"), false);
  assert.strictEqual(JSON.stringify(guestAudio).includes("fileID"), false);

  const inactiveHarness = createContentDetailHarness({
    openid: "inactive-user",
    users: [
      {
        _id: "inactive-user-id",
        openid: "inactive-user",
        registerStatus: "inactive"
      }
    ]
  });
  const inactive = await inactiveHarness.main({
    contentId: "published-story",
    mode: "text"
  });

  assert.strictEqual(inactive.success, false);
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");
  assert.strictEqual(
    inactiveHarness.queries.some((query) => query.name === "contents"),
    false
  );

  const mismatchHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "different-story",
        status: "published"
      }
    ]
  });
  const mismatch = await mismatchHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(mismatch.success, false);
  assert.strictEqual(mismatch.code, "CONTENT_SCHEMA_INVALID");

  const emptyTextHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        status: "published",
        currentRevision: "revision-1",
        title: "Empty story",
        sections: []
      }
    ]
  });
  const emptyText = await emptyTextHarness.main({
    contentId: "published-story",
    mode: "text"
  });

  assert.strictEqual(emptyText.success, false);
  assert.strictEqual(emptyText.code, "CONTENT_SCHEMA_INVALID");

  const oversizedTextHarness = createContentDetailHarness({
    contents: [
      {
        _id: "published-story",
        contentId: "published-story",
        status: "published",
        currentRevision: "revision-1",
        title: "Oversized story",
        sections: [
          {
            heading: "Oversized",
            paragraphs: ["字".repeat(10001)]
          }
        ]
      }
    ]
  });
  const oversizedText = await oversizedTextHarness.main({
    contentId: "published-story",
    mode: "text"
  });

  assert.strictEqual(oversizedText.success, false);
  assert.strictEqual(oversizedText.code, "CONTENT_SCHEMA_INVALID");

  const missingHarness = createContentDetailHarness({ contents: [] });
  const missing = await missingHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(missing.success, false);
  assert.strictEqual(missing.code, "CONTENT_NOT_FOUND");

  const databaseError = new Error("database offline");
  databaseError.code = "DATABASE_REQUEST_FAILED";
  const errorHarness = createContentDetailHarness({
    contentReadError: databaseError
  });
  const failed = await errorHarness.main({
    contentId: "published-story",
    mode: "audio"
  });

  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.code, "CONTENT_READ_FAILED");
}

async function testContentCatalog() {
  const emptyHarness = createCatalogHarness({ contents: [] });
  const empty = await emptyHarness.main({ view: "summary" });

  assert.strictEqual(empty.success, true);
  assert.strictEqual(empty.source, "cloud");
  assert.strictEqual(empty.view, "summary");
  assert.deepStrictEqual(Array.from(empty.items), []);

  const errorHarness = createCatalogHarness({ contentsMissing: true });
  const failed = await errorHarness.main({ view: "summary" });

  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.code, "CONTENT_CATALOG_READ_FAILED");
  assert.strictEqual(failed.source, "cloud");
  assert.deepStrictEqual(Array.from(failed.items), []);

  const stateErrorHarness = createCatalogHarness({
    contents: [
      {
        _id: "state-error-story",
        contentId: "state-error-story",
        status: "published",
        currentRevision: "revision-1",
        title: "State error story",
        catalogViews: ["summary"]
      }
    ],
    readingStatesMissing: true
  });
  const stateFailure = await stateErrorHarness.main({ view: "summary" });

  assert.strictEqual(stateFailure.success, false);
  assert.strictEqual(stateFailure.code, "CONTENT_CATALOG_READ_FAILED");
  assert.deepStrictEqual(Array.from(stateFailure.items), []);

  const readAt = "2026-07-13T08:00:00.000Z";
  const harness = createCatalogHarness({
    contents: [
      {
        _id: "published-later",
        contentId: "published-later",
        status: "published",
        currentRevision: "revision-1",
        title: "Published later",
        catalogViews: ["book"],
        coverFileId: "cloud://env-id/published/images/../private.png",
        sortOrder: 20
      },
      {
        _id: "draft-hidden",
        contentId: "draft-hidden",
        status: "draft",
        title: "Draft content",
        catalogViews: ["book"],
        sortOrder: 0
      },
      {
        _id: "published-first",
        contentId: "published-first",
        status: "published",
        currentRevision: "revision-1",
        title: "Published first",
        catalogViews: ["book"],
        coverUrl: "https://example.com/untrusted-cover.png",
        coverFileId: "cloud://env-id/published/images/catalog-cover.png",
        sortOrder: 10
      }
    ],
    readingStates: [
      {
        userId: "reader-catalog-user",
        contentId: "published-first",
        contentRevision: "revision-1",
        lastReadAt: readAt
      },
      {
        userId: "another-reader-user",
        contentId: "published-later",
        contentRevision: "revision-1",
        lastReadAt: "ignored"
      }
    ]
  });
  const result = await harness.main({ view: "book" });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.source, "cloud");
  assert.deepStrictEqual(
    Array.from(result.items, (item) => item.id),
    ["published-first", "published-later"]
  );
  assert.strictEqual(result.items.some((item) => item.id === "draft-hidden"), false);
  assert.strictEqual(result.items[0].viewed, true);
  assert.strictEqual(result.items[0].readAt, readAt);
  assert.strictEqual(
    result.items[0].cover,
    "https://signed.example/display-1.png?token=test"
  );
  assert.strictEqual(JSON.stringify(result).includes("cloud://"), false);
  assert.strictEqual(result.items[1].viewed, false);
  assert.strictEqual(result.items[1].cover, "");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(result.items[0].accessPolicy)),
    { text: "member", audio: "member" }
  );

  const unsignedCatalogHarness = createCatalogHarness({
    contents: [
      {
        _id: "unsigned-cover",
        contentId: "unsigned-cover",
        status: "published",
        currentRevision: "revision-1",
        title: "Unsigned cover",
        catalogViews: ["book"],
        coverFileId: "cloud://env-id/published/images/unsigned-cover.png",
        sortOrder: 1
      }
    ],
    tempURL: false
  });
  const unsignedCatalog = await unsignedCatalogHarness.main({ view: "book" });

  assert.strictEqual(unsignedCatalog.success, true);
  assert.strictEqual(unsignedCatalog.items[0].cover, "");
  assert.strictEqual(JSON.stringify(unsignedCatalog).includes("cloud://"), false);

  const isolatedSummary = await harness.main({ view: "summary" });
  assert.strictEqual(isolatedSummary.view, "summary");
  assert.strictEqual(isolatedSummary.source, "cloud");
  assert.deepStrictEqual(Array.from(isolatedSummary.items), []);

  const defaultViewHarness = createCatalogHarness({
    contents: [
      {
        _id: "summary-by-default",
        contentId: "summary-by-default",
        status: "published",
        currentRevision: "revision-1",
        title: "Default summary content",
        catalogViews: ["summary"],
        sortOrder: 0
      }
    ]
  });
  const defaultSummary = await defaultViewHarness.main({});
  const isolatedBook = await defaultViewHarness.main({ catalogView: "book" });

  assert.strictEqual(defaultSummary.view, "summary");
  assert.strictEqual(defaultSummary.source, "cloud");
  assert.deepStrictEqual(
    Array.from(defaultSummary.items, (item) => item.id),
    ["summary-by-default"]
  );
  assert.strictEqual(isolatedBook.view, "book");
  assert.strictEqual(isolatedBook.source, "cloud");
  assert.deepStrictEqual(Array.from(isolatedBook.items), []);

  const schemaHarness = createCatalogHarness({
    contents: [
      {
        _id: "stable-id",
        contentId: "unstable-id",
        status: "published",
        currentRevision: "revision-1",
        title: "Invalid schema",
        catalogViews: ["summary"]
      }
    ]
  });
  const invalidSchema = await schemaHarness.main({ view: "summary" });

  assert.strictEqual(invalidSchema.success, false);
  assert.strictEqual(invalidSchema.code, "CONTENT_SCHEMA_INVALID");
  assert.deepStrictEqual(Array.from(invalidSchema.items), []);

  const contentQuery = harness.queries.find(
    (query) => query.name === "contents"
  );
  const stateQuery = harness.queries.find(
    (query) => query.name === "readingStates"
  );

  assert.strictEqual(contentQuery.filter.status, "published");
  assert.deepStrictEqual(
    Array.from(contentQuery.filter.catalogViews.__all),
    ["book"]
  );
  assert.strictEqual(stateQuery.filter.userId, "reader-catalog-user");
  assert.deepStrictEqual(
    Array.from(stateQuery.filter.contentId.__in),
    ["published-first", "published-later"]
  );
  assert.strictEqual(contentQuery.limit, 31);
  assert.deepStrictEqual(contentQuery.orderBy, [
    { field: "sortOrder", direction: "asc" },
    { field: "_id", direction: "asc" }
  ]);

  const paginationHarness = createCatalogHarness({
    contents: [
      {
        _id: "page-three",
        contentId: "page-three",
        status: "published",
        currentRevision: "revision-1",
        title: "Page three",
        catalogViews: ["summary"],
        sortOrder: 3
      },
      {
        _id: "page-one",
        contentId: "page-one",
        status: "published",
        currentRevision: "revision-1",
        title: "Page one",
        catalogViews: ["summary"],
        sortOrder: 1
      },
      {
        _id: "page-two",
        contentId: "page-two",
        status: "published",
        currentRevision: "revision-1",
        title: "Page two",
        catalogViews: ["summary"],
        sortOrder: 2
      }
    ]
  });
  const firstPage = await paginationHarness.main({
    view: "summary",
    limit: 2
  });
  const secondPage = await paginationHarness.main({
    view: "summary",
    limit: 2,
    offset: firstPage.nextOffset
  });

  assert.deepStrictEqual(
    Array.from(firstPage.items, (item) => item.id),
    ["page-one", "page-two"]
  );
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 2);
  assert.deepStrictEqual(
    Array.from(secondPage.items, (item) => item.id),
    ["page-three"]
  );
  assert.strictEqual(secondPage.hasMore, false);
  assert.strictEqual(secondPage.nextOffset, null);

  const boundaryContents = Array.from({ length: 10051 }, (_, index) => {
    const contentId = `catalog-boundary-${String(index).padStart(5, "0")}`;

    return {
      _id: contentId,
      contentId,
      status: "published",
      currentRevision: "revision-1",
      title: `Boundary content ${index}`,
      catalogViews: ["summary"],
      sortOrder: index
    };
  });
  const boundaryHarness = createCatalogHarness({
    contents: boundaryContents
  });
  const boundaryPage = await boundaryHarness.main({
    view: "summary",
    limit: 50,
    offset: 10000
  });

  assert.strictEqual(boundaryPage.success, true);
  assert.strictEqual(boundaryPage.items.length, 50);
  assert.strictEqual(boundaryPage.hasMore, false);
  assert.strictEqual(boundaryPage.nextOffset, null);
}

async function testMarkContentRead() {
  const harness = createMarkContentReadHarness();
  const first = await harness.main({
    contentId: harness.contentId,
    contentRevision: harness.contentRevision
  });
  const expectedId = crypto
    .createHash("sha256")
    .update(
      JSON.stringify(["reading-state", harness.userId, harness.contentId])
    )
    .digest("hex")
    .slice(0, 32);
  const firstReadAt = harness.states.get(expectedId).firstReadAt;
  const second = await harness.main({
    contentId: harness.contentId,
    contentRevision: harness.contentRevision
  });

  assert.strictEqual(first.success, true);
  assert.strictEqual(first.state.firstRead, true);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.state.firstRead, false);
  assert.strictEqual(harness.states.size, 1);
  assert.strictEqual(harness.writes.length, 2);
  assert.strictEqual(harness.writes[0].operation, "set");
  assert.strictEqual(harness.writes[1].operation, "update");
  assert.strictEqual(harness.writes[0].documentId, expectedId);
  assert.strictEqual(harness.writes[1].documentId, expectedId);
  assert.strictEqual(harness.states.get(expectedId).openid, harness.openid);
  assert.strictEqual(harness.states.get(expectedId).contentId, harness.contentId);
  assert.strictEqual(harness.states.get(expectedId).firstReadAt, firstReadAt);
  assert.strictEqual(harness.transactionCalls, 2);

  const wrappedHarness = createMarkContentReadHarness({
    wrapTransactionResult: true
  });
  const wrapped = await wrappedHarness.main({
    contentId: wrappedHarness.contentId,
    contentRevision: wrappedHarness.contentRevision
  });

  assert.strictEqual(wrapped.success, true);
  assert.strictEqual(wrapped.state.firstRead, true);

  const stateReadError = new Error("database offline");
  stateReadError.code = "DATABASE_REQUEST_FAILED";
  const stateErrorHarness = createMarkContentReadHarness({ stateReadError });
  const stateFailure = await stateErrorHarness.main({
    contentId: stateErrorHarness.contentId,
    contentRevision: stateErrorHarness.contentRevision
  });

  assert.strictEqual(stateFailure.success, false);
  assert.strictEqual(stateFailure.code, "READ_STATE_UNAVAILABLE");
  assert.strictEqual(stateErrorHarness.transactionCalls, 1);
  assert.strictEqual(stateErrorHarness.writes.length, 0);

  const inactiveHarness = createMarkContentReadHarness({
    users: [
      {
        _id: "inactive-reader-user",
        openid: "reader-mark",
        memberId: "INACTIVEREADER01",
        registerStatus: "inactive"
      }
    ]
  });
  const inactive = await inactiveHarness.main({
    contentId: inactiveHarness.contentId,
    contentRevision: inactiveHarness.contentRevision
  });

  assert.strictEqual(inactive.success, false);
  assert.strictEqual(inactive.code, "ACCOUNT_INACTIVE");
  assert.strictEqual(inactiveHarness.transactionCalls, 1);

  const missingOpenidHarness = createMarkContentReadHarness({ openid: "" });
  const missingOpenid = await missingOpenidHarness.main({
    contentId: missingOpenidHarness.contentId,
    contentRevision: missingOpenidHarness.contentRevision
  });

  assert.strictEqual(missingOpenid.success, false);
  assert.strictEqual(missingOpenid.code, "OPENID_UNAVAILABLE");
  assert.strictEqual(missingOpenidHarness.transactionCalls, 0);

  const missingContentHarness = createMarkContentReadHarness({ content: null });
  const missingContent = await missingContentHarness.main({
    contentId: missingContentHarness.contentId,
    contentRevision: missingContentHarness.contentRevision
  });

  assert.strictEqual(missingContent.success, false);
  assert.strictEqual(missingContent.code, "CONTENT_NOT_PUBLISHED");
  assert.strictEqual(missingContentHarness.transactionCalls, 1);
}

async function testAudioManifest() {
  const clientSourceHarness = createAudioManifestHarness();
  const clientSource = await clientSourceHarness.main({
    contentId: "audio-story",
    src: "https://client.example/audio.mp3"
  });

  assert.strictEqual(clientSource.success, false);
  assert.strictEqual(clientSource.code, "CLIENT_AUDIO_SOURCE_NOT_ALLOWED");
  assert.strictEqual(clientSourceHarness.queries.length, 0);

  const draftAudioHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        contentId: "audio-story",
        status: "published",
        audioStatus: "draft",
        currentRevision: "revision-7",
        title: "Unpublished audio"
      }
    ]
  });
  const draftAudio = await draftAudioHarness.main({ contentId: "audio-story" });

  assert.strictEqual(draftAudio.success, true);
  assert.strictEqual(draftAudio.available, false);
  assert.strictEqual(draftAudio.manifest, null);
  assert.strictEqual(
    draftAudioHarness.queries.some((query) => query.name === "audioTracks"),
    false
  );

  const publishedHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        contentId: "audio-story",
        status: "published",
        audioStatus: "published",
        currentRevision: "revision-7",
        publishedAudioTrackCount: 2,
        title: "Published audio"
      }
    ],
    tracks: [
      {
        _id: "track-two",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Track two",
        trackNo: 2,
        fileID: "cloud://env/published/audio/track-two.mp3",
        mimeType: "audio/mpeg"
      },
      {
        _id: "track-draft",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "draft",
        title: "Draft track",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-draft.mp3"
      },
      {
        _id: "track-old",
        contentId: "audio-story",
        contentRevision: "revision-6",
        status: "published",
        title: "Old revision track",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-old.mp3"
      },
      {
        _id: "track-one",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Track one",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-one.mp3",
        mimeType: "audio/mp4"
      },
      {
        _id: "track-unsafe",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Unsafe track",
        trackNo: 3,
        fileID: "https://client.example/track.mp3"
      },
      {
        _id: "track-staging",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Staging track",
        trackNo: 4,
        fileID: "cloud://env/staging/audio/track.mp3",
        mimeType: "audio/mpeg"
      }
    ]
  });
  const published = await publishedHarness.main({ contentId: "audio-story" });

  assert.strictEqual(published.success, true);
  assert.strictEqual(published.available, true);
  assert.strictEqual(published.manifest.contentId, "audio-story");
  assert.strictEqual(published.manifest.contentRevision, "revision-7");
  assert.deepStrictEqual(
    Array.from(published.manifest.tracks, (track) => track.id),
    ["track-one", "track-two"]
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(published.manifest.accessPolicy)),
    { text: "member", audio: "member" }
  );
  assert.strictEqual(
    published.manifest.tracks.every(
      (track) =>
        typeof track.src === "string" &&
        track.src.startsWith("https://signed.example/") &&
        !Object.prototype.hasOwnProperty.call(track, "fileID")
    ),
    true
  );

  const guestHarness = createAudioManifestHarness({ openid: "" });
  const guest = await guestHarness.main({ contentId: "audio-story" });

  assert.strictEqual(guest.success, false);
  assert.strictEqual(guest.code, "MEMBER_LOGIN_REQUIRED");
  assert.strictEqual(
    guestHarness.queries.some((query) => query.name === "contents"),
    false
  );

  const trackQuery = publishedHarness.queries.find(
    (query) => query.name === "audioTracks"
  );

  assert.strictEqual(trackQuery.filter.contentId, "audio-story");
  assert.strictEqual(trackQuery.filter.contentRevision, "revision-7");
  assert.strictEqual(trackQuery.filter.status, "published");
  assert.deepStrictEqual(trackQuery.orderBy, [
    { field: "trackNo", direction: "asc" },
    { field: "_id", direction: "asc" }
  ]);

  const versionedHarness = createAudioManifestHarness({
    contents: [{
      _id: "audio-story",
      contentId: "audio-story",
      status: "published",
      audioStatus: "published",
      currentRevision: "revision-7",
      audioRevision: "audio-revision-2",
      publishedAudioTrackCount: 1,
      title: "Replacement audio"
    }],
    tracks: [{
      _id: "legacy-track",
      contentId: "audio-story",
      contentRevision: "revision-7",
      status: "published",
      title: "Legacy track",
      trackNo: 1,
      fileID: "cloud://env/published/audio/legacy.mp3",
      mimeType: "audio/mpeg"
    }, {
      _id: "audio-story-primary",
      contentId: "audio-story",
      contentRevision: "revision-7",
      audioRevision: "audio-revision-2",
      status: "published",
      title: "Current track",
      trackNo: 1,
      fileID: "cloud://env/published/audio/current.mp3",
      mimeType: "audio/mpeg"
    }]
  });
  const versioned = await versionedHarness.main({ contentId: "audio-story" });
  assert.strictEqual(versioned.success, true);
  assert.strictEqual(versioned.available, true);
  assert.strictEqual(versioned.manifest.audioRevision, "audio-revision-2");
  assert.deepStrictEqual(
    Array.from(versioned.manifest.tracks, (track) => track.id),
    ["audio-story-primary"]
  );
  assert.strictEqual(
    versionedHarness.queries.find((query) => query.name === "audioTracks")
      .filter.audioRevision,
    "audio-revision-2"
  );

  const countMismatchHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        contentId: "audio-story",
        status: "published",
        audioStatus: "published",
        currentRevision: "revision-7",
        publishedAudioTrackCount: 2,
        title: "Incomplete audio"
      }
    ],
    tracks: [
      {
        _id: "track-one",
        contentId: "audio-story",
        contentRevision: "revision-7",
        status: "published",
        title: "Track one",
        trackNo: 1,
        fileID: "cloud://env/published/audio/track-one.mp3",
        mimeType: "audio/mpeg"
      }
    ]
  });
  const countMismatch = await countMismatchHarness.main({
    contentId: "audio-story"
  });

  assert.strictEqual(countMismatch.success, true);
  assert.strictEqual(countMismatch.available, false);
  assert.strictEqual(countMismatch.manifest, null);

  const mismatchHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        contentId: "different-story",
        status: "published",
        audioStatus: "published",
        currentRevision: "revision-7",
        publishedAudioTrackCount: 1
      }
    ]
  });
  const mismatch = await mismatchHarness.main({ contentId: "audio-story" });

  assert.strictEqual(mismatch.success, false);
  assert.strictEqual(mismatch.code, "CONTENT_SCHEMA_INVALID");

  const databaseError = new Error("database offline");
  databaseError.code = "DATABASE_REQUEST_FAILED";
  const errorHarness = createAudioManifestHarness({
    contentReadError: databaseError
  });
  const failed = await errorHarness.main({ contentId: "audio-story" });

  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.code, "AUDIO_MANIFEST_READ_FAILED");

  const trackErrorHarness = createAudioManifestHarness({
    contents: [
      {
        _id: "audio-story",
        contentId: "audio-story",
        status: "published",
        audioStatus: "published",
        currentRevision: "revision-7",
        publishedAudioTrackCount: 1
      }
    ],
    trackReadError: databaseError
  });
  const trackFailure = await trackErrorHarness.main({
    contentId: "audio-story"
  });

  assert.strictEqual(trackFailure.success, false);
  assert.strictEqual(trackFailure.code, "AUDIO_MANIFEST_READ_FAILED");
}

async function run() {
  await testContentDetail();
  await testContentCatalog();
  await testMarkContentRead();
  await testYouthTimeline();
  await testAudioManifest();
  await testFamilyCenter();
  await testMemberInbox();
  console.log(
    "后端服务测试通过：内容/阅读、少年志、音频、亲友邀请与会员消息安全边界。"
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
