# Cloudflare 配额优化：逻辑变化与验证

2026-10-30。优化已提交并推送，生产 D1 迁移已应用，Web / Executor 已部署并完成下述线上验证。

## 优化前后

| 项目 | 优化前 | 优化后 | 影响与约束 |
|---|---|---|---|
| 任务页与历史页轮询 | 完成后每 60 秒；历史页 queued 一律每 5 秒 | 稳定状态每 5 分钟；运行中 5 秒；未来重试最多每 60 秒，并在到期时唤醒 | 降低 Web 请求、CPU、D1 读取和日志；聚焦、重新可见、操作后仍刷新，跨日提前唤醒。其他设备改动在持续前台停留时最多延迟 5 分钟体现 |
| 活动加载 | 进入任务页自动读取活动 | 默认折叠，首次展开才读取；收起再展开复用结果；手动刷新保留 | 未打开时不产生活动链路请求；账号或凭据有效状态改变时重新挂载，避免复用旧活动 |
| 活动详情 | 按活动逐个串行读取 | 最多两个并发，保持列表顺序 | 缩短列表等待和 DO 占用的可能性；请求总数不减少。错误后不再启动新读取，并等待在途读取结束后释放锁；真实账单时长收益未测 |
| 签到诊断 | Executor 对首次签到读取签到前后金币流水，并输出完整诊断 | 默认关闭额外流水诊断；设置 `SIGN_DIAGNOSTICS=true` 可恢复 | 正常签到验证、失败分类日志、奖励可信性校验保留；每个符合条件的签到少 2 次上游流水请求 |
| 失败回查 | 初始读取失败也立即再 inspect | 尚未执行写操作时直接交给调度退避；发出写操作后失败仍回查 | 减少故障期间重复请求；写入成功但响应丢失仍可确认完成，奖励未知时不编造数值 |
| 队列启动等待 | 启动闸门不放行时 retry 同一 Queue 消息，集中争抢同一下次时间 | 先用 token 条件持久化交回 D1，再 ack；由既有定时调度重新分配时间 | 避免把正常等待耗尽为 Queue 投递失败；交回失败才 retry。可能多等一个 cron 周期，且一次性阻塞未必减少总操作 |
| 空闲调度 | 即使没有待处理工作，也执行恢复及调度写入 | 先读是否需要恢复/投递；空闲立即返回 | 固定场景从 8 条 SQL、1 行无值变化更新降至 1 条 SELECT、0 行更新；到期 lease 和旧日期任务仍恢复 |
| 全局限流 | 各账号分别退避，其他账号继续发起任务 | 60 秒内两个不同账号报告每日任务接口 HTTP 429，开启共享冷却，至少 60 秒并遵守 Retry-After | D1 持久化，阻止新投递和新启动；已运行任务继续；活跃冷却期间在途请求报告的新 Retry-After 可延长冷却。403、文字限流、单账号重复报告不单独触发；旧 lease/version 的结果不能触发 |
| 会话鉴权 | 每次构建包含登录插件的完整 Auth 实例 | 登录仍按请求构建；RPC 和页面会话检查复用不含请求闭包的专用实例 | 不缓存 session 结果，每次验签并读 D1；保持过期、注销、账号删除及 secret 轮换立即生效。不同 DB 独立，execution/loginTiming 不跨请求复用 |
| 赞助名单 | 每次读取 KV，响应 no-store | 成功结果公开缓存 60 秒，GET/HEAD 共用无 cookie、无查询参数的键 | 名单更新最多存在 60 秒缓存延迟；无配置/读取或校验失败不缓存。头像缓存策略不变 |

## 可复现的对比

原始结果见 [quota-optimization-2026-10-30.json](./quota-optimization-2026-10-30.json)。以下是本地 fixture，不是线上账单。

