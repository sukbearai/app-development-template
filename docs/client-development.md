# 开发请求与交互页面

管理列表的首屏由服务端读取，权限在服务端页面与 HTTP 路由分别检查。用户和审计列表使用数据库分页、搜索、筛选和排序。TanStack Table 显示当前页，nuqs 更新 URL 并触发服务端导航。文件列表保留游标分页。页码分页适合跳页，期间出现新增或删除记录时，相邻页可能移动。

## 调用 API

使用 `apps/web/components/api-client.ts` 的 `requestJson`，传入 contracts 导出的响应 schema。成功和失败信封都在边界执行 Zod 校验。普通请求默认 30 秒超时，FormData 请求默认 120 秒；`timeoutMs` 可按操作覆盖。调用方的 AbortSignal 与超时合并，主动取消、超时、网络故障、HTTP 错误和错误响应结构可以分别处理。

读取客户端数据使用 `useApiQuery`。默认缓存有效期 30 秒、保留期 10 分钟，窗口重新聚焦不自动刷新。后台任务状态页每 30 秒刷新一次。每个查询用稳定的 query key 表示资源及参数。

网络故障、超时、502 和 504 最多重试两次。429 和 503 必须带有效的 Retry-After 才重试。所有状态的 Retry-After 均不能超过 60 秒。400、401、403、409、取消和响应校验错误不重试。写入默认不自动重试。

写操作使用 `useApiMutation`。`invalidateKeys` 接受需要精确失效的 query key。服务端渲染的列表在写入成功后仍使用 `router.refresh()`。同一份列表不要同时引入第二套客户端缓存。

受保护操作返回 401 时，清空 QueryClient 并跳转登录；登录本身设置 `authentication: "public"`，保留账号或密码错误。XHR 和 Uppy 上传也使用同一会话失效处理器。退出登录清空用户缓存。

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
