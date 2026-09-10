# 源码质量门禁

## Git 提交钩子

安装依赖后，在仓库中执行一次 `pnpm hooks:install`。安装器仅设置仓库级 `core.hooksPath=.githooks`，可以重复执行。已有其他 hooksPath 或默认 hooks 目录中存在自定义文件时，安装器会停止，保留原配置和文件；先检查并整合已有钩子。安装不会修改全局 Git 配置。

原生 `.githooks/pre-commit` 将整个暂存区导出到独立临时目录，然后用 shell 依次执行暂存 `package.json` 中的 `lint`、`duplication:check`、`dependency:check` 和 `conventions:check` 脚本。快照的 `node_modules/.bin` 加入 PATH，直接使用已安装工具，避免 pnpm 在快照中自动安装依赖。检查采用已暂存的源码、配置、基线和 vendor，复用本地安装的第三方依赖；workspace 包链接重新指向暂存快照，避免读取未暂存源码。部分暂存、删除文件和文件名空格均按将提交的内容检查，钩子不执行 stash、add 或自动修复。首次提交这些工具时，必须一并暂存配置、脚本、vendor 和 package.json；缺少必要文件、门禁脚本或依赖时提交失败。

临时目录在完成或失败后清理。重复检查的 JSON 报告保存在被忽略的 `artifacts/quality/pre-commit/<本次运行目录>/`，文件路径映射回仓库，片段和行号对应暂存内容；工作区另有修改时，行号可能不同。同一目录的 `dependency-report.json` 保留 dpdm 的入口、循环和缺失导入结果，其源码路径相对于暂存快照。每次报告独立保存，需要时可删除旧报告。

运行 `pnpm test:hooks` 验证真实提交、部分暂存、替代索引、检查失败和安装冲突。Git 使用当前进程 PATH 中的 Node，GUI 客户端也需要可找到它。仓库要求 Node 22.13 或更新版本。此处不配置 prepare/postinstall，容器或非 Git 安装不会自动安装钩子。Git 原生 `--no-verify` 可以跳过本地钩子，CI 继续运行这三项门禁。

提交评审前运行 `pnpm lint` 和 `pnpm duplication:check`。两项检查都已进入 `pnpm verify` 和 `pnpm pr:verify`，现有 GitHub Actions 的 `pnpm pr:verify --full` 会执行它们。直接运行这两个命令时检查当前工作树，报告写入被 Git 忽略的 `artifacts/quality/duplication/`。

## anti-slop

Oxlint 与 `@oxlint/plugins` 固定为 `1.78.0`。完整上游源码、16 个规则测试入口及 MIT 许可保存在 `tools/anti-slop/`，版本来源见其中的 README。

`.oxlintrc.json` 将全部 15 条通用规则设为 error；没有 lint 基线。`pnpm lint` 扫描整个仓库的 JS/TS，包括测试、脚本、文档内的独立脚本和 `.agents` 自有脚本。排除依赖、构建结果、浏览器报告、验证产物、生成的 `next-env.d.ts` 和独立维护的 vendor 目录 `tools/anti-slop/`。OpenAPI JSON 不属于 JS/TS 扫描对象。Effect 插件随源代码保留，当前应用没有 Effect 依赖，因此不启用。

Oxlint 内置 correctness 类别与 15 条 anti-slop 规则均设为 error。检查包括未使用变量、不安全 finally 控制流等实际错误，现有类型、契约和边界检查继续执行。用于拒绝 PostgreSQL NUL 和孤立代理字符的两处正则保留逐行 `no-control-regex` 例外。未使用的行内禁用指令也作为错误。确实需要保留的特殊行为只能使用有具体原因的窄范围行内例外，不能整文件关闭规则，也不能通过 `any` 或虚假泛型绕过检查。

运行 `pnpm test:quality` 验证真实工具的失败路径和规则注册一致性；该测试也属于 `pnpm test:tools`。升级 vendor 或 Oxlint 时另运行 `pnpm test:anti-slop`，覆盖所有上游规则测试。检查依赖 Node 22.13 或更新版本以及平台对应的原生二进制，不需要网络、数据库或浏览器服务。

