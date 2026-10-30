# 配额优化实施计划

依据已批准的 `../specs/2026-10-30-quota-optimization.md`。

1. 保存已有 dirty 文件及与 origin/main 整合后的基线；仅合并文件，不改变 Git HEAD/index。基线测试通过后再改实现。
2. `apps/web/src/lib/dashboard-loader.ts`、tasks/history、activities：先测试轮询边界、到期/跨日唤醒与活动按需加载，再实现；使用本地组件测试及 Web 构建验证。
3. `apps/executor/src/{operations,queue,env}.ts`：先加入诊断开关、无写失败、模糊写回查、队列交回成功/失败测试，再实现。
4. `packages/hosting/src/store.ts`、Web migration/schema：测试空闲 SQL、消息聚集、全局 429 判定及恢复，然后实现索引查询、持久化冷却和 token/lease 防护。
5. Web auth/session：建立冷/热鉴权基准，抽出公共配置并复用无请求闭包的会话读取实例；验证有效/过期/撤销/篡改/切换账号与 secret/DB 隔离。
6. 赞助短缓存与活动有界并发：沿用现有测试，增加失效、错误、取消和并发上限场景。
7. 运行 root build/typecheck/tests、Web typecheck/tests/build/local integration、Executor typecheck/tests/local runtime。生成 `docs/quota-optimization-2026-10-30.md`，列出前后逻辑、fixture 实测与不能外推的项目。

构建会写 dist/routeTree 等本地产物，integration/runtime 仅启动临时本地服务。禁止部署或远端 D1 写入。回滚仅撤销本任务相对保存基线的补丁，不使用 reset；新增迁移可留置空闲状态，回滚旧代码不需要删表。保留原有用户改动及远端同步差异，交付时单独说明。
