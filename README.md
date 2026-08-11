# 中国医院船微信小程序

这是《中国医院船》少年阅读小程序的开发版本，使用微信小程序原生框架与微信云开发。

当前代码已覆盖五栏导航、少年会员注册/登录/切换/找回密码、云端内容目录与正文、会员配音、打开正文即记录已阅读、读后感自动审核与服务端人工复审、红五星与徽章、整书阅读及 PDF 权限、小专题按次解锁、少年爱答题记录、少年志、亲友关系和会员消息。管理员身份、私有上传、文件结构校验、内容草稿、原件或结构化发布效果预览、独立复核和带修订冲突保护的正式发布前后端也已接入；书稿和小专题 DOCX 已覆盖本机提取、结构化清单提交、内嵌图持久云路径直传与分批确认、草稿引用、发布复验、会员端按原顺序渲染和取消清理。复杂 DOCX/PDF 版式与表格自动解析和目标云环境部署仍未完成；`testarticle/` 与 `seed-data/` 只是录入来源和草稿种子，不能直接当作已发布内容。

## 目录

- `miniprogram/`：小程序页面、样式、导航和云函数调用
- `cloudfunctions/`：17 个身份、内容、阅读、奖励、专题、答题、消息、亲友与管理员云函数
- `services/admin-upload-broker/`：大文件一次性票据校验与私有云存储上传代理
- `cloud-security/`：数据库、云函数、云存储的最小权限基线，以及人工索引清单
- `seed-data/`：待未来管理员导入器消费的审定种子或草稿清单
- `testarticle/`：项目方提供的原始资料，只作为录入、解析与审核来源
- `ui/`：产品设计稿

## 已实现的会员与数据边界

- 一个 `users` 文档代表一位少年会员；同一监护人微信 `openid` 最多管理两位少年会员。
- 会员业务数据以 `userId` 隔离。`openid` 只表示监护人微信身份，并保留在部分文档中用于审计和首位旧会员兼容，不能再作为多孩子数据的归属键。
- `memberSessions` 保存该监护人当前选中的少年会员。登录、切换会员后，正文、读后感、红五星、专题解锁、答题、亲友和消息都跟随当前 `userId`。
- 会员密码为 8 位数字，服务端使用 `scrypt-v1`；旧 SHA-256 密码会在首次成功验证后升级。支持用完整会员编号、当前微信下登记的监护人手机号和新密码找回。
- 当前手机号只做格式、同监护人一致性和跨微信占用校验，`guardianPhoneVerificationStatus` 仍为 `unverified`，不会声称已经完成短信或运营商实名验证。
- “少年我”首页展示短代号；完整会员编号只在登录后的个人资料页展示。会员列表不暴露完整编号。

## 阅读、奖励与开放权限

1. 只有活动少年会员会话可以读取正文和配音。成功打开当前版本正文时，`markContentRead` 写入 `readingStates`，这就是“已阅读”。
2. `saveRecord` 提交前会再次校验当前会员确实打开过该内容的当前版本。每位会员、每篇内容只有一条确定性读后感记录，重复提交会覆盖正文而不是新建多条。
3. 命中任一已配置敏感词或远端内容安全规则时，读后感都会保存为 `pending_review` 并提示“需要人工复审”，不会直接删除或拒绝保存；复审通过后再发奖励并开放整书权限。无敏感词时自动通过为 `completed`。
4. 每篇内容首次自动通过只创建一次 `content-completion` 奖励，发 50 颗红五星和一个内容徽章。重复提交不会重复发奖。
5. 通过带 `bookId` 的内容读后感后，会创建该会员的 `bookEntitlements`。会员可分页读取对应 `bookChapters`，并由 `getFullBookAccess` 获取 `protected/books/` 下 PDF 的短期下载地址。
6. 少年真先展示小专题目录。首次打开某专题时按 `unlockCostStars` 扣减红五星并写入 `specialTopicUnlocks`；同一会员再次打开不重复扣费，付费图文资源由云函数签发短期地址。
7. 少年爱会保存每次答题选择和正误到 `quizAttempts`，当前不统计总成绩，也不发奖励。

## 云函数