## 生产源码范围

`scripts/source-scope.json` 是生产根目录及各工具覆盖范围的共同清单。每个根目录必须明确列出 boundary、dependency 和 duplication，值为 `true` 或带非空理由的 `{"excluded":"理由"}`。当前共 9 个根目录，边界、依赖和重复检查均覆盖全部根目录，包括 SDK 和 worker。

三个检查器都会独立读取文件系统，再与清单核对。包和服务使用 `packages/*/src`、`services/*/src`；应用支持 `apps/*/app`、`components`、`lib` 和 `src` 目录。新增应用、包、服务或这些应用源码目录必须先在清单中分类；已登记的目录消失也会失败。应用的 public、tests、依赖和构建目录不属于这些生产源码目录。采用其他源码布局时，应同时修改范围检查及其测试。

`.jscpd.json` 保留原生 `path` 配置，重复检查在调用 jscpd 前验证它与清单的 duplication 范围完全一致。登记新的生产根目录时必须同步这份配置。共享清单只定义根目录；各检查器继续自行处理文件扩展名、类型导入、忽略规则及重复基线。

## 模块边界

`pnpm boundary:check` 使用统一的层级表检查生产模块的运行时导入。Web 服务端可以调用 contracts、SDK、server、database 和 kafka；contracts 仅依赖自身，SDK 和 kafka 可以依赖 contracts，database 可以依赖 contracts，server 可以依赖 contracts、database 和 kafka，worker 可以依赖 contracts、database、kafka 和 server。各层均允许内部导入。非 Web 层不得导入 React、Next 或 vinext。服务端不得反向导入 Web 或 worker。

SDK 与 contracts 按浏览器安全模块检查。`use client` 模块及其传递依赖只能到达 Web、contracts 和 SDK，不能引入 Node 内置模块、数据库、Kafka、Redis 或 S3 客户端。worker 不得声明 `use client`。仅有类型的导入和再导出不产生运行时边，包括从 `@pstack/server/trpc-router` 导入 `AppRouter` 的两种 `import type` 写法；类型有效性由 `pnpm typecheck` 验证。

检查器解析 JS、JSX、TS、TSX 及 ESM/CJS 扩展名，识别静态导入、再导出、`require`、TypeScript `import = require` 和字面量动态导入，包括无插值模板字符串及 options 参数。相对路径、发出代码使用的 `.js` 路径、Web `@/` 别名、workspace 包与 tsconfig 路径别名均参与层级判断。第三方别名按解析后的包名再次检查，不能把 `pg` 或 React 改名后绕过限制。无法解析的本地导入和未扫描的本地运行时模块会失败。非字面量动态目标无法由此静态检查证明，依赖检查另行执行其解析限制。

## 重复代码

jscpd 固定为 `5.1.2`。`.jscpd.json` 明确扫描 Web 的 app/components/lib、所有当前 packages 的 src 和 worker 的 src。测试及运维脚本不属于生产重复率统计。规则采用 weak 模式、至少 8 行和 80 tokens，并用 `js-ts` 跨格式比较。弱模式忽略注释，不做标识符或字面量归一化。

`.jscpd-baseline.json` 使用工具原生指纹及出现次数。当前初始化基线记录 4 处既有重复：

- `apps/web/components/identity/identity-actions.tsx` 内三组表单提交或状态更新片段。
- `packages/server/src/runtime-health-config.ts` 与 `services/worker/src/async-runtime.ts` 的异步运行配置字段及默认值。

这些条目保留既有实现，不代表应当复制。`pnpm duplication:check` 使用 `--fail-on-new-clones=0` 拒绝任何新增重复，包括已知片段的新增副本。检查前删除旧报告，工具失败、报告缺失或格式错误、空扫描、生产根目录缺失均失败。正常检查不会更新基线。

需要调整已接受的重复时，先审查报告中的文件、行号和片段，再显式运行 `pnpm duplication:baseline`，检查基线 diff 并重跑 `pnpm duplication:check`。CI 禁止运行基线更新命令。不能仅为让检查通过而刷新基线、提高阈值、排除业务路径或关闭规则；这些配置变更需要单独说明理由并接受评审。

