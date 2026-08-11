# 管理员上传代理

这个 Node.js 容器服务让微信小程序通过一次性票据把管理员素材上传到私有
CloudBase 云存储。它只接收已经由 `adminContentCenter.createUpload` 预约的精确
路径；上传成功后进入 `uploaded / validated / not_submitted`，不会创建已发布内容，也不会
开放公开读取。

## HTTP 契约

部署时把 `ADMIN_UPLOAD_BROKER_URL` 配成无尾斜杠的完整 HTTPS 基址，例如：

```text
https://upload.example.com/v1/admin/uploads
```

`createUpload` 返回最终 URL：

```text
POST <ADMIN_UPLOAD_BROKER_URL>/<32位十六进制 uploadId>
Authorization: Bearer <43位或更长的 base64url 一次性票据>
Content-Type: multipart/form-data; boundary=...
```

multipart 只允许一个名为 `file` 的文件段，不允许额外字段。`uploadId` 已在 URL
中，票据必须放在请求头中，不能放进 `formData`。这样服务可以在读取最多 500MB
的文件体之前完成验票，避免未认证请求消耗临时盘和带宽。

小程序调用形态：

```js
wx.uploadFile({
  url: uploadTransport.url,
  filePath,
  name: "file",
  header: {
    Authorization: `Bearer ${uploadTransport.ticket}`
  }
});
```

成功响应（HTTP 201）：

```json
{
  "success": true,
  "uploadId": "...",
  "status": "uploaded",
  "transportStatus": "broker_uploaded",
  "reviewStatus": "not_submitted",
  "validationStatus": "validated",
  "actualBytes": 1234,
  "sha256": "...",
  "published": false
}
```

首次成功和幂等重放都不返回 `fileID`、`cloudPath` 或任何预备资产路径。小程序只保留
`uploadId`，随后调用 `adminContentCenter.confirmUpload`；确认函数只接收该编号，并从
服务端预约记录读取和核验精确文件引用。

如果成功响应在网络中丢失，在原 15 分钟票据有效期内，用同一个 URL 和票据重试会
幂等返回已保存的校验状态，也不会再次写云存储。其余失败会把预约标成
`upload_failed`（清理失败时为 `upload_failed_cleanup_required`）；前端应重新调用
`createUpload` 获取新预约和新票据，不应复用失败票据。

## `adminUploads` 预约字段

代理在一个数据库事务中读取预约和 `adminAccounts/<ownerAdminId>`，并要求管理员
仍为 `active` 且角色含 `uploader` 或 `admin`。预约至少应包含：

```js
{
  _id: uploadId,
  ownerAdminId,
  ownerOpenid,
  ownerKey,                         // 24 位十六进制
  assetType,
  originalFileName,                 // 仅受控元数据，不参与路径拼接
  relatedId,                        // 小写稳定业务编号
  extension,
  mimeType,
  declaredBytes,
  maximumBytes,
  cloudPath,                       // 固定模板，不能由客户端指定
  uploadTicketHash,                // sha256(明文票据)，64 位十六进制
  ticketStatus: "active",
  transportMode: "https-broker",
  transportStatus: "ticket_issued",
  status: "pending_upload",
  expiresAt,                       // 创建后不超过 15 分钟
  createdAt
}
```

认领时事务原子改成 `uploading`，清空 `uploadTicketHash`，另存
`consumedUploadTicketHash` 供丢响应后的只读幂等恢复，并写入 `ticketConsumedAt`。
成功时在同一事务写入 `fileID`、`actualBytes`、`sha256`、小型 `inspection`、
`validationStatus: "validated"`、`reviewStatus: "not_submitted"` 与预备资产引用。
原始暂存路径必须严格等于：

```text
admin-staging/<ownerKey>/<uploadId>/source<预约扩展名>
```

文件名只作为业务元数据保存，永远不参与本地临时路径或云端路径拼接。

代理在任何云写入前检查实际魔数和容器结构。`audio`、`full-book-pdf`、
`topic-image` 校验通过后，还会从同一临时文件流写一份不可见预备资产：

```text
published/audio/<relatedId>/assets/<uploadId>/primary<ext>
protected/books/<relatedId>/assets/<uploadId>/<relatedId>.pdf
protected/special-topics/<relatedId>/assets/<uploadId>/images/<uploadId><ext>
```

`manuscript` 与 `special-topic` 仅保留原始暂存件。预备路径只供后续草稿审核流程引用，
不会创建发布记录；任一步失败都会精确清理本次已写入的暂存件和预备件。

结构检查不是只看文件头：PDF 校验 EOF、xref/xref stream 并拒绝加密、脚本、启动动作和嵌入文件；MP3/WAV/M4A 校验完整媒体结构与实际音频流；PNG/JPEG/WebP 校验完整区块或段边界；DOCX 校验 ZIP 安全、核心包结构和 WordprocessingML。DOCX 只输出有界纯文字预览，仍必须人工完成章节与版式校对。

## 限制与校验