- 身份与会员：`register`、`login`、`getUser`
- 内容与阅读：`getContentCatalog`、`getContentDetail`、`markContentRead`、`saveRecord`、`getNotes`
- 管理员复审：`moderationCenter`（仅 `adminAccounts` 中活动的 `moderator`/`content-reviewer`/`admin` 可用）
- 管理员内容控制面：`adminContentCenter`（`uploader` 上传和编辑、`content-reviewer` 预览与复核、`admin` 正式发布）
- 受保护资源：`getAudioManifest`、`getFullBookAccess`
- 五栏内容：`getYouthTimeline`、`quizCenter`、`specialTopicCenter`
- 亲友与消息：`familyCenter`、`memberInbox`

`function-invoke-rules.json` 只控制微信身份能否调用函数；每个函数仍必须在服务端继续校验活动少年会员会话、`userId` 所有权和内容状态。

## 云环境初始化

1. 在 `miniprogram/config/cloud.js` 配置目标环境 ID，并确认它与部署参数完全一致。
2. 创建 `cloud-security/database-access.manifest.json` 中的 30 个集合，把客户端权限全部设为 `ADMINONLY`。
3. 参考 `cloud-security/database-indexes.manifest.json` 在目标环境控制台逐条创建复合索引。该文件是人工核对清单，不是可直接导入或自动部署的配置。
4. 应用 `cloud-security/function-invoke-rules.json`。通配规则默认拒绝，仅列出的 17 个函数允许已登录微信用户调用；管理员函数还会在函数内部二次核验管理员账号。
5. 在云存储权限中选择免费预设“仅创建者可读写”，或使用 `cloud-security/storage-access-rules.json` 中同时兼容小程序 `auth.openid` 与其他客户端 `auth.uid` 的官方“仅创建者可读写”规则。这个权限只供管理员无代理直传回退使用；展示封面、展示图片、音频、专题正文图和 PDF 仍必须由云函数校验权限后签发短期 HTTPS 地址。
6. 给 `register` 配置固定的 `GUARDIAN_PHONE_CLAIM_SECRET`，至少 32 个随机字符。它只用于生成不可枚举的手机号 HMAC 占位索引，不能提交到仓库或写入日志。
7. 按 `cloud-security/admin-account.example.json` 在可信控制台创建微信 `openid` 绑定的管理员账号；上传编辑员用 `uploader`，独立内容复核员用 `content-reviewer`，正式发布只授予 `admin`。
8. 可选部署 HTTPS 上传代理，把无尾斜杠、无查询参数的上传基址（例如 `https://upload.example.com/v1/admin/uploads`）配置为 `adminContentCenter` 的 `ADMIN_UPLOAD_BROKER_URL`，并把域名加入小程序 `uploadFile` 合法域名。配置后可由代理执行实际字节、摘要和文件结构校验；未配置时默认走免费 `cloud-storage-direct`。免费模式下，书稿和小专题 `.docx` 在小程序本机解析后直接用 `attachClientManifest` 提交结构化清单，不重复上传或保存原始 Word。内嵌图按服务端返回的精确 `protected/contents/.../embedded/` 或 `protected/special-topics/.../embedded/` 计划上传，再用若干次 `confirmClientImages`（每批最多 20 张）确认；只有全部对象存在且字段、环境和路径完全匹配后才能建稿。直传录音和整书 PDF 分别直接落到精确的 `published/audio/...` 与 `protected/books/...` 持久路径，只记录对象存在、精确路径和管理员确认，仍须人工试听/预览、独立复核和正式发布。录音可携带小程序媒体组件测得的 `clientDurationSeconds`（大于 0 且不超过 24 小时）供草稿预填；它是客户端证明，不替代服务端文件类型、大小、签名和结构检查。原始字节、摘要与签名不会被免费版短时云函数冒充为已验证。
9. 运行本地检查，部署全部云函数，再在目标云环境与真机逐项验收。

运行必需集合按领域分组如下：

- 身份与管理：`users`、`guardianPhoneClaims`、`memberSessions`、`legalDocuments`、`adminAccounts`、`adminUploads`、`adminContentDrafts`、`adminDraftPreviewAudits`、`adminPublishedRevisions`、`publicAssets`
- 阅读与奖励：`contents`、`readingStates`、`records`、`rewardLedger`、`audioTracks`、`moderationTerms`
- 整书：`books`、`bookChapters`、`bookEntitlements`
- 专题、问答与少年志：`specialTopics`、`specialTopicEntries`、`specialTopicUnlocks`、`quizQuestions`、`quizAttempts`、`zhiEntries`
- 亲友与消息：`familyInvites`、`familyInviteCounters`、`familyRelations`、`familyRelationCounters`、`memberMessages`

