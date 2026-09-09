# 开发请求与交互页面

管理列表的首屏由服务端读取，权限在服务端页面与 HTTP 路由分别检查。用户和审计列表使用数据库分页、搜索、筛选和排序。TanStack Table 显示当前页，nuqs 更新 URL 并触发服务端导航。文件列表保留游标分页。页码分页适合跳页，期间出现新增或删除记录时，相邻页可能移动。

## 调用内部业务接口

内部业务使用 tRPC 11。`packages/server/src/trpc-router.ts` 导出唯一的 `AppRouter` 类型，浏览器通过 `import type` 使用它，不导入服务端运行时代码。输入和输出继续由共享 Zod schema 校验。

组件通过 `useTRPC()` 获取类型化 query 和 mutation options，直接交给 TanStack Query：

```tsx
const trpc = useTRPC();
const query = useQuery(
  trpc.users.list.queryOptions(
    { page: 1 },
    {
      trpc: { abortOnUnmount: true },
    },
  ),
);
const create = useMutation(trpc.users.create.mutationOptions());
```

不手写业务 URL、HTTP 方法、响应 schema 或 query key。缓存失效使用 `trpc.users.list.queryKey()` 等生成的 key。服务端渲染列表仍使用服务调用读取数据，写入成功后调用 `router.refresh()`。客户端缓存列表与 RSC 列表各自明确数据所有权。

传输默认 30 秒超时，覆盖响应头及正文读取。查询设置 `trpc.abortOnUnmount` 后，取消 TanStack Query 会中止实际 HTTP 请求。主动取消、超时、网络错误、HTTP 错误和错误响应结构由 `requestError` 统一分类。公共登录 mutation 设置 `meta: { authentication: "public" }`，避免将账号密码错误当成会话过期。受保护操作返回 401 时清空客户端缓存并跳转登录。

查询默认有效期 30 秒、保留期 10 分钟，窗口聚焦不自动刷新。网络故障、超时、502 和 504 最多重试两次。429 和 503 必须带有效的 Retry-After 才重试，所有自动重试延迟上限为 60 秒。mutation 默认不重试。

tRPC 入口为 `/api/trpc/[trpc]`，查询使用 GET、写入使用 POST。批量请求被拒绝，避免认证操作共享上下文。POST 按实际字节限制为 64 KiB，Cookie 写请求保留 Origin 检查。登录在读取正文前执行全局限流，解析后再执行账号限流。服务层继续执行事务内权限复核。

## 外部 HTTP 与 SDK

`/api/uploads`、`/api/telemetry`、`/api/system/health`、`/api/system/metrics` 和 `/api/hello` 保留标准 HTTP。OpenAPI 与 `@pstack/sdk` 只覆盖这些入口。新增内部业务 procedure 无需修改 OpenAPI 或生成 SDK。旧 `/api/auth/*` 和 `/api/admin/*` HTTP 路由已删除。

## 编写表单

使用 React Hook Form 和 Zod resolver，引用 contracts 中的请求 schema。`FormField` 将错误与输入框关联，`setSubmissionError` 只向当前表单声明的字段映射服务端 issues。密码确认是界面约束，提交时只发送服务端请求 schema 的字段。

文本输入不要设置空字符串 defaultValues。浏览器可能在 JavaScript 加载完成前接收输入，这类默认值会在 hydration 时覆盖输入。提交按钮在 hydration 前保持禁用，表单声明 POST。成功提交使用 reset 清空表单。

移动导航由 Radix Dialog 管理焦点和 Escape，滚动表格可以通过键盘访问。表单错误保留在页面，跨页成功反馈由 Sonner 显示。

## 上传文件

默认单文件上传显示真实 XHR 进度，服务端确认成功后才显示完成。客户端先校验空文件及服务端提供的大小上限，服务端继续独立执行限制。

批量上传按需加载 Uppy，支持拖放、最多 20 个文件和串行队列。每个文件仍通过现有 multipart 路由上传，POST 不自动重试。取消只停止客户端传输，不能证明服务器未提交；界面提供刷新资产列表确认结果的入口。当前协议不提供断点续传。

## 查看异常与组件状态

后台任务组件提供加载、错误和重试反馈。页面错误边界提供重试入口。浏览器异常只向现有 telemetry API 上报错误类别，每 10 秒最多一次，不发送异常消息、堆栈或页面参数。

服务端标准 tracing 见 [OpenTelemetry](tracing.md)。浏览器事件与服务端 HTTP span 是不同观测信号，当前不提供浏览器堆栈聚合或跨 Kafka 的 span 传播。

组件示例与网络异常模拟见 [组件开发](component-development.md)。SDK 用法见 [SDK](sdk.md)。依赖更新见 [依赖维护](dependency-updates.md)。

## 验证

运行 `pnpm format` 统一格式，使用 `pnpm format:check` 检查。生成的 OpenAPI、SDK 声明和数据库迁移保留各自生成器的输出。

`pnpm verify` 包含格式、SDK 新鲜度、已有源码与集成门禁、开发和生产浏览器、Storybook 交互及静态构建检查，以及实际 OTLP Collector 接收测试。`pnpm test:ui` 的新增流程包含字段反馈、键盘导航、axe、URL 翻页与历史、批量上传和取消。MSW 示例不代替真实 PostgreSQL 与浏览器验证。
