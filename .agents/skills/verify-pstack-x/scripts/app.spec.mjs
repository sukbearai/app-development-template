import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestTrpcClient } from "../../../../scripts/trpc-client.mjs";

const rpc = (request, headers = {}) =>
  createTestTrpcClient({
    baseUrl: `http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}`,
    request,
    headers,
  });

const account = process.env.UI_FLOW_ADMIN_ACCOUNT;
const password = process.env.UI_FLOW_ADMIN_PASSWORD;
if (!account || !password)
  throw new Error(
    "UI_FLOW_ADMIN_ACCOUNT and UI_FLOW_ADMIN_PASSWORD are required for the isolated test database.",
  );

test.beforeAll(() => {
  const doctor = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("doctor.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  writeFileSync(`${process.env.PSTACK_VERIFY_OUTPUT}/doctor.json`, doctor);
});

test("homepage: desktop and mobile navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("pstack-x");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "pstack-x", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入管理端" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`home-${viewport.width}.png`),
      fullPage: true,
      caret: "initial",
      animations: "disabled",
    });
  }
  await page.getByRole("link", { name: "进入管理端" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel("账号")).toBeVisible();
});

test("hello-api: direct GET and unsupported method", async ({ request }) => {
  const response = await request.get("/api/hello");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ message: "Hello from vinext" });
  expect((await request.post("/api/hello")).status()).toBe(405);
});

