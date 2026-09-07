import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Database,
  ShieldAlert,
  XCircle,
} from "lucide-react";

type PageHeaderProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
};

type StatCardProps = {
  label: string;
  value: string | number;
  hint?: string;
  icon?: React.ReactNode;
};

const toneIcons = {
  neutral: CircleDashed,
  success: CheckCircle2,
  warning: AlertCircle,
  danger: XCircle,
  info: Clock3,
} as const;

export function PageHeader({ title, eyebrow, description, actions }: PageHeaderProps) {
  return (
    <div className="admin-page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <section className="admin-stat-grid">{children}</section>;
}

export function StatCard({ label, value, hint, icon }: StatCardProps) {
  return (
    <div className="admin-stat-card">
      <div className="stat-card-head">
        <span>{label}</span>
        <span className="stat-icon" aria-hidden>{icon || <Database size={18} />}</span>
      </div>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Section({ title, description, actions, children }: PageHeaderProps & { children: React.ReactNode }) {
  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title = "暂无数据", description = "数据创建或同步后会显示在这里。" }) {
  return (
    <div className="empty-state">
      <CircleDashed size={22} />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: keyof typeof toneIcons;
}) {
  const Icon = toneIcons[tone];
  return (
    <span className={`status-badge ${tone}`}>
      <Icon size={14} />
      {children}
    </span>
  );
}

export function PermissionNotice({ message = "当前账号没有此操作权限。" }) {
  return (
    <div className="permission-notice">
      <ShieldAlert size={18} />
      <span>{message}</span>
    </div>
  );
}

export function formatDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