基线指纹使用源码片段，修改片段内的空白或注释也可能被标记为新增重复。遇到这种情况需对照旧片段审查，不能把检测结果直接认定为新增业务逻辑。

报告可能包含源码片段和本机绝对路径。报告留在本地质量产物目录；既有 CI 产物归档按仓库权限保存，没有新增外部上传服务。

## 运行时依赖

`pnpm dependency:check` 使用固定版本 dpdm `4.3.0` 检查运行时循环依赖和无法解析的导入。它已进入 `CORE_GATES`，因此 `pnpm pr:verify`、完整与发布验证以及 `pnpm verify` 都会执行。原生提交钩子在 lint 和重复代码检查之后执行相同的依赖检查。边界检查继续负责浏览器与服务端的导入方向。

入口覆盖 Web 的 app/components/lib、所有 `packages/*/src` 和 `services/*/src`，扫描 dpdm 默认支持的运行时 `.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`，不包括 `.d.ts`、`.d.cts`、`.d.mts` 声明文件；包括没有其他模块引用的文件及带方括号的路由。当前生产根目录必须存在且非空；新增包与服务必须先在源码范围清单中分类。每个入口都必须出现在实际解析图中，未分析的本地模块会导致失败。扫描保留单个字符串参数的动态导入、require 和运行时再导出。生产根目录内或实际导入的本地 `.cjs`、`.cts`、`.mts` 文件会被明确拒绝，因为当前 dpdm 配置不能分析其运行时依赖。JSON、CSS 等资源文件可以作为已解析的资源边保留，但不计入已分析的源码文件。

带第二个 options 参数的字面量动态导入，以及无插值模板字符串的动态导入，会被明确拒绝，避免 dpdm 静默遗漏。非字面量动态目标无法由此静态检查证明。

dpdm 先将 TypeScript 转换为 JavaScript，因此仅有类型的导入和再导出不构成运行时循环；被擦除的类型引用由 `pnpm typecheck` 检查。每个模块使用最近的 tsconfig 解析别名。Node 内置模块和已解析的第三方依赖保留为外部边。只有 Web 内的 `next/headers`、`next/link`、`next/navigation` 可以使用 vinext 例外，且对应已安装的运行时 shim 文件必须存在。其他无法解析的内部或外部导入均失败。源码中的 `@dpdm-ignore` 注释也会失败，包括入口之外实际导入的本地源码。

报告写入 `artifacts/quality/dependencies/report.json`，包含入口、扫描文件、循环、缺失导入、外部依赖和数量。检查前删除旧报告，解析异常不会留下上次通过的证据。命令不接受跳过选项。`pnpm test:tools` 中的真实临时项目覆盖循环、类型、动态导入、路由、别名、工作区包、缺失文件、空目录、vinext 例外和禁止忽略注释等路径。

## 目录与模块约定

生产源码通过 `.oxlintrc.json` 的 overrides 启用 `max-lines`，上限为 600，忽略空行与纯注释行。声明文件单独关闭这一条规则，测试与工具目录不在生产源码匹配范围内。`pnpm lint` 已被暂存快照与 CI 调用，无需额外行数脚本。`scripts/tests/file-size.test.mjs` 用真实 Oxlint 验证 600/601 行边界、空行注释和排除范围，并确认其他规则没有被关闭。

`pnpm conventions:check` 检查业务模块落点、公共职责入口、私有引用、命名、环境读取和测试归属。它复用 source-scope 与共享 TypeScript 解析，识别类型导入、再导出和透明类型包装。配置入口允许路径由 scripts/convention-policy.mjs 明确列出，没有存量迁移豁免。

测试发现器递归扫描执行环境目录。完整约定检查还拒绝有文件却没有默认执行入口的套件，以及非 server 的 web-runtime。单独执行 unit 不会误拒同 workspace 的 integration 文件。独立 collector、类型测试和资源生命周期继续由原命令负责。

原生暂存快照在 lint、duplication、dependency 后执行 conventions。完整验证计划和 CI engineering 分支同样执行该检查。修改未暂存规则不能掩盖暂存违规。完整目录规则见[目录与代码约定](conventions.md)。