| 场景 | 优化前 | 优化后 |
|---|---:|---:|
| 1,600 个已完成任务，空闲 dispatch 的 SQL 数 | 8 | 1 |
| 同场景 SQLite changed rows | 1 | 0 |
| 8 条消息一起延迟 60 秒到达，直到全部完成：主队列读取 | 35 | 15 |
| 同场景业务投递写入 | 10 | 15 |
| 同场景主队列显式 ack | 8 | 15 |
| 同场景进入 DLQ 次数 | 2 | 0 |
| 同场景完成时间（从初次投递起） | 184 秒 | 144 秒 |
| 同场景实际业务执行次数 | 8 | 8 |
| 本地鉴权单次 CPU 中位数，5 轮 × 200 次，SQLite 有效会话 | 0.508 ms | 0.225 ms |
| 稳定页面连续可见 8 小时的周期请求，不含首次加载和交互 | 480 | 96 |
| 一个符合条件的首次签到，额外流水请求 | 2 | 0 |
| 60 秒缓存期内顺序读取赞助名单 10 次，KV 读取 | 10 | 1 |

队列基准模拟原有 max_retries=5、每分钟调度、4 秒启动间隔和 DLQ 交回；DLQ 内部读取/写入/删除未并入主队列计数，因此这些列不能直接相加当作 Cloudflare 账单操作。已断言所有任务完成、业务尝试总数仍为 8、启动间隔至少 4 秒。正常只被阻塞一次时，D1 交回再投递可能比一次 Queue retry 多操作，收益主要来自避免反复争抢和长冷却等待。

鉴权基准交替测试原路径 `createAuth(...).api.getSession()` 与新路径 `sessionAuth(...).api.getSession()`，两者都读取同一个真实 SQLite fixture，使用 `process.cpuUsage`，先预热。约 56% 的局部改善不能外推为整个 Workers CPU 下降 56%。活动并发只验证并发上限、顺序和失败收敛，没有声称线上 DO duration 已下降。

## 验证结果

- Root / Web / Executor 单元测试：348 / 348。
- Runner / Login Relay 单元测试：84 / 84。合计 432 / 432。
- Root build 与测试类型检查、Web / Executor / Runner / Relay 类型检查通过。
- Web production build、lint、全量 format check、`git diff --check` 通过。构建存在工具链已有的 CSS sourcemap 警告，不影响成功产物。
- Web 本地 D1 + Better Auth + oRPC + mock runner 集成通过：登录、密码登录、CAPTCHA、会话签名、账号隔离/切换、退出/删除立即失效、任务与额度边界。
- Executor workerd 集成通过：真实本地 D1、SQLite DO、队列消费、重复投递、活动取消与锁释放、全局 429 冷却和交回恢复。client lifecycle 测试通过。
- Relay workerd 集成通过。以上业务测试没有真实上游调用。
- 本机没有 Docker CLI，CI 中 Docker 镜像构建和容器 smoke 检查未运行。

本地 pnpm 自动切换器无法执行配置的 12.15.0 启动文件，因此使用 Node 24.22.1 和已安装的 `vp`/TypeScript 入口执行相同脚本；未修改 packageManager 或依赖。集成测试原先遇到 claim=null 就停止，与远端新增的 4 秒启动间隔不兼容；已让测试遵守服务器返回的短 Retry-After，未放宽业务断言。

