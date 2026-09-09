import Link from "next/link";
import { env } from "@pstack/server/env";

export default function Home() {
  return (
    <main className="shell">
      <section className="panel">
        <div className="toolbar">
          <div>
            <h1>{env.APP_NAME}</h1>
            <p className="muted">应用管理与后台服务模板</p>
          </div>
          <div className="hero-actions">
            <Link className="button primary" href="/admin">
              进入管理端
            </Link>
            <Link className="button secondary" href="/account">
              个人账号
            </Link>
            <a className="button secondary" href="/api/system/health">
              服务健康
            </a>
          </div>
        </div>
        <div className="grid">
          <div className="metric">
            <span className="muted">账号与权限</span>
            <strong>用户 · 角色 · 授权</strong>
          </div>
          <div className="metric">
            <span className="muted">文件与操作记录</span>
            <strong>上传 · 审计</strong>
          </div>
          <div className="metric">
            <span className="muted">后台执行</span>
            <strong>任务 · 事件发布</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
