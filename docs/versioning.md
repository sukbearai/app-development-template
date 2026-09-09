# 应用版本管理

根 `package.json` 是 Web 与 Worker 的统一应用版本来源。release-please 同时更新该字段、`.release-please-manifest.json` 和 `CHANGELOG.md`。内部 workspace 包不独立发行，日常功能提交不手改版本。

## 版本规则与检查

提交使用 Conventional Commits，说明继续使用中文。例如 `feat(auth): 增加会话管理`、`fix(worker): 修复恢复检查`。不兼容变更使用 `!` 或正文中的 `BREAKING CHANGE:`。Squash merge 必须在最终提交中保留这些标记。

| 当前版本 | 提交                 | 下个版本          |
| -------- | -------------------- | ----------------- |
| `0.1.0`  | `fix` 或 `feat`      | `0.1.1`           |
| `0.1.0`  | breaking             | `0.2.0`           |
| `1.2.3`  | `fix`                | `1.2.4`           |
| `1.2.3`  | `feat`               | `1.3.0`           |
| `1.2.3`  | breaking             | `2.0.0`           |
| 任意版本 | 仅 `docs` 或 `chore` | 不默认产生版本 PR |

执行 `node scripts/release-version-check.mjs` 检查配置和版本字段。执行 `node --test scripts/tests/release-version.test.mjs`，通过固定版本的真实 release-please 库检查提交解析、版本变化、CHANGELOG、草稿参数及重复运行行为。测试使用内存 GitHub 适配器，不访问或写入远端。

`bootstrap-sha` 固定为引入工程方案前的已核对基线 `32462fc7d9d3c4bb8b7934c2c64a2692cb15f2c5`。首次运行只考虑该提交之后的变化，manifest 的 `0.1.0` 不表示已有公开发行，也不指定下个发行号。复制模板到新 Git 历史时，需先把这个值改为该仓库的实际起点，再审阅工具生成的首个版本 PR。

## RC 候选版本

配置使用 release-please 的 `prerelease` versioning strategy，默认 `prerelease: false`。准备 RC 时，通过审阅的配置变更将 `packages["."].prerelease` 设为 `true`。`prerelease-type: "rc.1"` 使新候选从 `X.Y.Z-rc.1` 开始。后续修复由工具递增为 `rc.2`、`rc.3`。

RC 期间的新功能和 breaking 仍由工具决定版本范围。例如 `1.2.4-rc.1` 遇到 `feat` 会生成 `1.3.0-rc.1`。发行入口必须运行 `node scripts/release-version-check.mjs --candidate`，渠道与后缀不一致会失败。确需指定发行号时，可在有用户可见变更的提交正文中使用工具支持的 `Release-As: 1.3.0-rc.1`，再审阅其生成结果，不手改版本文件。

结束 RC 时，将 `prerelease` 改回 `false`，通过工具生成正式版本 PR。可在明确的发行提交正文中使用 `Release-As: 1.3.0`。正式版需要验证自身合并提交，不能复用 RC 提交的成功证据。不要移动 RC 标签来生成正式标签。

## 草稿与重试约束

固定使用 [release-please-action 4.4.1 的提交](https://github.com/googleapis/release-please-action/tree/5c625bfb5d1ff62eadeeb3772007f7f66fdcf071)。该提交的锁文件固定 release-please `17.3.0`，本地 devDependency 与之相同。升级 action 时同步审阅库版本并重新运行 fixture。

配置要求 `draft: true` 和 `force-tag-creation: true`。GitHub 原本会延迟到发布草稿时才创建标签；立即保留标签让后续版本计算能定位上一个候选。标签和草稿仅保留版本身份，部署仍需公开 Release、发布清单和对应成功证据。

发行工作流必须处理以下实际行为。

1. action 的根路径输出包括 `id`、`sha`、`tag_name`、`draft`、`version` 和 `prNumber`。`sha` 来自 GitHub 返回的 `target_commitish`。再次读取对应 Release、PR 合并提交和 tag，要求三者解析到同一完整 SHA。不能把分支名或工作流触发 SHA 当作已证明的发行 SHA。
2. action 只接受目标分支，不接受固定提交参数，并会扫描仍有 pending 标签的已合并版本 PR。将本次候选约束为一个版本 PR，核验 action 实际输出，避免把旧候选或移动后的分支当成本次构建来源。
3. 草稿创建成功后，工具移除 `autorelease: pending`，添加 `autorelease: tagged`。重跑 action 通常返回空发行列表。恢复应通过带身份认证的 Release 列表找到唯一同名标签的草稿，保留原 `id`、版本与 SHA，拒绝其他提交。
4. 标签已存在时，工具的 `force-tag-creation` 会忽略 GitHub 的 422 响应，不检查旧标签的目标。创建前后都必须校验标签的实际提交。注解标签需要继续解析 tag object，直到得到 commit。不同 SHA 必须失败，不能改标签。
5. 若创建 Release 成功但后续评论或标签更新失败，下次运行可能报重复发行。工具会调整标签，但全为重复发行时仍抛错。不要把 action 的重复错误当作构建成功。恢复必须使用原草稿及原候选证据。完整候选尚未生成的失败不得被当作部分上传恢复，需先查明阶段再处理。

实现依据见固定库版本的 [Manifest 发行与标签处理](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/manifest.ts)、[GitHub 发行请求](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/github.ts)及 [RC versioning strategy](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/versioning-strategies/prerelease.ts)。

## 远端启用与验收边界

2026-09-08 只读核验 `sukbearai/app-development-template`。默认分支为 `main`，branch protection API 返回 `Branch not protected`，仓库 rulesets 返回空数组。现有 CI 工作流是 `Verify template`，job 为 `verify`。这些是当日观测，不代表保护规则已配置；启用后仍需用实际 Check Run 名称核验必需检查。

默认 `GITHUB_TOKEN` 创建的 PR 通常不会触发另一个 `pull_request` 工作流。当前 release 工作流采用 GitHub App 创建版本 PR，使其正常触发 PR 验证。启用前配置仓库变量 `RELEASE_APP_ID` 和 secret `RELEASE_APP_PRIVATE_KEY`，授予 App 当前仓库的 Contents、Issues 和 Pull requests 写权限，并核验实际 PR 的必需检查。公开发行与 GHCR 上传使用工作流自身限定的令牌。缺少 App 配置时失败，不静默退回无法触发 PR 检查的令牌。本次未修改 GitHub 设置、创建 App 或公开发行。

本地 fixture 不证明 GitHub 草稿的现场行为、权限、必需检查触发和远端重试。E1 的远端验收还需要真实版本 PR、标签与草稿对应关系，以及 E2 的失败注入。镜像验证失败时草稿必须保持未公开，部署入口必须拒绝该版本。工作流定义与 GitHub 配置分别验收。
