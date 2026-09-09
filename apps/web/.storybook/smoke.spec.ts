import { expect, test } from "@playwright/test";

test("built Storybook serves MSW and completes the real role form interaction", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/iframe.html?id=admin-create-role-form--empty&viewMode=story");
  await page.getByLabel("角色 ID").fill("role_operator");
  await page.getByLabel("角色名称").fill("运维人员");
  await page.getByRole("checkbox", { name: "查看管理端" }).check();
  await page.getByRole("button", { name: "创建角色" }).click();
  await expect(page.getByRole("status")).toHaveText("角色已创建");
  await expect(page.getByLabel("角色 ID")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("built request story renders a mocked API result", async ({ page }) => {
  await page.goto("/iframe.html?id=admin-request-state--success&viewMode=story");
  await expect(page.getByText("运维人员")).toBeVisible();
  await expect(page.getByRole("status", { name: "正在加载角色" })).toHaveCount(0);
});
