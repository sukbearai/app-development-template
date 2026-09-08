# 隔离冷启动检查

`pnpm test:cold-start` 从当前源码导出新的临时 Git 仓库，按 [README](../README.md) 顺序执行冻结依赖安装、hook 安装、配置初始化、依赖启动、迁移、管理员初始化和开发服务启动。[启动步骤](startup-steps.json) 保存命令参数；`pnpm docs:check` 检查 README 顺序与它一致。

需要 Node 22.12+、仓库固定版本的 pnpm、可用的 Docker Compose 和 Chromium。先执行 `pnpm exec playwright install chromium`；Linux CI 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器系统依赖。冷启动会单独安装应用依赖，允许复用 pnpm 下载缓存和浏览器安装，但不复用工作区 node_modules。

```bash
pnpm docs:check
pnpm test:cold-start --json
```

检查器包含未提交及未跟踪且未忽略的源码，不读取已有 dotenv，拒绝源码软链接。子进程只继承工具查找、用户目录和 Docker 连接所需环境；数据库与应用配置来自隔离检出的示例配置及本次生成值。Git 全局配置和用户 npm 配置不参与检查。

PostgreSQL 由隔离检出的 `pnpm local:up` 创建，Compose 项目名绑定该检出路径，端口由 Docker 动态分配到回环地址。应用也使用独立回环端口。管理员账号和口令按次生成。浏览器执行登录、创建角色、刷新后确认角色存在和退出登录。

结果和截图保存在 `.verification/cold-start/run-*`。JSON stdout 返回命令状态、错误代码、证据路径和已完成步骤；诊断写入 stderr。退出码为通过 0、检查失败 1、参数或依赖错误 2、中断 130。失败及中断也会清理自有服务、Compose 容器、卷和临时检出。清理失败会记录在结果中，不能报告通过。

文档检查覆盖 README、docs、包与 Worker README、浏览器验证技能中的本地 Markdown 链接，当前文档的显式源码路径，以及功能地图各行的源码与验证入口。历史验证报告与设计调查只检查链接，其源码描述保留当时的事实。它不访问外部链接，也不替代 API 生成一致性、浏览器流程或目标部署验收。