test("admin: create, persist, revoke role, upload, audit and logout", async ({
  page,
}, testInfo) => {
  const suffix = `${Date.now()}`;
  const roleId = `role_test_${suffix}`;
  const userAccount = `test_${suffix}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/login?next=//example.invalid");
  await page.getByLabel("账号").fill(account);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "管理端概览" })).toBeVisible();

  await page.getByRole("link", { name: /角色 角色授权/ }).click();
  await page.getByLabel("角色 ID").fill(roleId);
  await page.getByLabel("角色名称").fill(`测试角色${suffix}`);
  await page.locator('input[name="permissionIds"][value="admin.read"]').check();
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("角色已创建");
  await expect(page.getByLabel("角色 ID")).toHaveValue("");

  await page.getByRole("link", { name: /用户 账号与状态/ }).click();
  await page.getByLabel("账号", { exact: true }).fill(userAccount);
  await page.getByLabel("姓名").fill(`测试用户${suffix}`);
  await page.getByLabel("初始密码").fill("Browser-Test-Password-42!");
  await page.locator(`input[name="roleIds"][value="${roleId}"]`).check();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("用户已创建");
  await page.reload();
  const userRow = page.getByRole("row").filter({ hasText: userAccount });
  await expect(userRow).toContainText(`测试用户${suffix}`);
  await userRow.getByRole("button", { name: "停用" }).click();
  await expect(userRow.getByRole("button", { name: "启用" })).toBeVisible();
  await userRow.getByRole("button", { name: "启用" }).click();
  await expect(userRow.getByRole("button", { name: "停用" })).toBeVisible();

  await page.getByRole("link", { name: /角色 角色授权/ }).click();
  const roleRow = page.getByRole("row").filter({ hasText: roleId });
  await roleRow.getByRole("button", { name: "停用" }).click();
  await expect(roleRow.getByRole("button", { name: "启用" })).toBeVisible();

  await page.getByRole("link", { name: /文件 上传资产/ }).click();
  await page.getByLabel("选择文件").setInputFiles({
    name: `evidence-${suffix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("Persisted browser evidence"),
  });
  await page.getByRole("button", { name: "上传", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`已上传 evidence-${suffix}.txt`);
  await page.reload();
  await expect(
    page.getByRole("cell", { name: `evidence-${suffix}.txt`, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("files-persisted.png"),
    fullPage: true,
    caret: "initial",
    animations: "disabled",
  });

  for (const [label, heading] of [
    [/权限 权限目录/, "权限目录"],
    [/审计 操作记录/, "审计日志"],
    [/Outbox 事件发布/, "Outbox 事件"],
  ]) {
    await page.getByRole("link", { name: label }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("navigation", { name: "管理端导航" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-mobile.png"),
    fullPage: true,
    caret: "initial",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭导航" }).first().click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
  expect(errors).toEqual([]);
});

test("login: credentials cannot enter a navigation URL before JavaScript is ready", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const navigations = [];
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    navigations.push({
      method: request.method(),
      pathname: url.pathname,
      queryKeys: [...url.searchParams.keys()],
    });
  });
  try {
    await page.goto(`http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}/login`);
    await page.getByLabel("账号").fill("hydration-probe");
    await page.getByLabel("密码").fill("Synthetic-Not-A-Credential");
    const button = page.getByRole("button", { name: "登录管理端" });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByLabel("密码").press("Enter");
    await expect(button).toBeDisabled();
    expect(
      navigations.every(
        (request) =>
          !request.queryKeys.includes("password") && !request.queryKeys.includes("account"),
      ),
    ).toBe(true);
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await testInfo.attach("pre-hydration-navigations.json", {
      body: JSON.stringify(navigations, null, 2),
      contentType: "application/json",
    });
    await context.close();
  }
});

test("login: delayed JavaScript enables submission only after hydration", async ({
  page,
}, testInfo) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let blockedScripts = 0;
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") {
      blockedScripts++;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.goto("/login", { waitUntil: "commit" });
    const button = page.getByRole("button", { name: "登录管理端" });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    expect(blockedScripts).toBeGreaterThan(0);
    await page.getByLabel("账号").fill(account);
    await page.getByLabel("密码").fill(password);
    release();
    await expect(button).toBeEnabled();
    await expect(page.getByLabel("账号")).toHaveValue(account);
    await expect(page.getByLabel("密码")).toHaveValue(password);
    await page.getByLabel("账号").fill(account);
    await page.getByLabel("密码").fill(password);
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/trpc/auth.login" &&
        response.request().method() === "POST",
    );
    await button.click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await testInfo.attach("delayed-script-count.json", {
      body: JSON.stringify({ blockedScripts }),
      contentType: "application/json",
    });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("admin: new-user password cannot enter URL before hydration", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}`;
  await rpc(context.request).auth.login.mutate({ account, password });
  const navigations = [];
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    navigations.push({
      method: request.method(),
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
    });
  });
  try {
    await page.goto(`${base}/admin/users`);
    await page.getByLabel("账号", { exact: true }).fill("hydration-user-probe");
    await page.getByLabel("姓名").fill("Hydration user");
    await page.getByLabel("初始密码").fill("Synthetic-Not-A-Credential");
    const button = page.getByRole("button", { name: "创建用户", exact: true });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByLabel("初始密码").press("Enter");
    await expect(button).toBeDisabled();
    expect(
      navigations.every(
        (item) => !item.queryKeys.includes("password") && !item.queryKeys.includes("account"),
      ),
    ).toBe(true);
    await expect(page).toHaveURL(/\/admin\/users$/);
  } finally {
    await testInfo.attach("admin-before-hydration.json", {
      body: JSON.stringify(navigations, null, 2),
      contentType: "application/json",
    });
    await context.close();
  }
});

test("password: administrator reset and self-service rotation revoke old sessions", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource"))
      errors.push(message.text());
  });
  const suffix = Date.now();
  const userAccount = `password_${suffix}`;
  const initialPassword = "Initial-Password-43!";
  const resetPassword = " Reset-Password-43! ";
  const changedPassword = " Changed-Password-44! ";
  const base = `http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}`;
  const adminLogin = await rpc(page.request).auth.login.mutate({ account, password });
  const admin = rpc(page.request, { authorization: `Bearer ${adminLogin.token}` });
  const roleId = `role_password_${suffix}`;
  await admin.roles.create.mutate({
    id: roleId,
    name: "Password test",
    permissionIds: ["admin.read"],
    status: "active",
  });
  const created = await admin.users.create.mutate({
    account: userAccount,
    displayName: "Password test",
    password: initialPassword,
    roleIds: [roleId],
    status: "enabled",
  });
  const userId = created.id;
  const userLogin = await rpc(request).auth.login.mutate({
    account: userAccount,
    password: initialPassword,
  });
  const oldToken = userLogin.token;

  await page.goto("/admin/users");
  const row = page.getByRole("row").filter({ hasText: userAccount });
  await row.getByText("重置密码", { exact: true }).click();
  await row.getByLabel(`${userAccount} 的新密码`).fill(resetPassword);
  await row.getByRole("button", { name: "确认重置密码" }).click();
  await expect(row.getByRole("status")).toContainText("原有会话已撤销");
  await expect(
    rpc(request, { authorization: `Bearer ${oldToken}` }).auth.me.query(),
  ).rejects.toMatchObject({ data: { httpStatus: 401 } });
  await expect(
    rpc(request, { origin: base }).auth.login.mutate({
      account: userAccount,
      password: initialPassword,
    }),
  ).rejects.toMatchObject({ data: { httpStatus: 401 } });

  await page.context().clearCookies();
  await page.goto("/login?next=/account");
  await page.getByLabel("账号", { exact: true }).fill(userAccount);
  await page.getByLabel("密码", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "登录管理端" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "个人账号" })).toBeVisible();
  await page.getByLabel("当前密码").fill(resetPassword);
  await page.getByLabel("新密码", { exact: true }).fill(changedPassword);
  await page.getByLabel("确认新密码").fill(changedPassword);
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  const auth = rpc(request, { origin: base });
  await expect(
    auth.auth.login.mutate({ account: userAccount, password: resetPassword }),
  ).rejects.toMatchObject({ data: { httpStatus: 401 } });
  const newLogin = await auth.auth.login.mutate({
    account: userAccount,
    password: changedPassword,
  });
  expect(newLogin.user.id).toBe(userId);
  expect(errors).toEqual([]);
});

test("files: keyset navigation, invalid cursor and session pruning preserve live login", async ({
  page,
}, testInfo) => {
  const { Client } = await import("pg");
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  const prefix = `page_${Date.now()}_`;
  try {
    await database.query(
      `insert into app_file_assets(id,file_name,mime_type,size_bytes,storage_key,uploaded_at)
      select $1||lpad(n::text,3,'0'),$1||n,'text/plain',1,$1||n,
        '2098-01-01'::timestamptz + (n%3)*interval '1 microsecond' from generate_series(1,237) n`,
      [prefix],
    );
    await page.goto("/login?next=/admin/files");
    await page.getByLabel("账号", { exact: true }).fill(account);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录管理端" }).click();
    await expect(page).toHaveURL(/\/admin\/files$/);
    const expected = (
      await database.query(
        "select file_name from app_file_assets where id like $1 order by uploaded_at desc,id desc",
        [`${prefix}%`],
      )
    ).rows.map((row) => row.file_name);
    await expect(page.getByText("本页 100 个文件。", { exact: true })).toBeVisible();
    const names = await page.locator("tbody tr td:first-child").allTextContents();
    await database.query(
      "insert into app_file_assets(id,file_name,mime_type,size_bytes,storage_key,uploaded_at) values($1,$1,'text/plain',1,$1,'2099-01-01')",
      [`${prefix}new`],
    );
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/cursor=/);
    names.push(...(await page.locator("tbody tr td:first-child").allTextContents()));
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("link", { name: "下一页", exact: true })).toHaveCount(0);
    names.push(...(await page.locator("tbody tr td:first-child").allTextContents()));
    expect(names.filter((name) => name.startsWith(prefix))).toEqual(expected);
    await page.getByRole("link", { name: "最新文件", exact: true }).click();
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}new`);
    await page.goto("/admin/files?cursor=invalid");
    await expect(page.getByText("分页参数无效，请返回最新文件重试。")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await page.getByRole("link", { name: "最新文件", exact: true }).click();
    await database.query(
      "insert into app_user_sessions(id,user_id,secret_hash,expires_at) select $1,id,'unused','2020-01-01' from app_users where account=$2",
      [`${prefix}expired`, account],
    );
    const pruned = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/history-prune.mjs",
        "--days",
        "30",
        "--session-days",
        "7",
        "--apply",
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: process.env,
        encoding: "utf8",
      },
    );
    expect(JSON.parse(pruned).counts.sessions).toBe(1);
    await page.reload();
    await expect(page.getByRole("heading", { name: "文件资产", exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("file-pagination.png"),
      fullPage: true,
      caret: "initial",
      animations: "disabled",
    });
    const adminLogin = await rpc(page.request, {
      origin: new URL(page.url()).origin,
    }).auth.login.mutate({ account, password });
    const admin = rpc(page.request, { authorization: `Bearer ${adminLogin.token}` });
    const roleId = `${prefix}reader`;
    const readerPassword = "File-Reader-Password-57!";
    await admin.roles.create.mutate({
      id: roleId,
      name: "File reader",
      permissionIds: ["admin.read"],
      status: "active",
    });
    await admin.users.create.mutate({
      account: roleId,
      displayName: "File reader",
      password: readerPassword,
      roleIds: [roleId],
      status: "enabled",
    });
    await page.context().clearCookies();
    await page.goto("/login?next=/admin/files");
    await page.getByLabel("账号", { exact: true }).fill(roleId);
    await page.getByLabel("密码", { exact: true }).fill(readerPassword);
    await page.getByRole("button", { name: "登录管理端" }).click();
    await expect(page).toHaveURL(/\/admin\/files$/);
    await expect(page.getByText("当前账号没有 file.upload 权限。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("选择文件")).toHaveCount(0);
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/cursor=/);
    const protectedPage = page.url();
    await page.context().clearCookies();
    await page.goto(protectedPage);
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await database.query("delete from app_file_assets where id like $1", [`${prefix}%`]);
    await database.end();
  }
});