文档 ID 直读的集合通常不需要复合索引；当前代码实际使用的多字段过滤和排序已列在 `cloud-security/database-indexes.manifest.json`。索引创建后必须等待控制台显示生效，再用目标环境实际查询验收。

整书上传本轮只新增两条人工复合索引：`contents(bookId asc, status asc, sortOrder asc, _id asc)` 用于首次发布时从已发布正文生成章节，`books(status asc, publishedAt desc, _id desc)` 用于管理员选择书目。已有环境只需补这两条。

## 云存储路径

- `published/images/app-home/v1/...`：固定的 6 张首页图片；仅管理员通过 `adminContentCenter.seedHomeAssets` 分次写入，普通客户端只能经 `getContentCatalog.homeAssets` 取得短期 HTTPS 地址
- `published/images/<content-or-topic>/<revision>/...`：正式展示封面与图片；云函数核验发布状态和调用者身份后签发短期 HTTPS 地址，客户端不直接读取云文件 ID
- `published/audio/<contentId>/assets/<uploadId>/primary.<ext>`：审核通过的会员音频；客户端不可直接读取，由 `getAudioManifest` 按独立 `audioRevision` 签发短期播放地址
- `protected/special-topics/<topicId>/assets/<uploadId>/images/...`：单独上传并审核的专题图片
- `protected/special-topics/<topicId>/assets/<uploadId>/embedded/...`：从专题 DOCX 提取、按计划确认并随专题快照发布的内嵌图；两类图片都仅在解锁后签发
- `protected/contents/<contentId>/assets/<uploadId>/embedded/...`：从书稿 DOCX 提取、按计划确认并随正文快照发布的行内图；仅活动少年会员读取正文时签发
- `protected/books/<bookId>/assets/<uploadId>/<bookId>.pdf`：审核通过的整书 PDF；仅持有 `bookEntitlements` 后签发
- `admin-staging/<owner-hash>/<upload-id>/source.<ext>`：上传代理写入的私有原始素材，只能进入待验证、待审核队列
- `admin-direct-staging/<owner-hash>/<upload-id>/source.<ext>`：旧版或兼容直传流程的私有原始素材路径；当前免费 Word 导入不会创建该对象
- 草稿、原稿、DOCX/PDF 解析中间文件和审核附件：必须放在上述公开路径之外，并保持服务端专用

全桶采用“仅创建者可读写”基线；短期 HTTPS 地址只由服务端在确认资源已发布且当前用户具备相应权限后生成。管理员上传优先使用短时一次性票据和 HTTPS 服务端代理，免费回退才使用精确随机路径直传。免费预设不能在存储规则里读取 `adminAccounts`，因此仍需用量告警和孤儿文件清理防止配额滥用。预约、落盘、结构化校验、审核和正式发布是独立状态；上传成功绝不等于通过校验或发布。

## 管理员上传约定

- 书稿：仅 DOCX，单文件不超过 100 MB；旧版 `.doc` 请先在 Word 中“另存为” `.docx`。
- 录音：MP3、M4A 或 WAV，单文件不超过 500 MB。
- 小专题：仅 DOCX，单文件不超过 100 MB；旧版 `.doc` 请先另存为 `.docx`。正文图片可另传 JPG、PNG 或 WebP，单图不超过 20 MB。
- 整书下载版：仅 PDF，单文件不超过 50 MB，以适配小程序端下载链路；配音仍可到 500 MB。
- 管理员页面不会要求甲方填写关联编号、云路径、MIME、码率或排序值。书稿、小专题和题目的稳定编号由系统创建；配音从已发布书稿中选择；整书 PDF 默认归入《中国医院船》。原始文件名只作展示，云端路径使用随机上传编号，避免路径注入和覆盖。
- `pending_upload → uploading → uploaded` 用于需要保存文件对象的上传；代理完成实际字节数、完整容器、危险主动内容和压缩包安全检查后写入 `validated / not_submitted`，随后才能创建草稿。免费 Word 导入从 `direct_manifest_reserved / awaiting_client_manifest / not_uploaded` 开始，不保存原 DOCX；含内嵌图时还必须经过 `awaiting_client_images`，所有图片确认完成才进入 `client_manifest_validated`。免费直传的录音和整书 PDF 进入 `admin_attested_unverified`，只能在人工试听/预览后送审发布，不能伪称已经服务端验签。结构校验不等于编辑审核，也绝不自动发布。
- 一次性上传票据有效期 15 分钟，只绑定一个预约和一个精确路径。代理或响应中不得记录票据明文。
- DOCX 只提取有界正文与图片位置；首次整书 PDF 的章节结构从同一 `bookId` 的已发布正文自动生成，PDF 本身不用于猜测章节。书稿和专题必须由编辑完整校对结构化正文及内嵌图片，整书 PDF 必须校对原件。审核员批准前必须打开当前快照对应的结构化发布效果或 5 分钟私有原件预览。

