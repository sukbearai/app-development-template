# 发行制品与部署

应用版本来自根 `package.json`。Web 与 Worker 使用同一版本，Git 标签为 `v<version>`。版本变化和草稿 Release 由 release-please 管理。草稿、标签或仓库中已有镜像都不能作为部署凭据。

## 候选制品

发布使用 `test-containers --export` 交接的 Web、Worker 镜像归档。候选 `candidate.json` 记录完整 Git SHA、干净工作树标记、源码内容哈希、镜像 config ID、实际平台、归档路径与校验和，以及原始容器验证报告引用。镜像发布阶段加载同批归档，不重新构建。

生产发布必须具备 `scripts/verification-plan.mjs` 中全部 `RELEASE_GATES` 的成功证据。每项证据使用相对于证据根目录的路径。下载或转移文件时保留这些目录结构。索引引用的原始报告、日志和镜像归档缺失或内容变化都会导致校验失败。

镜像发布回执 `registry.json` 的格式如下，两个角色均须提供。

```json
{
  "schemaVersion": 1,
  "source": { "gitSha": "<40 hex>", "dirty": false, "sourceSha256": "<64 hex>" },
  "images": {
    "web": {
      "reference": "ghcr.io/owner/repository-web@sha256:<64 hex>",
      "id": "sha256:<tested config ID>",
      "platform": "linux/arm64",
      "manifest": {
        "path": "artifacts/release/web-manifest.json",
        "sha256": "<64 hex>",
        "bytes": 1234
      }
    },
    "worker": {
      "reference": "ghcr.io/owner/repository-worker@sha256:<64 hex>",
      "id": "sha256:<tested config ID>",
      "platform": "linux/arm64",
      "manifest": {
        "path": "artifacts/release/worker-manifest.json",
        "sha256": "<64 hex>",
        "bytes": 1234
      }
    }
  }
}
```

`manifest` 引用 registry 返回的原始单平台 OCI 或 Docker v2 manifest 字节。清单生成器验证这些字节的 SHA-256 等于镜像引用的 digest，并验证 `config.digest` 等于通过容器行为测试的 image ID。OCI index 不满足该契约。平台字段只记录实际验证的平台。

## 发布清单命令

`.github/workflows/release.yml` 在版本 PR 合并后固定草稿的原始 SHA，运行 `pnpm --silent pr:verify --release --json`，并通过 `PSTACK_RELEASE_OUTPUT=artifacts/release-candidate` 导出同批镜像。流水线先运行发布预览以核验候选，再登录 GHCR 并执行 `release:publish --apply`。镜像仓库为 `ghcr.io/<owner>/<repository>-web` 和相应的 `-worker`，只发布实际测试的平台。

`node scripts/release-publish.mjs --candidate artifacts/release-candidate/candidate.json --evidence <index.json> --output artifacts/release --repo <owner/repository> --json` 默认只验证输入。`--apply` 才会写 GHCR 和 GitHub。发布机器需要 Docker buildx、gh、GNU tar 和 gzip；当前发布工作流运行于 Ubuntu。平台不能用工具名称存在代替现场验证。

发布校验 registry 原始 manifest 的 digest 和 config ID，拒绝同版本不同镜像；上传 `release.json` 与 `delivery-evidence.tar.gz` 并读回资产 digest 后才公开草稿。归档包含清单引用的完整证据与原镜像归档，保留根目录相对路径。该证据包含测试日志和截图，按项目访问权限保管。

若写入 registry 或上传资产后失败，在 Actions 手动运行 `Release application`，填写原 `retry_tag`、`retry_run_id` 和 `retry_run_attempt`。恢复只接受 main 上原 release 工作流的已完成运行与未过期证据制品，下载原镜像与索引后校验，不重新构建或生成新验证记录。已有同名资产只能内容完全一致。已公开发行、证据已过期或原验证未通过时，恢复会拒绝，需要先核查失败阶段，不能移动标签或覆盖资产来继续。

在候选对应的干净源码检出中运行，所有输入输出路径均相对于 `--root`。

```sh
node scripts/release-manifest.mjs \
	--root "$PWD" \
	--candidate artifacts/release/candidate.json \
	--evidence artifacts/verification/run-example/index.json \
	--receipt artifacts/release/registry.json \
	--security artifacts/release/security.json \
	--output artifacts/release/release.json \
	--json
```

