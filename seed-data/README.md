# `testarticle` 草稿与种子数据

本目录记录项目方示范资料的校验结果和待发布元数据。它不是上传接口，也不会自动写入云数据库或云存储；所有条目默认按草稿处理，必须经过现有管理员上传、结构化编辑、原件预览、独立复核和发布状态机后才可对少年会员开放。

当前文件：

- `draft-content-manifest.json`：原始资料、目标集合、版本和状态总清单
- `content-seeds/esophageal-cancer-story.v1.json`：从《食管癌的故事》PDF 审定出的结构化正文草稿
- `audio-seeds/esophageal-cancer-story.v1.json`：配音 MP3 的元数据、字节数与 SHA-256 草稿
- `book-seeds/china-hospital-ship.v1.json`：稳定整书 ID、版本、章节清单与待部署 PDF 路径约定
- `book-chapter-seeds/china-hospital-ship.esophageal-cancer-story.v1.json`：由已结构化正文 `sections` 映射的整书章节草稿

运行静态校验：

```shell
node scripts/validate-content-seeds.js
```

校验会检查 JSON 结构、内容/音轨/整书/章节版本关系、章节与源正文 `sections` 映射、整书 PDF 保护路径、源文件路径、字节数和 SHA-256。校验通过只说明仓库中的草稿和原始文件一致，不代表医学、版权、编辑审核完成，也不代表数据已经发布。

## 管理员导入流程约定

1. 管理员选择资料类型，例如书稿/单篇正文、录音、小专题、少年志、题目或规则，并把 DOCX、PDF、MP3 和图片上传到服务端专用草稿区。
2. 服务端计算哈希、记录来源和上传人，并校验完整文件结构；DOCX 产生有界文字预览，PDF 的章节和复杂版式仍由管理员完整录入校对。复核员必须预览当前审核快照后才能批准。
3. 正文写入 `contents`；超出单文档限制的整书写入 `books` 与分页 `bookChapters`；小专题写入 `specialTopics` 与 `specialTopicEntries`。
4. 发布事务统一写入稳定 ID、`currentRevision`、`status: "published"`、资源 `fileID` 和计数。任何一步失败都不得留下半发布状态。
5. 发布后使用少年会员测试账号验收目录、正文打开、配音、读后感、整书/PDF、专题扣星和重复打开不重复扣费。

当前示例使用稳定 `bookId: "china-hospital-ship"`。导入时应先将 `contents`、`books` 和 `bookChapters` 全部保持为 `draft`/`pending`；只有完整书稿、全部章节和最终 PDF 均审核通过后，才能在同一发布事务中切换为 `published`。

当前仓库已经实现上述管理员身份、上传代理、结构校验、草稿/复核/发布 API；尚缺管理端编辑审核页面和复杂版式自动拆分。不要手工把原稿直接写入数据库文档或公开存储路径。

## 资源路径与权限

- MP3 不进入小程序代码包。审定后的音频放入 `published/audio/<contentId>/assets/<uploadId>/primary.<ext>`，真实 `cloud://` fileID 和独立 `audioRevision` 写入 `audioTracks`/`contents`。客户端不能直接读取该路径，只有活动少年会员会话可由 `getAudioManifest` 换取短期播放地址。
- 整书 PDF 放入 `protected/books/<bookId>/assets/<uploadId>/<bookId>.pdf`，元数据和独立 `pdfRevision` 写入 `books`。只有已经取得对应 `bookEntitlements` 的会员可由 `getFullBookAccess` 获取短期下载地址。本仓库中的旧 `pdf.cloudPath` 只是种子占位，不是可下载的 fileID。
- 小专题目录封面可放 `published/images/`；扣星后展示的正文图片必须放入 `protected/special-topics/<topicId>/assets/<uploadId>/images/`，由 `specialTopicCenter` 在确认会员已解锁后签发短期地址。
- 原始 DOCX/PDF、未发布录音、解析中间文件和审核附件不得放入 `published/`，也不得给小程序客户端存储写权限。

音轨和整书种子中的 `fileIDEnvironmentVariable` 只是未来导入器约定。当前仓库没有读取这些环境变量并自动上传或发布文件的命令。部署器上传审定 PDF 后，必须将真实 `cloud://<env>/protected/books/...` fileID 写入 `books.pdf.fileID`；不得把路径模板或环境变量名当成 fileID。

## 当前示范资料处理说明

- 《食管癌的故事》正文和谢林彤配音目前都是 `draft`/`pending`；产品权限为正文、配音均需活动少年会员：`{ "text": "member", "audio": "member" }`。
- 该正文已关联《中国医院船》的稳定 `bookId`，并生成一个同版本章节草稿。仓库里只有这一篇示例文稿，不是完整书稿；`CHINA_HOSPITAL_SHIP_PDF_FILE_ID` 仍是待部署占位，不得将示例篇章 PDF 伪装为整书 PDF 发布。
- 少年志示范保持 `draft`；正式发布前必须补充可核验来源与发布时间。
- 《太阳系的物体》约 58 MB，不能把整个 DOCX 写入单个数据库文档，应拆成专题元数据与分页图文条目，并压缩审核图片后再发布。
- `少年读者规则.doc` 是版式占位稿，状态为 `placeholder-do-not-publish`，不得当作正式规则上线。
- 读后感敏感词库只在 `saveRecord` 服务端使用，不能进入小程序包。明确不适宜词条执行拦截；容易误伤的类别保存为 `pending_review` 并提示人工复审；无命中才自动通过并发放奖励。
