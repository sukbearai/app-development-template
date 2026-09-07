# 重跑分析探针

这些脚本用于改造前分析，不是应用回归测试。它们不会启动参考应用或连接数据库。

从 pstack-x 根目录重建静态清单：

```bash
python3 docs/analysis/scripts/inventory.py --template /Users/fayon/workspace/github/app-development-template --effect /Users/fayon/workspace/github/effect --output docs/analysis/inventory.json
```

执行旧身份函数体的隔离探针。Node 22 的类型擦除会打印实验性功能提示。探针注入记录调用的仓储替身，不证明真实 HTTP 利用：

```bash
node docs/analysis/scripts/identity-probe.mjs /Users/fayon/workspace/github/app-development-template
```

执行原 Redis 客户端的协议探针。脚本短时监听随机 loopback 端口，用固定响应验证普通 INCR、AUTH 后 INCR、SELECT 后 INCR，并在结束时关闭连接。它不运行 Redis 服务，不连接已有 Redis，也不证明登录端到端行为：

```bash
node docs/analysis/scripts/redis-probe.mjs /Users/fayon/workspace/github/app-development-template
```

Effect 和 Zod 探针需要在隔离目录安装固定发布包。以下命令将依赖、生成 schema 和结果留在被忽略的证据目录，不修改应用依赖或参考仓库：

```bash
mkdir -p .verification/template-analysis/effect-probe
npm install --prefix .verification/template-analysis/effect-probe --ignore-scripts --save-exact effect@4.0.0-rc.112 zod@4.4.3
cp docs/analysis/scripts/effect-probe.mjs .verification/template-analysis/effect-probe/probe.mjs
cp docs/analysis/scripts/zod-probe.mjs .verification/template-analysis/effect-probe/zod-probe.mjs
node .verification/template-analysis/effect-probe/probe.mjs
node .verification/template-analysis/effect-probe/zod-probe.mjs /Users/fayon/workspace/github/app-development-template
```

`result.json` 证明进程内 Layer 共享/清理、失败 finalizer、HttpApi 校验和 OpenAPI 生成。`zod-result.json` 证明旧 env 的字符串 false 行为以及登录 schema 可生成 JSON Schema。npm 发布包与本地 Effect HEAD 不是同一个构建来源，版本相同不代表字节相同。

脚本结束后没有 server、端口或数据库需要清理。保留结果及 lockfile 作为证据。再次运行会覆盖该目录中的结果，若需对照多次运行，先复制整个证据目录。
