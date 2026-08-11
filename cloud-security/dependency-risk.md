# 云端 SDK 依赖风险记录

审计日期：2026-07-14。

仓库中的云函数统一要求使用并锁定腾讯官方 `wx-server-sdk@4.0.2`；`scripts/validate-cloud-security.js` 会拒绝缺少 lockfile、版本不一致或新增直接依赖的函数。`npm audit --package-lock-only` 对这份依赖树报告 6 项：5 项高危、1 项中危，路径均来自 SDK 的传递依赖：

- `@cloudbase/node-sdk@3.17.2` 固定 `axios@0.27.2`
- `@cloudbase/database@1.4.3` 固定 `lodash.set@4.3.2` 与 `lodash.unset@4.5.2`

npm 当前给出的自动修复是把直接依赖跨主版本降至 `wx-server-sdk@2.5.3`。该方案可能丢失或改变当前事务、动态环境和数据库行为，因此没有采用；也没有用未经腾讯验证的 `overrides` 强行替换 SDK 内部依赖。

当前代码不会把用户输入作为 SDK 的请求 URL、代理地址或对象字段路径，所有数据库集合名、字段名和排序字段均为服务端常量，这降低了这些通用漏洞在本项目中的可达性，但不能视为漏洞已消失。

管理员上传代理使用并锁定腾讯官方当前版本 `@cloudbase/node-sdk@3.18.3` 与 `busboy@1.6.0`。2026-07-15 对代理的 lockfile 执行 `npm audit --package-lock-only` 报告 5 项：4 项高危、1 项中危；均来自官方 SDK 固定的 `axios@0.27.2`、`@cloudbase/database@1.4.3`、`lodash.set@4.3.2` 和 `lodash.unset@4.5.2`。npm 给出的完整修复会把直接依赖降到 `@cloudbase/node-sdk@3.0.0`，不属于可直接采用的安全升级。

上传代理不接受客户端指定数据库集合、字段、云存储路径、外部 URL 或 SDK 配置；所有这些值均由服务端预约和常量产生。该限制降低了 SSRF、原型污染和任意路径相关公告在当前调用面的可达性，但同样不能等同于修复。未使用 `overrides` 强换 SDK 内部 Axios/Lodash，以免在没有腾讯兼容性保证的情况下破坏签名、事务或上传行为。

上线门禁：

1. 每次准备部署时运行 `npm run audit:sdk` 与 `npm run audit:upload-broker` 并保存结果。
2. 腾讯发布高于 `4.0.2` 的 `wx-server-sdk` 后，先在测试环境验证事务、`getWXContext`、动态环境和全部回归测试，再统一升级全部云函数及安全校验器中的批准版本。
3. 在官方修复前，由项目安全负责人书面接受或拒绝该供应商依赖风险；不得运行 `npm audit fix --force` 自动降级。
4. 腾讯发布高于 `3.18.3` 的 `@cloudbase/node-sdk` 后，先验证数据库事务、流式存储上传、精确文件清理与全部 broker 测试，再更新锁文件和安全校验器批准版本。