test("directories: server pagination, filters and browser history preserve URL state", async ({
  page,
}, testInfo) => {
  const { Client } = await import("pg");
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  const prefix = `directory_${Date.now()}_`;
  try {
    await database.query(
      `insert into app_users(id,account,display_name,password_hash,status,created_at)
      select $1||n,$1||lpad(n::text,3,'0'),'Directory member '||n,'unused',
      case when n%2=0 then 'enabled' else 'disabled' end,'2098-01-01'::timestamptz from generate_series(1,57) n`,
      [prefix],
    );
    await database.query(
      `insert into app_audit_logs(id,action,trace_id,created_at)
      select $1||lpad(n::text,3,'0'),'directory.test',$1||n,'2098-01-01'::timestamptz from generate_series(1,137) n`,
      [prefix],
    );
    await page.goto("/login?next=/admin/users");
    await page.getByLabel("账号", { exact: true }).fill(account);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录管理端" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    const filters = page.locator('form[method="get"]');
    await filters.getByLabel("搜索", { exact: true }).fill(prefix);
    await filters.getByLabel("排序", { exact: true }).selectOption("account");
    await filters.getByLabel("顺序", { exact: true }).selectOption("asc");
    await filters.getByLabel("每页条数", { exact: true }).fill("20");
    await filters.getByRole("button", { name: "应用筛选" }).click();
    await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText(
      "第 1 / 3 页，共 57 条",
    );
    await expect(page.locator("tbody tr")).toHaveCount(20);
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}001`);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}021`);
    await page.reload();
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}021`);
    await page.goBack();
    await expect(page.locator("tbody tr").first()).toContainText(`${prefix}001`);
    await filters.getByLabel("状态", { exact: true }).selectOption("enabled");
    await filters.getByRole("button", { name: "应用筛选" }).click();
    await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("共 28 条");
    await page.goto(`/admin/audit?search=${prefix}&action=directory.test&limit=100`);
    await expect(page.locator("tbody tr")).toHaveCount(100);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(37);
    await expect(page.getByLabel("动作", { exact: true })).toHaveValue("directory.test");
    await page.screenshot({
      path: testInfo.outputPath("audit-paginated.png"),
      fullPage: true,
      animations: "disabled",
    });
    for (const scenario of [
      {
        name: "users-next",
        url: `/admin/users?search=${prefix}&sort=account&direction=asc&limit=20`,
        button: "下一页",
        expectedPage: 2,
        expectedRows: 20,
      },
      {
        name: "audit-previous",
        url: `/admin/audit?search=${prefix}&action=directory.test&limit=100&page=2`,
        button: "上一页",
        expectedPage: 1,
        expectedRows: 100,
      },
      {
        name: "audit-first",
        url: `/admin/audit?search=${prefix}&action=directory.test&limit=100&page=999`,
        button: "返回第一页",
        expectedPage: 1,
        expectedRows: 100,
      },
    ]) {
      await test.step(`delayed hydration: ${scenario.name}`, async () => {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let blockedScripts = 0;
        await page.route("**/*", async (route) => {
          if (route.request().resourceType() === "script") {
            blockedScripts++;
            await gate;
          }
          await route.continue();
        });
        try {
          await page.goto(scenario.url, { waitUntil: "commit" });
          const pagination = page.getByRole("navigation", { name: "列表分页" });
          const button = pagination.getByRole("button", { name: scenario.button, exact: true });
          await expect(button).toBeVisible();
          await expect.poll(() => blockedScripts).toBeGreaterThan(0);
          for (const control of await pagination.getByRole("button").all()) {
            await expect(control).toBeDisabled();
          }
          await pagination.screenshot({
            path: testInfo.outputPath(`${scenario.name}-before-hydration.png`),
          });
          release();
          await expect(button).toBeEnabled();
          await button.click();
          await expect(pagination).toContainText(`第 ${scenario.expectedPage} /`);
          await expect(page.locator("tbody tr")).toHaveCount(scenario.expectedRows);
          const query = new URL(page.url()).searchParams;
          expect(Number(query.get("page") ?? 1)).toBe(scenario.expectedPage);
          expect(query.get("search")).toBe(prefix);
          if (scenario.name.startsWith("audit")) expect(query.get("action")).toBe("directory.test");
        } finally {
          release();
          await page.unrouteAll({ behavior: "wait" });
        }
      });
    }
    const admin = rpc(page.request);
    await expect(admin.users.list.query({ page: 0 })).rejects.toMatchObject({
      data: { httpStatus: 400 },
    });
    await expect(admin.audit.list.query({ page: [1, 2] })).rejects.toMatchObject({
      data: { httpStatus: 400 },
    });
    const audit = await admin.audit.list.query({ search: prefix, limit: 100, page: 2 });
    expect(audit.items).toHaveLength(37);
  } finally {
    await database.query("delete from app_users where id like $1", [`${prefix}%`]);
    await database.query("delete from app_audit_logs where id like $1", [`${prefix}%`]);
    await database.end();
  }
});