命令生成 `release.json`，其中包含应用版本、源码身份、工具链、CI run、固定 digest 的镜像引用，以及候选、回执、验证索引和安全扫描证据的路径与校验和。相同输入可安全重试，已有不同内容的输出不会被覆盖。任何必需检查未通过、归档损坏、源码不符、扫描证据缺失或回执无法关联测试镜像时，命令失败。

首次发布没有前任版本，清单记录 `rollbackVersions: []` 和 `rollbackProof: null`。提供 `--previous` 与 `--rollback-proof` 时，生成器核验前任清单和对应的双向演练证据，再派生允许回退的版本。两个参数必须同时提供，不能直接传入版本白名单。迁移账本使用 `packages/database/migrations/template/integrity.json` 的 SHA-256，恢复协议要求为 `pstack-recovery-v2`；账本相同也不能替代实际回滚演练。

发布器在公开草稿前校验候选镜像扫描、SBOM、镜像签名和证明。签名绑定最终镜像摘要与指定 GitHub 工作流身份。工具安装、漏洞数据库读取、扫描或签名失败都阻止公开。完整要求见[供应链检查](supply-chain.md)。

## 只读部署计划

下载公开 Release 的 `release.json` 和完整证据目录后运行以下命令。`--root` 指向下载内容的根目录，`--manifest` 保留其相对路径。

```sh
node scripts/release-deploy.mjs plan \
	--root /srv/pstack-release \
	--manifest artifacts/release/release.json \
	--repo owner/repository \
	--json
```

该命令通过 `gh api` 读取 GitHub Release 和 tag 对应的提交。Release 必须已公开，tag 必须解析到清单的完整 SHA，Release 上同名清单资产的 digest 和大小必须与本地文件一致。GitHub 资产没有 digest 时也会拒绝。仓库访问使用当前 `gh` 凭据，凭据不写入清单。

成功结果的 `data.environment` 包含 `PSTACK_WEB_IMAGE` 与 `PSTACK_WORKER_IMAGE`，值均固定到 digest。命令只输出计划，不修改容器、数据库、Release 或 registry。不使用 `--json` 时先输出这两个环境变量赋值，再输出命令状态。

`deploy/compose/release-images.yml` 可与基础 Compose 文件组合，将迁移、Web、Worker 的镜像替换为这两个引用并清除源码构建项。该文件使用 Compose 的 `!reset`，需要支持该语法的 Compose 版本。它只负责镜像选择，不把本地基础设施配置变为生产高可用部署；使用前仍需按部署文档配置实际服务。不要绕过 `release:plan` 的验证，将任意标签直接填入发布入口。

升级规划通过 `--current <当前清单相对路径>` 检查当前版本与目标版本，两份清单及各自证据均需保留。迁移账本或恢复协议不同会拒绝自动规划。回退还必须提供 `--rollback`，且当前清单明确列出目标版本。较旧版本不能作为普通升级绕过回退检查。

部署仍需完成[生产部署检查](production-deployment.md)、迁移任务、数据库及 Kafka recovery binding 检查和目标环境业务验收。计划成功只证明发布证据与引用一致，尚不证明目标环境能够启动、升级或回退。

需要实际替换容器时，按[执行部署与回滚](deployment-execution.md)配置明确的 Compose 目标，使用 `release:apply`。执行器保存当前版本和未完成操作，校验容器身份、迁移结果及健康状态。`release:status` 查看记录，`release:resume` 恢复同一次操作，`release:rollback` 执行已验证的兼容回退。应用回退不会执行数据库降级或删除数据卷。

## 机器输出与验证

两个命令的 `--json` 模式只在 stdout 输出一份工程结果 JSON。诊断写入 stderr。退出码 `0` 表示校验成功，`1` 表示校验失败，`2` 表示参数错误。未知参数在读取或创建制品前失败。

本地回归使用真实临时文件和隔离 Git 仓库，覆盖缺失门禁、脏源码、篡改归档、伪造 registry digest、错误 config ID、草稿 Release、错误 tag SHA 和拒绝回退。

```sh
node --test scripts/tests/release-manifest.test.mjs scripts/tests/release-deploy.test.mjs
```

这些 fixture 不代表远端发布、真实 registry 分发或生产部署验收。
