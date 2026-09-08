# Verified feature paths

| Feature | Production source | Browser or HTTP coverage |
| --- | --- | --- |
| Home | apps/web/app/page.tsx | Desktop/mobile layout, management navigation |
| Hello | apps/web/app/api/hello/route.ts | Exact GET response, unsupported POST |
| Authentication | packages/server/src/auth-service.ts, apps/web/app/login | Login, blocked submission before hydration, delayed-script recovery, safe next path, logout, forged secret, revoked sessions |
| Users and roles | apps/web/app/admin/users, apps/web/app/admin/roles | Create/persist, status changes, role revocation, read-only writes denied, pre-hydration password protection |
| Account | apps/web/app/account | Self-service password change, admin reset, whitespace preservation, session revocation |
| Files | apps/web/app/admin/files | Upload, persisted metadata, cursor navigation beyond 200 records, concurrent newer uploads, invalid cursor rejection, live login after opt-in session cleanup |
| Audit and outbox | apps/web/app/admin/audit, apps/web/app/admin/outbox | Page navigation and API responses |
| Permissions | apps/web/app/admin/permissions | Permission directory navigation |
| Runtime metrics and upload admission | apps/web/app/api/system/metrics, packages/server/src/upload-admission.ts | Dedicated credential rejection, unavailable database and real pool observations in server integration tests; owned production HTTP load and stalled upload saturation with `pnpm test:capacity` |

Run `pnpm test:ui` for browser evidence and `pnpm test:e2e` for API rejection and persistence paths. `node scripts/verify-app.mjs --production --ui` runs the same eight browser flows against an owned production build before and after database restore. Production checks also exercise Web shutdown with admitted requests, blocked transactions, a disconnected upload client and a forced deadline. These commands own an ephemeral database. Optional middleware is covered separately.
