"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  ClipboardList,
  FileUp,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { logoutResponseSchema } from "@pstack/contracts/http";
import { useState } from "react";
import { requestJson } from "@/components/api-client";

type AdminShellProps = {
  accountName: string;
  displayName: string;
  permissions: string[];
  children: React.ReactNode;
};

const navItems = [
  { href: "/admin", label: "概览", description: "系统状态", icon: LayoutDashboard, permission: "admin.read" },
  { href: "/admin/users", label: "用户", description: "账号与状态", icon: UsersRound, permission: "admin.read" },
  { href: "/admin/roles", label: "角色", description: "角色授权", icon: ShieldCheck, permission: "admin.read" },
  { href: "/admin/permissions", label: "权限", description: "权限目录", icon: KeyRound, permission: "admin.read" },
  { href: "/admin/files", label: "文件", description: "上传资产", icon: FileUp, permission: "admin.read" },
  { href: "/admin/audit", label: "审计", description: "操作记录", icon: ClipboardList, permission: "admin.read" },
  { href: "/admin/outbox", label: "Outbox", description: "事件发布", icon: Archive, permission: "admin.read" },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({ accountName, displayName, permissions, children }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const permissionSet = new Set(permissions);
  const visibleNav = navItems.filter((item) => permissionSet.has(item.permission));

  async function logout() {
    setLoggingOut(true);
    try {
      await requestJson("/api/auth/logout", logoutResponseSchema, { method: "POST", body: JSON.stringify({}) });
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败");
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="admin-app">
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="admin-brand-mark" aria-hidden><Activity size={20} /></span>
          <div className="admin-brand-copy">
            <strong>应用管理端</strong>
            <span>Production Console</span>
          </div>
        </div>
        <div className="admin-topbar-actions">
          {logoutError && <span role="alert">{logoutError}</span>}
          <div className="admin-user-pill" title={accountName}>
            <span>{displayName.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{displayName}</strong>
              <small>{accountName}</small>
            </div>
          </div>
          <button className="icon-button" type="button" title="退出登录" onClick={logout} disabled={loggingOut}>
            <LogOut size={18} />
          </button>
          <button className="icon-button admin-mobile-menu" type="button" title="打开导航" onClick={() => setNavOpen(true)}>
            <Menu size={18} />
          </button>
        </div>
      </header>

      <aside className={`admin-sidebar ${navOpen ? "open" : ""}`}>
        <div className="admin-sidebar-head">
          <span>管理导航</span>
          <button className="icon-button admin-mobile-menu" type="button" title="关闭导航" onClick={() => setNavOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <nav className="admin-nav" aria-label="管理端导航">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                className={`admin-nav-link ${active ? "active" : ""}`}
                href={item.href}
                onClick={() => setNavOpen(false)}
              >
                <Icon size={18} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {navOpen && <button className="admin-nav-backdrop" aria-label="关闭导航" type="button" onClick={() => setNavOpen(false)} />}
      <main className="admin-main">
        <div className="admin-content">{children}</div>
      </main>
    </div>
  );
}
