# 工程命令与验证证据

以下命令使用项目已有 Node 22.12+ 和 pnpm 10.33.4。安装依赖使用冻结锁文件，随后执行 `pnpm hooks:install`。版本工具固定 release-please 17.3.0。

| 命令                       | 用途                                           | 写入范围                          |
| -------------------------- | ---------------------------------------------- | --------------------------------- |
| `pnpm version:check`       | 核验工具配置、manifest、根版本和 CHANGELOG     | 只读                              |
| `pnpm docs:check`          | 检查文档链接、启动命令顺序和功能验证地图       | 只读                              |
| `pnpm pr:verify`           | 源码门禁和按范围选择的验证                     | 本地报告及测试自有资源            |
| `pnpm pr:verify --release` | 完整发行验证，包括生产浏览器、容量、恢复和容器 | 本地报告及测试自有资源            |
| `pnpm test:cold-start`     | 全新隔离安装、启动和浏览器业务流程             | 临时检出、临时 Compose 资源及证据 |
| `pnpm capacity:compare`    | 对比重复容量测量与显式规则                     | 只读输入，输出比较结果            |
| `pnpm release:manifest`    | 验证镜像、回执与证据后生成发布清单             | 指定清单文件                      |
| `pnpm release:plan`        | 验证公开 Release 后生成固定 digest 的部署计划  | 只读 GitHub 与本地证据            |
| `pnpm release:publish`     | 验证候选，显式 apply 后发布                    | 默认只读；apply 写 GHCR 与 GitHub |

各命令的参数和使用限制分别见[版本](versioning.md)、[发布](releasing.md)、[冷启动](cold-start.md)和[容量比较](capacity-comparison.md)。发布并不自动部署到服务器。

## 机器调用

`pr:verify`、`docs:check`、`test:cold-start`、`capacity:compare`、`release:manifest`、`release:plan` 和 `release:publish` 支持 `--json`。通过 pnpm 调用时使用 `--silent`，避免 pnpm 自身的脚本标题混入 JSON。

```sh
pnpm --silent docs:check --json
pnpm --silent pr:verify --json
```

stdout 输出单个结果，进度和诊断写入 stderr。结果包含 `schemaVersion: 1`、`command`、`runId`、`status`、`errorCode`、`evidence` 和该命令特有的 `data`。`evidence` 可以是文件引用、输入文件引用列表或 null。不要将 `data` 当作所有命令共享的结构。

| 状态           | 退出码 | 含义                   |
| -------------- | ------ | ---------------------- |
| `passed`       | 0      | 本命令声明的检查通过   |
| `failed`       | 1      | 执行或验证失败         |
| `invalid`      | 2      | 参数或输入格式错误     |
| `inconclusive` | 3      | 证据不足或测量不可比较 |
| `interrupted`  | 130    | 用户或宿主中断         |

版本一致性与工作流内部 `release-status` 是专用只读辅助命令，不使用上述结果封装。它们的失败仍返回非零。`passed` 仅代表相应命令的范围；例如部署计划成功不代表已经部署或生产验收通过。

## PR 证据索引

每次 `pr:verify` 创建独立的 `artifacts/verification/run-*` 目录。`index.json` 记录源码 Git SHA、未提交状态、包括未跟踪文件在内的源码内容哈希、工具环境和检查结果。每项检查有开始与结束时间、耗时以及原始证据的相对路径、字节数和 SHA-256。

控制台型门禁保存实际命令日志。浏览器、容量、容器和恢复等运行型门禁还要求新生成的成功报告。源码或验证模式不匹配、缺少报告、清理失败、执行中断均不能产生成功索引。`not-run` 与 `inconclusive` 不折算为通过。

截图、trace 和原始报告继续保留在 `.verification` 中，索引引用它们。`artifacts/pr-verify/summary.json` 保留现有简要汇总入口，它可能被后一次运行更新；发布只使用独立运行目录的索引。

对归档或转移后的证据，可直接调用检查器。

```sh
node --input-type=module -e 'import {verifyEvidence} from "./scripts/verification-evidence.mjs"; await verifyEvidence(process.argv[1],process.cwd());' artifacts/verification/run-example/index.json
```

示例运行目录需要替换为本次命令输出。发布额外要求干净固定提交、全部发行门禁、实际镜像与 registry 回执关联。失败运行的索引也予以保留，不用于发布。

## 验证范围

本地工具测试覆盖真实临时文件、临时 Git 仓库、版本库 fixture、报告篡改、缺失门禁、中断和错误状态。冷启动与容量实测使用各自拥有的数据库和进程。GitHub App、主分支保护、远端检查触发、GHCR 推送、Release 公开和目标部署仍需独立验收，不能用 fixture 代替。

## 验证调度

`pnpm verify` 与 `pnpm pr:verify` 共用执行器，分别保留模板、PR 和发行检查集合。默认最多两个任务并行，`pnpm verify --concurrency 1` 可串行运行。源码只读检查先完成，工具测试与单元测试分别独占执行，随后进入运行态检查。运行态并发上限为两个；共享 Web 构建、开发锁或 Storybook 目录的任务互斥，容量测试全局独占。

SDK 的独立检查命令仍先验证契约。执行器将契约检查列为 SDK 类型检查的前置步骤，只执行一次。CI 不再在完整 PR 检查之前重复运行版本和文档检查。

每次执行创建 `.verification/verify-<runId>/<gate>/`，通过 `PSTACK_VERIFICATION_ROOT` 将该目录交给子命令。子命令只能在当前检出的 `.verification` 下输出，报告与附件不能借用其他任务的目录。索引仍位于 `artifacts/verification/run-*/index.json`，记录每个检查的开始、结束、耗时、源码身份和证据内容哈希。

同一检出只允许一个执行器运行，所有者记录位于 `.verification/verify.lock/owner.json`。发生失败时停止派发新任务，等待在途任务结束并清理，再记录未运行项目。用户取消时协作进程收到停止信号；备份测试会自然完成当前任务和清理，因此取消响应可能较慢。未运行、取消、清理失败或源码变化都不能计为通过。

生产浏览器每轮使用 smoke 之后重新启动的 Web 进程，同一轮复用相同构建和独占数据库。smoke 的真实限流耗尽检查保留，浏览器第一次错误上报必须成功，不再等待限流窗口恢复。生产报告记录两轮 smoke/browser 的不同 PID、相同构建哈希及 smoke 错误诊断日志。
