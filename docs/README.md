# 文档入口

- [架构与职责](architecture.md)
- [运行、中间件、备份恢复](operations.md)
- [生成的 HTTP 契约](api.md)
- [数据库迁移](../packages/database/README.md)
- [后台任务与恢复](../services/worker/README.md)
- [生产评估修复结果](production-repair-results.md)
- [实施记录](implementation-plan.md)
- [源码质量门禁](quality-gates.md)：anti-slop 规则、生产重复代码基线和运行时依赖检查。
- [工程能力建设方案](engineering-adoption-plan.md)：六项能力的设计、实施范围与验收边界。
- [工程命令与验证证据](engineering-tools.md)
- [版本管理](versioning.md)
- [制品发布与部署计划](releasing.md)
- [隔离冷启动检查](cold-start.md)
- [容量回归比较](capacity-comparison.md)
- [改造前分析](analysis/README.md)

生成项目时，在 requirements.md 中定义产品目标、用户角色、业务对象和不做范围，在 acceptance.md 中记录真实验收路径。改造前分析保留旧实现事实，当前代码和运行文档定义模板行为。

- [开发请求与交互页面](client-development.md)
- [组件开发](component-development.md)
- [Codex 界面设计审查](codex-design.md)
- [SDK](sdk.md)
- [OpenTelemetry](tracing.md)
- [依赖维护](dependency-updates.md)
- [上游工具来源与更新检查](tooling-updates.md)