管理员不是少年会员账号。管理员入口按当前微信身份检查 `adminAccounts`，无需先登录某位少年会员，也不使用少年会员的 8 位密码。

首页固定资源初始化不经过普通内容草稿。先创建 `publicAssets` 集合并保持 `ADMINONLY`，再由活动 `admin` 账号重复调用 `adminContentCenter` 的 `seedHomeAssets` 动作；每次至多上传一张，可选传入 `assetKey` 精确补图，直到响应中的 `progress.complete` 为 `true`。固定清单文档为 `publicAssets/app-home-v1`，读者端只调用 `getContentCatalog` 的 `homeAssets` 动作获取临时地址。

### 管理员页面

- “少年我”、少年会员登录页和“少年我 → 设置”只在服务端确认任一管理能力后显示“管理员内容中心”。纯管理员不必先注册少年会员；纯复核员也能进入，但不会看到上传和编辑操作。
- 内容中心按 capability 分别展示文件上传/Word 导入、本人上传记录、内容草稿和待复核队列；上传代理未启用时仍可导入 Word 并处理既有草稿。
- 草稿详情支持书稿、录音、小专题、整书 PDF、专题图片、少年志和少年爱题目。少年志与题目由 `createEditorialDraft` 直接创建 `structured-form` 草稿，不生成 `adminUploads` 或伪造文件引用；之后与文件草稿共用保存、送审、结构化预览、独立批准和发布状态机。只有 `editing / changes_requested` 可编辑；所有修改都使用服务端返回的新版本或快照。
- 文档通过临时地址下载后交给微信文档预览，专题图片交给图片预览，录音使用页内临时播放器；临时地址不写入 storage、globalData 或页面跳转参数。
- 审核员界面在当前快照的原件或结构化发布效果成功预览前禁用“批准”，退回和驳回必须填写原因；正式发布按钮只对 `admin` 展示。

### 管理员内容状态机

1. `createUpload`：免费 Word 导入只创建 `client-manifest-only` 预约，不返回原件路径，也不调用 `confirmUpload`；录音和 PDF 等实际文件仍按精确路径上传并确认。
2. `attachClientManifest → confirmClientImages`：免费 Word 导入绑定本机解析出的有界清单；内嵌图按持久受保护路径分批确认，未全部确认不得建稿。相同 `requestId` 可安全重试，但不得换成另一批内容。
3. `createDraftFromUpload → saveDraft`：生成白名单结构化草稿；专题图片以 `embeddedAssets` 和正文 `embeddedAssetId` 块共同进入快照，保存时不能被普通表单静默丢弃。
4. `submitDraft`：冻结包含源摘要范围、资源引用、检查结果和业务 payload 的快照。
5. `getDraftAssetPreview → reviewDraft`：同一复核员必须先预览同一快照；Word 导入核对结构化发布效果，录音/PDF 等核对原件，再选择批准、退回修改或驳回。
6. `publishDraft`：只有 `admin` 可执行；事务检查目标修订、独立音频/PDF 修订和正文待复审计数，重新确认内嵌图存在，再切换公开指针。

首次整书 PDF 若还没有已发布 `books` 结构，草稿使用 `from-published-contents` 自动模式；发布时按同一 `bookId` 下已发布 `contents` 的 `sortOrder, _id` 生成 `bookChapters`，管理员不填写章节技术编号或来源版本。至少需要一篇已发布正文。后续替换 PDF 自动改为 `reuse-current`，沿用现有章节结构。仓库中的“食管癌的故事”示例 PDF 是单篇章节来源，文件名和已知 SHA-256 均会被整书上传链路拒绝。

所有变更动作必须带 8–128 位 `requestId`；保存使用 `expectedDraftVersion`，复核/发布使用 `expectedSnapshotHash`，发布还使用草稿返回的 `basePublishedRevision`。请求重放、陈旧页面和并发发布均不得静默覆盖。

## 内容发布约定

### `contents` 与 `audioTracks`

