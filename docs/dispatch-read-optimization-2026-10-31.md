# 批量调度 D1 读取放大修复（2026-10-31）

## 修复范围

- 将跨日恢复预检查的 `date <> today` 拆为 `< today` 与 `> today` 两个索引范围；恢复条件不变。
- 迁移 `0008_dispatch_read_indexes.sql` 将 `jobs_ready` 扩展为 `(status,date,available_at,created_at,id)`，保留完整的确定性排序，避免同一时刻入队的任务整体排序。
- 增加仅覆盖 `status=queued AND queue_token IS NOT NULL` 的 `(date,dispatch_until)` 索引；将运行中和已投递排队中的数量拆开统计，避免扫描全部待投递任务。
- 保持 32 个在途上限、4 秒启动间隔、账号隔离、重试、冷却和 lease 语义不变。

## 本地实际读取量

使用 `apps/executor/test/dispatch-reads.mjs`，通过本地 workerd D1 的 `meta.rows_read` 计量；不是 SQL 条数，也不是 Node SQLite 的计时估计。基线为 `062bf48`，失败断言已在原代码上复现。

| 场景 | 修复前读取行数 | 修复后读取行数 |
|---|---:|---:|
| 1,600 个同时间排队任务，首次投递 32 个 | 12,619 | 1,555 |
| 1,600 个排队任务，在途名额已满 | 3,246 | 84 |
| 8,000 个同时间排队任务，首次投递 32 个 | 57,419 | 1,555 |
| 8,000 个排队任务，在途名额已满 | 16,046 | 84 |

新增索引有写入成本：首次投递 32 个任务的 D1 写入计数由 97 增至 129。结果详见同名 JSON。测试同时断言完整排序、时间间隔、运行中计数、恰好到期的 reservation 释放、名额满时仍恢复前后日期任务，并加入 Executor 的 CI runtime 检查。

## 发布前验证

- 独立发布包 Root/Web/Executor 285 项测试通过。
- D1 读取量回归测试、Executor workerd 集成和 Web 本地集成通过，无真实上游请求。
- Root build/类型检查、Web/Executor 类型检查、Web build/lint/format 通过；Web build 保留已有 CSS sourcemap 警告。
- 排除工作区内原有密码登录、设备身份等未提交改动。

## 迁移与回滚

生产部署前导出备份至本地私有目录 `private/dispatch-read-release-20261031/before-0008.sql`。先应用 0008 再发布 Worker。迁移仅调整索引，不修改任务数据；新索引兼容旧代码，代码回滚时可保留索引。

上线前版本：Web `a1fdc4f7-e8ea-414b-b16f-65987871f465`；Executor `a0c97b05-9267-4cde-a30e-b90b2e503f95`。线上版本及消费对比将在部署验证后补充。
