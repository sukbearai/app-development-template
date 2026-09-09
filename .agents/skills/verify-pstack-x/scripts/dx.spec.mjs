import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: true }).fill(process.env.UI_FLOW_ADMIN_ACCOUNT);
  await page.getByLabel("密码", { exact: true }).fill(process.env.UI_FLOW_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("accessibility: form errors and keyboard navigation", async ({ page }, testInfo) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "登录管理端" }).click();
  await expect(page.getByLabel("账号", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("账号", { exact: true })).toBeFocused();
  const loginScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(loginScan.violations).toEqual([]);
  await login(page);
  for (const route of ["/admin/users", "/admin/files"]) {
    await page.goto(route);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    await testInfo.attach(`axe-${route.replaceAll("/", "-")}.json`, {
      body: JSON.stringify(result.violations, null, 2),
      contentType: "application/json",
    });
    expect(result.violations).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "打开导航", includeHidden: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("uploads: batch queue persists real files and cancellation remains explicit", async ({
  page,
}) => {
  await login(page);
  await page.goto("/admin/files");
  await expect(page.getByLabel("选择文件", { exact: true })).toBeEnabled();
  await page
    .getByLabel("选择文件", { exact: true })
    .setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "上传", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "批量上传", exact: true }).click();
  const suffix = Date.now();
  const files = [1, 2].map((index) => ({
    name: `batch-${suffix}-${index}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`batch ${index}`),
  }));
  await page.locator(".uppy-Dashboard-input").first().setInputFiles(files);
  await page.locator(".uppy-StatusBar-actionBtn--upload").click();
  await expect(page.getByText("已上传 2 个文件。", { exact: true })).toBeVisible();
  await page.reload();
  for (const file of files)
    await expect(page.getByRole("cell", { name: file.name, exact: true })).toBeVisible();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/uploads", async (route) => {
    await pending;
    await route.abort();
  });
  try {
    await page.getByLabel("选择文件", { exact: true }).setInputFiles(files[0]);
    await page.getByRole("button", { name: "上传", exact: true }).click();
    await page.getByRole("button", { name: "取消上传", exact: true }).click();
    await expect(
      page.getByText("已停止传输。服务端可能已收到文件，请刷新资产列表确认。"),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("diagnostics: browser failures send bounded metadata without error content", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const requestBody = { event: "browser.error", payload: { kind: "script" } };
  async function emitFailure() {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "登录管理端" })).toBeEnabled();
    const reported = page.waitForResponse((response) => response.url().endsWith("/api/telemetry"));
    await page.evaluate(() =>
      window.dispatchEvent(
        new ErrorEvent("error", { message: "Sensitive test value must not be sent" }),
      ),
    );
    const response = await reported;
    expect(response.request().postDataJSON()).toEqual(requestBody);
    return response;
  }
  let response = await emitFailure();
  if (response.status() === 429) {
    // The production smoke test consumes the endpoint's fixed one-minute budget.
    await page.waitForTimeout(60_100);
    response = await emitFailure();
  }
  expect(response.status()).toBe(201);
});