- 票据由 32 个随机字节生成并用 base64url 返回；数据库只存 SHA-256。
- 票据有效期最长 15 分钟；事务保证并发请求只有一次实际上传。
- 认领后写入不超过 10 分钟且不越过票据到期时间的上传租约。容器崩溃后，同一票据只能把过期任务隔离到清理状态，不能重新覆盖未知对象；每次云写成功都会立即持久化精确清理候选。
- 全局应用上限为 500MB；其中配音上限 500MB、DOCX 上限 100MB、
  整书 PDF 上限 50MB、专题图片上限 20MB，并继续同时受预约
  `maximumBytes` 和 `declaredBytes` 限制；实际字节数必须与预约完全一致。
- MIME、扩展名、管理员归属、状态和云端路径都必须与预约一致。
- multipart 流先写权限为 `0600` 的随机临时文件，再用 CloudBase SDK 的
  `fs.ReadStream` 上传；不会把完整文件读入内存。
- 结构校验通过只表示可以创建草稿，审核状态仍是 `not_submitted`，不会自动发布。

这里的 500MB 是应用代码上限，不代表任意云托管入口一定允许 500MB 请求。部署
前必须核实目标 HTTPS 入口的请求体上限、请求超时、容器临时盘配额和并发配额，
并用项目现有约 58MB 示例素材做一次预发布环境实测。若入口限制更小，需要改用
受限签名直传或分片上传，不能简单放宽匿名存储写权限。

截至 2026-07，腾讯 [CloudBase Run 使用限制](https://docs.cloudbase.net/run/limitation)
列出的公网请求体上限是 20MB、请求超时是 60 秒。因此它只能承载小于该入口限制的演示文件，不能作为本项目
58MB DOCX、未来最高 500MB 音频或 50MB 整书 PDF 的正式上传入口。若临时使用它做小文件验收，
必须把这个范围写进交付说明；正式环境仍需换到满足容量与超时要求的 HTTPS
容器入口，或实现逐预约、逐路径授权的分片直传。

仓库中的“食管癌的故事”PDF 是单篇章节示例，不是整书。代理会在任何云写入
之前按已知 SHA-256 拒绝它，即使文件被改名也不能作为 `full-book-pdf` 发布。

## 配置与最小权限

复制 `.env.example` 的变量到部署平台。优先使用平台运行身份；非 CloudBase 环境
才从密钥管理服务注入 `CLOUDBASE_SECRET_ID` 与 `CLOUDBASE_SECRET_KEY`，两者绝不
写入代码、镜像或小程序。

运行身份只需要：

1. 读取 `adminAccounts`；
2. 对 `adminUploads` 做读取、事务更新；
3. 对私有 `admin-staging/`、`published/audio/*/assets/`、
   `protected/books/*/assets/`、`protected/special-topics/*/assets/` 精确前缀上传和失败清理；
4. 不授予其他 `published/` 路径写权限，也不授予数据库内容发布权限。

容器监听 HTTP 8080，必须由托管平台的 HTTPS 入口对外提供服务。健康检查为
`GET /healthz`。云存储继续保持客户端写入关闭；只有这个最小权限服务账号能写
上述受控暂存与预备资产前缀。

服务使用官方 `@cloudbase/node-sdk` `3.18.3` 和 `busboy` `1.6.0`，直接依赖已在
`package.json` 精确固定，并由 `package-lock.json` 锁定完整依赖树和完整性摘要。
容器只使用 `npm ci`，缺少或漂移锁文件时构建会失败。供应商 SDK 的已知传递依赖
风险和升级门禁见 `cloud-security/dependency-risk.md`。

## 本地验证

```bash
npm ci --ignore-scripts
npm test
docker build -t hospitalship-admin-upload-broker .
```

测试全部使用内存数据库、假云存储和本地流，不访问 CloudBase、不部署服务，也不
调用微信开发者工具。测试覆盖票据并发/幂等、15 分钟过期、管理员和路径校验、
精确字节数、MIME、失败状态、精确清理以及响应脱敏。

CloudBase Node SDK 的 `uploadFile` 官方接口接受可读流：
<https://docs.cloudbase.net/api-reference/server/node-sdk/storage>。

## Interrupted-claim cleanup

An `uploading` claim has a bounded lease. A same-ticket request after that
lease expires never reclaims the target for another upload. It first moves the
reservation into `upload_failed_cleanup_required` and reconstructs only the
reserved source/prepared targets. Recorded file IDs are accepted only when
their embedded paths exactly equal those targets.

The broker deletes non-empty, validated file IDs and requires a per-file
`SUCCESS`, numeric status `0`, or an explicit CloudBase file-nonexist result.
Only after every recorded ID is confirmed absent does a database transaction
clear cleanup IDs/paths and set `status`/`transportStatus` to `upload_failed`.
Partial or failed deletion keeps only the unconfirmed IDs quarantined for the
next same-ticket retry.

There is an unavoidable crash window between a cloud write succeeding and its
file ID being recorded. A candidate path alone is not deletion authority: the
broker does not guess an environment-qualified file ID and does not delete an
unknown object. If recovery has no recorded ID, it completes the database
cleanup with `uploadCleanupOutcome: "no_recorded_file_id_unverified"` and an
unverified-path count. If some recorded IDs were deleted but other candidate
paths had no recorded IDs, the outcome is
`recorded_files_deleted_unverified_paths`. Such deterministic paths remain
derivable from the reservation and should be covered by a separately
privileged orphan-reconciliation or storage-lifecycle job; they are never
silently reused by this ticket.
