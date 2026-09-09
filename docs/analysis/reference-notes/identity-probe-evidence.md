# 身份源码隔离探针

此探针读取参考仓库 auth-service.ts，移除 import/export 并由 Node stripTypeScriptTypes 擦除类型，在 VM 中执行真实函数体。仅注入 TTL 配置与记录 revokeSession 调用的替身。它证明函数逻辑，不能替代真实 API、数据库或浏览器利用验证。没有启动服务、连接数据库或修改参考仓库。

重跑命令，要求提供 stripTypeScriptTypes 的 Node 22：

```sh
node /Users/fayon/workspace/github/pnpm/pstack-x/.verification/template-analysis/identity-probe.mjs
```

标准输出：

```json
{ "inactiveRoleGrantsAdminWrite": true, "invalidSecretRevokeCalls": ["known-session-id"] }
```

Node 22.22.0 同时发出 stripTypeScriptTypes ExperimentalWarning。退出码 0。

已运行的参考仓库测试：

```sh
cd /Users/fayon/workspace/github/app-development-template/apps/web
node --test tests/unit/access-control-routes.test.mjs
```

TAP 结果为 tests 6, pass 6, fail 0。该测试只读源码并做字符串/正则断言，不调用真实认证/API。

曾尝试用 TypeScript transpileModule 做同类隔离探针，因参考仓库未安装 typescript 依赖而失败，报 ERR_MODULE_NOT_FOUND；随后改用 Node 内置类型擦除，不安装依赖。
