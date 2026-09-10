# 为已有业务增加操作

以下以现有角色创建功能作为参考。新增操作只创建实际需要的代码，权限和事务语义由业务要求决定。

1. 在 `packages/contracts/src/modules/identity/contracts.ts` 定义输入和输出 schema。参考 createRoleRequestSchema 和 roleSchema，类型从 schema 推导。
2. 在 `packages/server/src/modules/identity/service.ts` 实现完整业务操作。参考 createManagedRole，保留服务授权、身份锁、事务和审计事实。不能用传入 ownerId 代替资源归属检查。
3. 需要 SQL 时，在 `packages/database/src/modules/identity/repository.ts` 添加操作。写入接收服务事务，不自己获取另一条连接。
4. 在 `packages/server/src/modules/identity/router.ts` 定义 procedure 的输入、输出和权限。新增整个领域 router 时，在 `packages/server/src/trpc-router.ts` 静态注册一次；给已有 router 增加操作不需要另一份清单。
5. 在业务组件中调用 useTRPC 与 TanStack Query。参考 `apps/web/components/identity/identity-actions.tsx`，复用表单 schema 和错误提示，不手写业务 URL、响应类型或 query key。
6. 将单元测试放在 workspace 的 tests/unit，数据库行为测试放在 tests/integration。原有命令自动发现新文件；需要 Web tsconfig 的 server 测试使用 tests/web-runtime。
7. 参考 `apps/web/stories/identity/create-role.stories.tsx` 增加组件场景，覆盖成功、错误输入保持和等待状态。
8. 运行以下检查，并通过真实授权、事务和界面流程验证行为。

```sh
pnpm conventions:check
pnpm lint
pnpm duplication:check
pnpm dependency:check
pnpm boundary:check
pnpm typecheck
pnpm contract:check
pnpm migration:check
pnpm test:unit
pnpm test:integration
pnpm test:ui
```

修改数据库 schema 时，执行 db:generate 并检查生成结果，不编辑已应用 SQL 或哈希。外部 HTTP 需要在 contracts/http.ts 登记 operation、增加 handler，并生成 OpenAPI 与 SDK。内部 tRPC 不需要额外 REST 入口。

没有页面、存储或后台消费需求时，跳过对应代码。不要复制空 service、repository 或 handler 凑齐目录。规则见[目录与代码约定](conventions.md)，隔离环境见[项目验证技能](../.agents/skills/verify-pstack-x/SKILL.md)。
