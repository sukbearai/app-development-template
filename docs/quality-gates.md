# 源码质量门禁

## Git 提交钩子

安装依赖后，在仓库中执行一次 `pnpm hooks:install`。安装器仅设置仓库级 `core.hooksPath=.githooks`，可以重复执行。已有其他 hooksPath 或默认 hooks 目录中存在自定义文件时，安装器会停止，保留原配置和文件；先检查并整合已有钩子。安装不会修改全局 Git 配置。

原生 `.githooks/pre-commit` 将整个暂存区导出到独立临时目录，然后依次执行 `pnpm lint` 和 `pnpm duplication:check`。检查采用已暂存的源码、配置、基线和 vendor，复用本地 `node_modules`。部分暂存、删除文件和文件名空格均按将提交的内容检查，钩子不执行 stash、add 或自动修复。首次提交这些工具时，必须一并暂存配置、脚本、vendor 和 package.json；缺少必要文件或依赖时提交失败。

临时目录在完成或失败后清理。重复检查的 JSON 报告保存在被忽略的 `artifacts/quality/pre-commit/<本次运行目录>/`，文件路径映射回仓库，片段和行号对应暂存内容；工作区另有修改时，行号可能不同。每次报告独立保存，需要时可删除旧报告。

运行 `pnpm test:hooks` 验证真实提交、部分暂存、替代索引、检查失败和安装冲突。Git 使用当前进程 PATH 中的 Node 与 pnpm，GUI 客户端也需要可找到它们。仓库要求 Node 22.12 或更新版本。此处不配置 prepare/postinstall，容器或非 Git 安装不会自动安装钩子。Git 原生 `--no-verify` 可以跳过本地钩子，CI 继续运行这两项门禁。

提交评审前运行 `pnpm lint` 和 `pnpm duplication:check`。两项检查都已进入 `pnpm verify` 和 `pnpm pr:verify`，现有 GitHub Actions 的 `pnpm pr:verify --full` 会执行它们。直接运行这两个命令时检查当前工作树，报告写入被 Git 忽略的 `artifacts/quality/duplication/`。

## anti-slop

Oxlint 与 `@oxlint/plugins` 固定为 `1.78.0`。完整上游源码、16 个规则测试入口及 MIT 许可保存在 `tools/anti-slop/`，版本来源见其中的 README。

`.oxlintrc.json` 将全部 15 条通用规则设为 error；没有 lint 基线。`pnpm lint` 扫描整个仓库的 JS/TS，包括测试、脚本、文档内的独立脚本和 `.agents` 自有脚本。排除依赖、构建结果、浏览器报告、验证产物、生成的 `next-env.d.ts` 和独立维护的 vendor 目录 `tools/anti-slop/`。OpenAPI JSON 不属于 JS/TS 扫描对象。Effect 插件随源代码保留，当前应用没有 Effect 依赖，因此不启用。

本次引入范围是 anti-slop；Oxlint 内置 correctness 类别明确设为 off，现有类型、契约和边界检查继续执行。未使用的行内禁用指令也作为错误。确实需要保留的特殊行为只能使用有具体原因的窄范围行内例外，不能整文件关闭规则，也不能通过 `any` 或虚假泛型绕过检查。

运行 `pnpm test:quality` 验证真实工具的失败路径和规则注册一致性；该测试也属于 `pnpm test:tools`。升级 vendor 或 Oxlint 时另运行 `pnpm test:anti-slop`，覆盖所有上游规则测试。检查依赖 Node 22.12 或更新版本以及平台对应的原生二进制，不需要网络、数据库或浏览器服务。

## 重复代码

jscpd 固定为 `5.1.2`。`.jscpd.json` 明确扫描 Web 的 app/components/lib、所有当前 packages 的 src 和 worker 的 src。测试及运维脚本不属于生产重复率统计。规则采用 weak 模式、至少 8 行和 80 tokens，并用 `js-ts` 跨格式比较。弱模式忽略注释，不做标识符或字面量归一化。

`.jscpd-baseline.json` 使用工具原生指纹及出现次数。当前初始化基线记录 4 处既有重复：

- `apps/web/components/admin/admin-actions.tsx` 内三组表单提交或状态更新片段。
- `packages/server/src/async-runtime-health-service.ts` 与 `services/worker/src/async-runtime.ts` 的异步运行配置字段及默认值。

这些条目保留既有实现，不代表应当复制。`pnpm duplication:check` 使用 `--fail-on-new-clones=0` 拒绝任何新增重复，包括已知片段的新增副本。检查前删除旧报告，工具失败、报告缺失或格式错误、空扫描、生产根目录缺失均失败。正常检查不会更新基线。

需要调整已接受的重复时，先审查报告中的文件、行号和片段，再显式运行 `pnpm duplication:baseline`，检查基线 diff 并重跑 `pnpm duplication:check`。CI 禁止运行基线更新命令。不能仅为让检查通过而刷新基线、提高阈值、排除业务路径或关闭规则；这些配置变更需要单独说明理由并接受评审。

基线指纹使用源码片段，修改片段内的空白或注释也可能被标记为新增重复。遇到这种情况需对照旧片段审查，不能把检测结果直接认定为新增业务逻辑。

报告可能包含源码片段和本机绝对路径。报告留在本地质量产物目录；既有 CI 产物归档按仓库权限保存，没有新增外部上传服务。
