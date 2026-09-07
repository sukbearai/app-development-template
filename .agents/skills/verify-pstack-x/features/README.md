# Verified feature paths

| Feature | Production source | Browser or HTTP coverage |
| --- | --- | --- |
| Home | apps/web/app/page.tsx | Desktop/mobile layout, management navigation |
| Hello | apps/web/app/api/hello/route.ts | Exact GET response, unsupported POST |
| Authentication | packages/server/src/auth-service.ts, apps/web/app/login | Login, safe next path, logout, forged secret, revoked sessions |
| Users and roles | apps/web/app/admin/users, apps/web/app/admin/roles | Create/persist, status changes, role revocation, read-only writes denied |
| Files | apps/web/app/admin/files | Upload through browser, reload persisted metadata |
| Audit and outbox | apps/web/app/admin/audit, apps/web/app/admin/outbox | Page navigation and API responses |
| Permissions | apps/web/app/admin/permissions | Permission directory navigation |

Run `pnpm test:ui` for browser evidence and `pnpm test:e2e` for API rejection and persistence paths. These commands own an ephemeral database. Optional middleware is covered separately.
