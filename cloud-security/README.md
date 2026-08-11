# 云端权限基线

本目录保存目标云环境必须满足的最小权限配置，不包含密钥：

- `database-access.manifest.json`：30 个业务集合均为 `ADMINONLY`，小程序客户端不得直接读写。
- `database-indexes.manifest.json`：与当前复合查询对应的人工控制台建索引清单；它不是可直接导入或自动部署的配置。
- `function-invoke-rules.json`：通配规则默认拒绝，只允许已登录微信用户调用仓库中的 17 个云函数。
- `storage-access-rules.json`：对应免费版“仅创建者可读写”，并按 CloudBase 官方模板同时兼容小程序 `auth.openid` 与其他客户端 `auth.uid`。它只用于无 HTTPS 上传代理时的管理员直传回退；展示封面、展示图片和所有受保护媒体仍只能由服务端鉴权后签发短期 HTTPS 地址。

运行以下检查可发现新增云函数、云函数源码引用集合、人工索引关键集合、SDK 版本或本地安全规则发生漂移：

```shell
npm run test:security
```

检查会递归扫描每个云函数的 JavaScript 源码，但本地文件不能证明规则和索引已在云端生效。首次部署、切换环境、创建集合、创建索引或调整存储路径后，必须在目标环境控制台逐项核验；规则修改后还应等待生效并进行客户端拒绝测试，索引则应等待状态正常后执行真实查询。

整书上传新增的人工索引只有两条：`contents(bookId asc, status asc, sortOrder asc, _id asc)` 和 `books(status asc, publishedAt desc, _id desc)`。前者用于首次整书发布从已发布正文生成章节，后者用于管理员书目选择器。

`register` 需要环境变量 `GUARDIAN_PHONE_CLAIM_SECRET`，值至少 32 个随机字符且长期保持不变。它仅用于监护人手机号 HMAC 占位索引，不能放入小程序、仓库或日志。

`moderationCenter` 还会查询 `adminAccounts`，只接受 `status: "active"` 且角色为 `moderator`、`content-reviewer` 或 `admin` 的调用者。该集合只能由可信控制台或后续管理员后台维护，不能提供客户端自助写入入口。待审列表使用 `records.status + submittedAt(desc) + _id(desc)` 索引；复审提交必须携带列表返回的 `commentHash`，防止管理员误审已被读者覆盖的旧稿。

`adminContentCenter` 按最小职责拆分角色：活动 `uploader` 只能上传、建稿和编辑；`content-reviewer` 只能读取审核队列、打开当前快照原件并复核；只有 `admin` 能正式发布。管理员账号以微信 `openid` 绑定，不另存一套弱密码；在可信控制台按 `admin-account.example.json` 创建后才会出现对应能力。`moderator` 仍只复审读后感，不能上传素材。停用账号时把 `status` 改为 `disabled`。

大文件不能塞进云函数调用参数。配置了 `ADMIN_UPLOAD_BROKER_URL` 时，`adminContentCenter` 仍优先创建 15 分钟、单文件、单路径的一次性预约并保存票据哈希；小程序使用 `wx.uploadFile` 把文件交给 `services/admin-upload-broker`，代理重验预约、实际字节、摘要和文件结构后，以服务端身份写入精确私有路径。票据明文不得写入数据库或日志。

免费环境没有上传代理时，`adminContentCenter` 回退为 `cloud-storage-direct`。对于书稿和小专题 DOCX，已绑定的活动 `uploader/admin` 取得的是 `client-manifest-only` 预约：小程序在本机解析 Word 后直接调用 `attachClientManifest`，不再用 `wx.cloud.uploadFile` 重复上传或保存原 DOCX，也不调用 `confirmUpload`。预约保持 `pending_upload + direct_manifest_reserved + awaiting_client_manifest + not_uploaded`；清单请求受 CloudBase 调用参数上限约束，服务端还会对规范化后的清单执行 700 KB 硬限制，完成以前不能建稿、审核或发布。无内嵌图片的清单可进入 `client_manifest_validated`。含内嵌图片时进入 `awaiting_client_images`，服务端按清单顺序返回精确、持久的 `protected/contents/<contentId>/assets/<uploadId>/embedded/<order>.<ext>` 或 `protected/special-topics/<topicId>/assets/<uploadId>/embedded/<order>.<ext>` 上传计划；客户端每次最多把 20 个已上传对象交给 `confirmClientImages`。该动作必须逐项匹配预约所有者、上传编号、图片顺序、包内路径、扩展名、云环境、完整文件 ID 和精确云路径，并确认对象存在；首批确认会锁定云环境，后续跨环境对象会被拒绝。相同 `requestId` 与同一批数据可安全重放，换批重放会被拒绝。只有全部图片确认后才进入 `uploaded + client_manifest_validated` 并允许建稿。

少年志与少年爱题目不经过文件上传。`createEditorialDraft` 仅允许活动 `uploader/admin` 创建 `sourceKind=structured-form` 的结构化草稿，并以请求编号幂等；草稿必须完成保存、送审、结构化预览审计、独立批准和管理员发布后，才会写入 `zhiEntries` 或 `quizQuestions` 的 `published` 文档及不可变发布修订。

