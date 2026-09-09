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
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/components/trpc-client";

type AdminShellProps = {
  accountName: string;
  displayName: string;
  permissions: string[];
  children: React.ReactNode;
};

const navItems = [
  {
    href: "/admin",
    label: "概览",
    description: "系统状态",
    icon: LayoutDashboard,
    permission: "admin.read",
  },
  {
    href: "/admin/users",
    label: "用户",
    description: "账号与状态",
    icon: UsersRound,
    permission: "admin.read",
  },
  {
    href: "/admin/roles",
    label: "角色",
    description: "角色授权",
    icon: ShieldCheck,
    permission: "admin.read",
  },
  {
    href: "/admin/permissions",
    label: "权限",
    description: "权限目录",
    icon: KeyRound,
    permission: "admin.read",
  },
  {
    href: "/admin/files",
    label: "文件",
    description: "上传资产",
    icon: FileUp,
    permission: "admin.read",
  },
  {
    href: "/admin/audit",
    label: "审计",
    description: "操作记录",
    icon: ClipboardList,
    permission: "admin.read",
  },
  {
    href: "/admin/outbox",
    label: "Outbox",
    description: "事件发布",
    icon: Archive,
    permission: "admin.read",
  },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function AdminNavigation({
  pathname,
  items,
  close,
}: {
  pathname: string;
  items: (typeof navItems)[number][];
  close: () => void;
}) {
  return (
    <nav className="admin-nav" aria-label="管理端导航">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            className={`admin-nav-link ${active ? "active" : ""}`}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={close}
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
  );
}

export function AdminShell({ accountName, displayName, permissions, children }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const logoutMutation = useMutation(trpc.auth.logout.mutationOptions());
  const [navOpen, setNavOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const permissionSet = new Set(permissions);
  const visibleNav = navItems.filter((item) => permissionSet.has(item.permission));

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 721px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setNavOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      await logoutMutation.mutateAsync();
      queryClient.clear();
      toast.success("已退出登录");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败");
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
      <div className="admin-app">
        <header className="admin-topbar">
          <div className="admin-brand">
            <span className="admin-brand-mark" aria-hidden>
              <Activity size={20} />
            </span>
            <div className="admin-brand-copy">
              <strong>应用管理端</strong>
              <span>Production Console</span>
            </div>
          </div>
          <div className="admin-topbar-actions">
            <Link className="icon-button" href="/account" aria-label="个人账号" title="个人账号">
              <KeyRound size={18} />
            </Link>
            {logoutError && <span role="alert">{logoutError}</span>}
            <div className="admin-user-pill" title={accountName}>
              <span>{displayName.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{displayName}</strong>
                <small>{accountName}</small>
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              title="退出登录"
              onClick={logout}
              disabled={loggingOut}
            >
              <LogOut size={18} />
            </button>
            <Dialog.Trigger asChild>
              <button
                className="icon-button admin-mobile-menu"
                type="button"
                title="打开导航"
                aria-label="打开导航"
              >
                <Menu size={18} />
              </button>
            </Dialog.Trigger>
          </div>
        </header>

        <aside className="admin-sidebar desktop-sidebar">
          <AdminNavigation pathname={pathname} items={visibleNav} close={() => setNavOpen(false)} />
        </aside>
        <Dialog.Portal>
          <Dialog.Overlay className="admin-nav-backdrop" />
          <Dialog.Content className="admin-sidebar mobile-sidebar" aria-describedby={undefined}>
            <Dialog.Title className="admin-sidebar-head">
              <span>管理导航</span>
              <Dialog.Close asChild>
                <button className="icon-button" type="button" aria-label="关闭导航">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </Dialog.Title>
            <AdminNavigation
              pathname={pathname}
              items={visibleNav}
              close={() => setNavOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
        <main className="admin-main">
          <div className="admin-content">{children}</div>
        </main>
      </div>
    </Dialog.Root>
  );
}
