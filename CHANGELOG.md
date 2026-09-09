# Changelog

## [0.2.1](https://github.com/sukbearai/app-development-template/compare/v0.2.0...v0.2.1) (2026-09-09)


### Bug Fixes

* **release:** 允许准备阶段核验未公开发行草稿 ([f5730ee](https://github.com/sukbearai/app-development-template/commit/f5730ee63fc07a58ce97244d454ce0ead7b15eec))
* **release:** 允许准备阶段核验未公开发行草稿 ([f5730ee](https://github.com/sukbearai/app-development-template/commit/f5730ee63fc07a58ce97244d454ce0ead7b15eec))

## [0.2.0](https://github.com/sukbearai/app-development-template/compare/v0.1.0...v0.2.0) (2026-09-09)

### ⚠ BREAKING CHANGES

- **rpc:** 内部认证和管理 REST 接口已移除，改用对应的 tRPC procedure

### Features

- **deployment:** 支持多副本蓝绿升级与迁移兼容性验证 ([2a6f9c1](https://github.com/sukbearai/app-development-template/commit/2a6f9c1d8d0557c9fdd44c28dfa9c6ab3bf94cfc))
- **dx:** 补齐全栈模板交互组件与工程工具 ([0f747eb](https://github.com/sukbearai/app-development-template/commit/0f747ebc5883622752ea8f48118e04ee91c3fbdc))
- **engineering:** 接入版本发布与工程验证流程 ([a036396](https://github.com/sukbearai/app-development-template/commit/a0363968bdd9100de43c8b25bbd7f543c2f0433c))
- **engineering:** 补齐质量门禁与可信发布部署监控闭环 ([7c6eeef](https://github.com/sukbearai/app-development-template/commit/7c6eeefd6f3d2684e394261b0eb673d9aad8492c))
- **quality:** 接入依赖门禁并集中工程检查配置 ([6a390ad](https://github.com/sukbearai/app-development-template/commit/6a390adce0cff0def6097e52ea09816ebb66d27d))
- **skills:** 适配 Hallmark 并增加上游来源检查 ([907193b](https://github.com/sukbearai/app-development-template/commit/907193b3227fa7cb0540724614e4c32d93b3da71))

### Bug Fixes

- **ci:** 隔离浏览器验证与并行 Docker 网络变化 ([4d78743](https://github.com/sukbearai/app-development-template/commit/4d787436b216e411d35816284e0cadba86fd6a7f))
- **container:** 校验最终镜像中的生产依赖元数据 ([280cbb2](https://github.com/sukbearai/app-development-template/commit/280cbb2d661c76697761d6089964441e2abfa9de))
- **hooks:** 避免暂存快照触发隐式依赖安装 ([0982d1d](https://github.com/sukbearai/app-development-template/commit/0982d1de1ff0c072ace35b9ef63bf408966eb81f))
- **web:** 等待客户端就绪后启用目录分页 ([bfc3154](https://github.com/sukbearai/app-development-template/commit/bfc3154cde4d11f3b8f7774af7374b08e4dae2c2))
- **web:** 等待页面就绪后启用用户和角色状态操作 ([60c0f4b](https://github.com/sukbearai/app-development-template/commit/60c0f4b1f42c16c1128447758c6bb6ddb5f7729b))
- **worker:** 为容器副本生成独立的租约身份 ([d1662fc](https://github.com/sukbearai/app-development-template/commit/d1662fcac63fe402fbebd3a5e154f17e4875bb81))

### Performance Improvements

- **verification:** 隔离限流状态并并行执行独立门禁 ([da085f5](https://github.com/sukbearai/app-development-template/commit/da085f5f61759e9e98549deb3b6df955d7b7a1f9))

### Code Refactoring

- **rpc:** 将内部业务接口迁移到类型化 tRPC ([a763167](https://github.com/sukbearai/app-development-template/commit/a76316749a87588f1e453ce7dde413428824c18b))