- `contents._id` 必须等于 `contentId`，使用稳定的小写连字符 ID；只有 `status: "published"` 且 `currentRevision` 数据完整的内容可读。
- 当前产品要求正文与配音都是少年会员权限：`{ "text": "member", "audio": "member" }`。
- `catalogViews: ["book"]` 或 `["summary"]` 控制目录入口；目录分页读取，不能把大量书稿塞入小程序静态包。
- 音轨必须同时匹配内容 `currentRevision` 和独立 `audioRevision`，并为 `status: "published"`；`fileID` 指向当前环境 `published/audio/`，MIME 类型为 `audio/*`。独立音频修订可排除旧版遗留音轨并阻止两份草稿静默覆盖。
- `publishedAudioTrackCount` 必须与当前版本已发布安全音轨数一致；不一致时音频入口按未开放处理。
- `pendingReviewCount` 由读后感提交、人工复审和正文覆盖发布共同在事务内维护；旧云数据上线前必须按真实 `pending_review` 记录初始化，缺失或异常时正文覆盖会安全拒绝。

### `books`、专题与答题

- `books` 保存章节发布版本、独立 `pdfRevision` 和受保护 PDF 元数据；整书首次发布先把新修订的全部 `bookChapters` 写完，最后原子切换 `books.currentRevision`。仅替换 PDF 时复用当前章节，并用 `pdfRevision` 阻止并发静默覆盖。
- `specialTopics` 保存目录和扣星价格，正文按版本拆到 `specialTopicEntries`；付费正文图片只能引用 `protected/special-topics/`。
- `quizQuestions` 中经管理员草稿、复核并正式发布的文档是少年爱题目的唯一来源；集合缺失、为空或读取失败时不展示任何内置题。`quizAttempts` 只记录会员答题事实；当前没有积分或总成绩字段的产品承诺。
- 云端异常、数据缺失或 schema 不匹配时一律关闭读取，不回退到小程序包内的完整书稿。

## 本地检查

仓库测试不会启动微信开发者工具：

```shell
npm run setup:upload-broker
npm test
```

只检查云安全清单时运行：

```shell
npm run test:security
```

本地文件只能发现仓库配置漂移，不能证明规则、集合和索引已经在目标云环境生效。

## 部署云函数

部署脚本会先运行全量测试，并拒绝部署到与小程序配置不一致的环境。先在目标环境逐项核验数据库、索引、函数和存储权限，然后在同一个 `cmd` 会话中运行：

```bat
set "CLOUD_SECURITY_CONFIRMED_ENV=<cloud-environment-id>"
uploadCloudFunction.bat <cloud-environment-id>
```

如果微信开发者工具 CLI 不在 `PATH`，把 `WECHAT_CLI` 设置为 `cli.bat` 的完整路径。脚本会明确部署全部 17 个云函数，识别旧版 CLI “失败却返回退出码 0”的情况，并对首次创建时的短暂 `Creating` 状态有限重试；遇到持久的 `CreateFailed` 会停止，必须只删除该失败函数后再重建。上传代理是独立 HTTPS 服务，不由该脚本部署。

依赖风险和上线门禁见 `cloud-security/dependency-risk.md`。不要运行 `npm audit fix --force` 自动降级官方 SDK。

## 上线前仍需完成或外部确认

- 复杂 DOCX/PDF 版式与表格的业务拆分规则；当前书稿和小专题 DOCX 内嵌图已接入，整书章节由已发布正文生成，但 PDF 视觉完整性仍需人工预览校对
- 管理员内容中心在目标云环境的角色分流、真实大文件、临时预览和并发发布验收
- 当前腾讯 [CloudBase Run 使用限制](https://docs.cloudbase.net/run/limitation) 为单请求 20 MB、请求超时 60 秒，只能用于小文件演示；要接收项目现有约 58 MB 样稿、最高 500 MB 音频或最高 50 MB 整书 PDF，必须选择允许相应请求体与超时的 HTTPS 容器入口，或使用本项目的精确预约路径免费直传/后续受限签名分片直传
- 正式少年读者规则、版权授权、医学与编辑审核
- 旧云数据 `contents.pendingReviewCount`、音频 `audioRevision` 和书籍 `pdfRevision` 的初始化迁移
- 是否继续接受“手机号不验证即可找回密码”的产品风险，或补充短信/微信手机号验证
- 目标云环境的集合、复合索引、调用规则、存储规则、密钥和环境 ID 实际配置
- 官方 SDK 传递依赖风险的书面接受或升级验证
- 真云环境、真机、弱网、音频中断恢复、PDF 下载和微信审核流程
