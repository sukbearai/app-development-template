import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import path from 'node:path';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(new URL('/login', process.env.APP_ORIGIN).href);
  await page.getByLabel('账号').fill(process.env.BOOTSTRAP_ADMIN_ACCOUNT);
  await page.getByLabel('密码').fill(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录管理端' }).click();
  await page.getByRole('heading', { name: '管理端概览' }).waitFor();
  await page.goto(new URL('/admin/roles', process.env.APP_ORIGIN).href);
  const id = `cold_${Date.now()}`;
  await page.getByLabel('角色 ID').fill(id);
  await page.getByLabel('角色名称').fill('Cold start role');
  await page.locator('input[name="permissionIds"][value="admin.read"]').check();
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '角色已创建' }).waitFor();
  await page.reload();
  assert.equal(await page.getByRole('row').filter({ hasText: id }).count(), 1);
  await page.screenshot({ path: path.join(process.env.COLD_START_OUTPUT, 'role.png'), fullPage: true });
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.waitForURL('**/login');
  console.log('Browser login, role creation, persistence and logout passed.');
} finally {
  await browser.close();
}