直传录音不能依赖 3 秒云函数再复制最高 500 MB 文件，因此预约直接绑定精确 `published/audio/<contentId>/assets/<uploadId>/primary.<ext>` 持久路径。50 MB 以内整书 PDF 同样直接绑定 `protected/books/<bookId>/assets/<uploadId>/<bookId>.pdf`，不再错误进入 DOCX 清单状态。`confirmUpload` 仍只记录对象存在、精确路径和可信管理员确认，状态为 `admin_attested_unverified`，不声称校验了实际字节、摘要、文件签名或结构。音频 `clientDurationSeconds` 仅接受有限数、`> 0` 且 `<= 86400`，作为当前管理员在微信客户端测得的时长证明；中转代理有真实 inspection 时始终以服务端检查结果为准。数据库正式发布指针建立前，读者云函数不得返回这些对象；录音/PDF 仍必须经过草稿、完整试听/预览、独立复核和管理员正式发布。

首次整书 PDF 使用 `from-published-contents`，按同一 `bookId` 下 `status=published` 的正文 `sortOrder, _id` 生成章节；至少要有一篇完整已发布正文。后续 PDF 使用 `reuse-current`。旧的 `replace + chapters` 草稿仍可继续审核发布，但免费管理员页面不再要求填写技术章节编号。已知“食管癌的故事”章节示例的文件名和 SHA-256 会被整书链路拒绝。

取消上传时，服务端会按精确计划收集原始文件、已确认图片以及尚未确认但可能已直传的图片路径，以每批最多 50 个对象执行删除；删除失败会保留清理待办供重试。已绑定到草稿并发布的专题图片使用持久受保护路径，不依赖临时暂存目录；发布前还会重新检查全部图片对象存在且草稿中的 `embeddedAssets` 与正文引用完全一致。

“仅创建者可读写”是免费版的桶级预设，无法读取 `adminAccounts` 来逐次判断管理员角色，也无法在存储规则层强制一次性预约。因此任何已登录小程序用户理论上都能向自己创建的任意路径占用存储配额，且上传后未完成确认的图片/文件可能成为孤儿对象。正式运营必须配置存储用量告警和定期孤儿清理；预算允许时可启用 HTTPS 上传代理并恢复客户端存储全拒绝基线。

审核快照绑定源文件摘要、精确预备资源路径、扩展名、MIME 和结构检查结果。`adminDraftPreviewAudits` 记录某位复核员已打开对应快照的事实；没有同一复核员、同一快照的预览记录不得批准。临时预览地址按文件项申请 300 秒有效期，响应不得包含永久云路径。

`contents.pendingReviewCount` 是正文覆盖发布的事务锁，不是展示缓存。`saveRecord` 新增/移出待复审状态、`moderationCenter` 完成复审以及 `adminContentCenter` 覆盖正文必须在各自事务中读写同一个 `contents` 文档；字段缺失、负数或与现有数据不一致时一律停止覆盖。旧环境应先停写、按 `records.status == pending_review` 回填并核对，再开放新版本。

正式资源路径约定：

- `published/images/app-home/v1/...`：固定 6 张首页图片；只由活动 `admin` 重复调用 `adminContentCenter.seedHomeAssets` 分次写入，固定清单保存为 `publicAssets/app-home-v1`，普通客户端经 `getContentCatalog.homeAssets` 取得短期 HTTPS 地址
- `published/images/<content-or-topic>/<revision>/...`：正式展示封面与图片；云函数核验发布状态和调用者身份后签发短期 HTTPS 地址
- `published/audio/<contentId>/assets/<uploadId>/primary.<ext>`：仅活动少年会员经 `getAudioManifest` 获取短期地址
- `protected/special-topics/<topicId>/assets/<uploadId>/images/...`：单独上传并审核的专题图片；仅已解锁会员经 `specialTopicCenter` 获取短期地址
- `protected/special-topics/<topicId>/assets/<uploadId>/embedded/...`：专题 DOCX 内嵌图片；按服务端计划逐项确认并随草稿快照、发布修订保留，仅已解锁会员可获取短期地址
- `protected/contents/<contentId>/assets/<uploadId>/embedded/...`：书稿 DOCX 行内图片；按服务端计划逐项确认并随正文快照、发布修订保留，仅活动少年会员可获取短期地址
- `protected/books/<bookId>/assets/<uploadId>/<bookId>.pdf`：仅持有整书权限的会员经 `getFullBookAccess` 获取短期 PDF 地址
- `admin-staging/<owner-hash>/<upload-id>/source.<ext>`：上传代理写入的原始素材；仅服务端可访问，上传后仍是待验证、待审核状态
- `admin-direct-staging/<owner-hash>/<upload-id>/source.<ext>`：旧版或兼容直传的私有原始素材路径；当前免费 Word 导入不会创建该对象
- 草稿、原稿、解析中间文件和审核附件不得放入 `published/`，也不得允许客户端直读或写入

“仅创建者可读写”只允许客户端访问自己创建的对象，不影响云函数和控制台的服务端权限，也不代表素材已通过业务审核。每个云函数仍须先校验 `memberSessions`、当前 `userId`、资源归属、发布状态或解锁资格，再返回有时效的 HTTPS 地址；响应不得把永久 `cloud://` 文件 ID 当作可访问地址交给普通读者客户端。管理员导入/直传必须先取得服务端预约，并经过后续草稿、结构化发布效果或原件预览以及独立审核；未经批准不得建立面向读者的数据库发布指针。
