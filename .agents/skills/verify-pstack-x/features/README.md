# Verified feature paths

| Feature | Production source | Browser or HTTP coverage |
| --- | --- | --- |
| Home | apps/web/app/page.tsx | Desktop/mobile layout, management navigation |
| Hello | apps/web/app/api/hello/route.ts | Exact GET response, unsupported POST |
| Authentication | packages/server/src/auth-service.ts, apps/web/app/login | Login, blocked submission before hydration, delayed-script recovery, safe next path, logout, forged secret, revoked sessions |
| Users and roles | apps/web/app/admin/users, apps/web/app/admin/roles | Create/persist, status changes, role revocation, read-only writes denied, pre-hydration password protection |
| Account | apps/web/app/account | Self-service password change, admin reset, whitespace preservation, session revocation |
| Files | apps/web/app/admin/files | Upload through browser, reload persisted metadata |
| Audit and outbox | apps/web/app/admin/audit, apps/web/app/admin/outbox | Page navigation and API responses |
| Permissions | apps/web/app/admin/permissions | Permission directory navigation |

Run `pnpm test:ui` for browser evidence and `pnpm test:e2e` for API rejection and persistence paths. `node scripts/verify-app.mjs --production --ui` runs the same seven browser flows against an owned production build before and after database restore. These commands own an ephemeral database. Optional middleware is covered separately.