关键命令（先将 Node 24 放入 PATH）：

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test test/*.test.ts apps/web/test/*.test.ts apps/executor/test/*.test.ts
node --test apps/runner/test/*.test.ts apps/login-relay/test/*.test.ts
node apps/executor/test/runtime.mjs
node apps/executor/test/client-lifecycle.mjs
node apps/login-relay/test/runtime.mjs
# 在 apps/web 下：
./node_modules/.bin/vp build
node ../../node_modules/typescript/bin/tsc --noEmit
./node_modules/.bin/vp lint
./node_modules/.bin/vp fmt --check
node test/run-integration.ts
```

基准命令：`node apps/web/test/quota-benchmark.ts <优化前代码目录>`。本次同步后的原始快照位于 `/var/folders/v5/dc0qv_8d57v6_c5kws9d4p3w0000gn/T/heybox-quota-cqss_vuy/baseline`。

## 发布与本地改动边界

先应用新增 `apps/web/migrations/0007_daily_cooldown.sql`，再发布依赖它的 Web/Executor；迁移是加列和新表，旧代码可以忽略这些状态，回滚旧代码不要求删表。`SIGN_DIAGNOSTICS` 缺省关闭，排障时显式设为 `true`。原有生产绑定、Queue 消费参数和 Cron 配置保持不变。

审查基于远端 `dd4de7b`。因本地原有未提交改动阻止 fast-forward，先做逐文件三方整合，保留本地登录、设备令牌和请求计时器改动，再建立上述基线。初次验证时 Git HEAD/index 未移动；发布阶段已将远端历史及本次优化提交纳入 main，其余本地改动继续保留在工作区。整合前原文件备份位于同一临时目录的 `before/`，本次优化不得通过整仓 reset 回滚。

上线后的配额对比应以同一账期窗口和相近业务量比较 Workers CPU、Queue 操作、DO 请求/时长；不能把当前本地结果当作已实现的账单下降。

## 发布包复核（2026-10-30）

用户已授权提交、推送、迁移和生产部署。发布包以 `origin/main dd4de7b` 为基础，只带入本次优化，排除其他会话未提交的密码登录和设备身份改动；上文 432 项是完整本地工作区的验证记录。

实际发布包单独通过 Root/Web/Executor 284 项测试、类型检查、Web build/lint/format、本地 Web 集成和 Executor workerd 集成。生产数据库迁移前已备份；迁移前登记到 `0006_daily_start_pacing.sql`，本次已成功应用 `0007_daily_cooldown.sql`。

部署前回滚版本：Web `eadb7990-86fa-4f80-ac4d-a3b1c0a702c3`，Executor `cffa2016-a8f3-4660-a5ac-bad775ff175e`。迁移为向后兼容的加列/加表，代码回滚不删除数据库数据。

## 生产部署与验证（2026-10-30）

- 已推送 `2f5aae3`（配额优化）与 `751a1c5`（Worker 最外层保留赞助缓存响应头）。上线冒烟发现外层缓存白名单遗漏 `/api/sponsors`，已先用回归测试复现，再修复、构建并重新部署；相关 8 项测试和 Web 类型检查、构建、本地集成均通过。
- D1 迁移前备份：`private/quota-release-20261030/before-0007.sql`，保留在本地，不提交。迁移后已通过生产只读查询确认迁移记录、`cooldown_until` 列、`daily_rate_limits` 表及索引存在。
- Web 当前 100% 版本：`a1fdc4f7-e8ea-414b-b16f-65987871f465`，部署时间 2026-10-30 18:06:39（Asia/Shanghai）。
- Executor 当前 100% 版本：`a0c97b05-9267-4cde-a30e-b90b2e503f95`，部署时间 2026-10-30 18:00:51（Asia/Shanghai）。
- Cloudflare API 回读确认 Web Cron `30 * * * *`、Executor Cron `* * * * *` 保留；主队列 batch size 1、并发 6、max retries 5、retry delay 60 秒及 DLQ 绑定保留。
- 线上冒烟：7 个公开页面/资源返回 200；未登录访问首页、任务、历史均跳转登录；受保护 RPC 返回 401；访客及无效 cookie 会话为空；统计接口正常；赞助名单连续读取正常且返回 `public, max-age=60`，头像返回图片；受保护 Executor 健康接口返回 Cloudflare runtime 且 dailyEnabled=true。
- 线上任务、历史页面的 JS 资源 SHA-256 与独立发布包一致；最后一轮冒烟时间为 2026-10-30 18:10:37（Asia/Shanghai）。
- 最终版本 85 秒日志观察：Web 18 个事件、Executor 3 个事件全部 outcome=ok，异常及调度失败均为 0；其中 Executor 在 18:10:27 和 18:11:27 连续两次 Cron 正常执行。

生产检查没有触发真实短信、签到或活动参与，也没有人为制造上游 429；业务执行和冷却边界由本地 workerd 集成覆盖。线上观察仅证明检查窗口内的服务与调度状态，真实配额下降需要积累上线后的同口径用量数据。
