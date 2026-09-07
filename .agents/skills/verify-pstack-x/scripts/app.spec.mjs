import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const account = process.env.UI_FLOW_ADMIN_ACCOUNT;
const password = process.env.UI_FLOW_ADMIN_PASSWORD;
if (!account || !password) throw new Error('UI_FLOW_ADMIN_ACCOUNT and UI_FLOW_ADMIN_PASSWORD are required for the isolated test database.');

test.beforeAll(() => {
  const doctor = execFileSync(process.execPath, [fileURLToPath(new URL('doctor.mjs', import.meta.url))], { encoding: 'utf8' });
  writeFileSync(`${process.env.PSTACK_VERIFY_OUTPUT}/doctor.json`, doctor);
});

test('homepage: desktop and mobile navigation', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('pstack-x');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'pstack-x', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '进入管理端' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`home-${viewport.width}.png`), fullPage: true, caret: "initial", animations: "disabled" });
  }
  await page.getByRole('link', { name: '进入管理端' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('账号')).toBeVisible();
});

test('hello-api: direct GET and unsupported method', async ({ request }) => {
  const response = await request.get('/api/hello');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ message: 'Hello from vinext' });
  expect((await request.post('/api/hello')).status()).toBe(405);
});

test('admin: create, persist, revoke role, upload, audit and logout', async ({ page }, testInfo) => {
  const suffix = `${Date.now()}`;
  const roleId = `role_test_${suffix}`;
  const userAccount = `test_${suffix}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/login?next=//example.invalid');
  await page.getByLabel('账号').fill(account);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录管理端' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: '管理端概览' })).toBeVisible();

  await page.getByRole('link', { name: /角色 角色授权/ }).click();
  await page.getByLabel('角色 ID').fill(roleId);
  await page.getByLabel('角色名称').fill(`测试角色${suffix}`);
  await page.locator('input[name="permissionIds"][value="admin.read"]').check();
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('角色已创建');
  await expect(page.getByLabel('角色 ID')).toHaveValue('');

  await page.getByRole('link', { name: /用户 账号与状态/ }).click();
  await page.getByLabel('账号', { exact: true }).fill(userAccount);
  await page.getByLabel('姓名').fill(`测试用户${suffix}`);
  await page.getByLabel('初始密码').fill('Browser-Test-Password-42!');
  await page.locator(`input[name="roleIds"][value="${roleId}"]`).check();
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('用户已创建');
  await page.reload();
  const userRow = page.getByRole('row').filter({ hasText: userAccount });
  await expect(userRow).toContainText(`测试用户${suffix}`);
  await userRow.getByRole('button', { name: '停用' }).click();
  await expect(userRow.getByRole('button', { name: '启用' })).toBeVisible();
  await userRow.getByRole('button', { name: '启用' }).click();
  await expect(userRow.getByRole('button', { name: '停用' })).toBeVisible();

  await page.getByRole('link', { name: /角色 角色授权/ }).click();
  const roleRow = page.getByRole('row').filter({ hasText: roleId });
  await roleRow.getByRole('button', { name: '停用' }).click();
  await expect(roleRow.getByRole('button', { name: '启用' })).toBeVisible();

  await page.getByRole('link', { name: /文件 上传资产/ }).click();
  await page.getByLabel('选择文件').setInputFiles({ name: `evidence-${suffix}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Persisted browser evidence') });
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`已上传 evidence-${suffix}.txt`);
  await page.reload();
  await expect(page.getByRole('cell', { name: `evidence-${suffix}.txt`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('files-persisted.png'), fullPage: true, caret: "initial", animations: "disabled" });

  for (const [label, heading] of [[/权限 权限目录/, '权限目录'], [/审计 操作记录/, '审计日志'], [/Outbox 事件发布/, 'Outbox 事件']]) {
    await page.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('navigation', { name: '管理端导航' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-mobile.png'), fullPage: true, caret: "initial", animations: "disabled" });
  await page.getByRole('button', { name: '关闭导航' }).first().click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
  expect(errors).toEqual([]);
});

test('login: credentials cannot enter a navigation URL before JavaScript is ready', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const navigations = [];
  page.on('request', request => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    navigations.push({ method: request.method(), pathname: url.pathname, queryKeys: [...url.searchParams.keys()] });
  });
  try {
    await page.goto(`http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}/login`);
    await page.getByLabel('账号').fill('hydration-probe');
    await page.getByLabel('密码').fill('Synthetic-Not-A-Credential');
    const button = page.getByRole('button', { name: '登录管理端' });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByLabel('密码').press('Enter');
    await expect(button).toBeDisabled();
    expect(navigations.every(request => !request.queryKeys.includes('password') && !request.queryKeys.includes('account'))).toBe(true);
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await testInfo.attach('pre-hydration-navigations.json', { body: JSON.stringify(navigations, null, 2), contentType: 'application/json' });
    await context.close();
  }
});

test('login: delayed JavaScript enables submission only after hydration', async ({ page }, testInfo) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let blockedScripts = 0;
  await page.route('**/*', async route => {
    if (route.request().resourceType() === 'script') {
      blockedScripts++;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.goto('/login', { waitUntil: 'commit' });
    const button = page.getByRole('button', { name: '登录管理端' });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    expect(blockedScripts).toBeGreaterThan(0);
    release();
    await expect(button).toBeEnabled();
    await page.getByLabel('账号').fill(account);
    await page.getByLabel('密码').fill(password);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await button.click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await testInfo.attach('delayed-script-count.json', { body: JSON.stringify({ blockedScripts }), contentType: 'application/json' });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
