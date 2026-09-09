import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http } from "msw";
import { CreateRoleForm } from "../components/admin/admin-actions";
import { router } from "../.storybook/navigation";
import { createRoleHandler, sampleRole, unavailableResponse } from "./role-handlers";

const meta = {
  title: "Admin/Create role form",
  component: CreateRoleForm,
  args: { permissions: [{ id: "admin.read", name: "查看管理端" }] },
  parameters: { msw: { handlers: [createRoleHandler()] } },
} satisfies Meta<typeof CreateRoleForm>;

export default meta;
type Story = StoryObj<typeof meta>;

async function submitRole(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText("角色 ID"), sampleRole.id);
  await userEvent.type(canvas.getByLabelText("角色名称"), sampleRole.name);
  await userEvent.click(canvas.getByRole("checkbox", { name: /查看管理端/ }));
  await userEvent.click(canvas.getByRole("button", { name: "创建角色" }));
  return canvas;
}

export const Empty: Story = {};

export const Success: Story = {
  async play({ canvasElement }) {
    const canvas = await submitRole(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent("角色已创建");
    await expect(canvas.getByLabelText("角色 ID")).toHaveValue("");
    await expect(router.refresh).toHaveBeenCalledOnce();
  },
};

export const Error: Story = {
  parameters: { msw: { handlers: [http.post("/api/trpc/roles.create", unavailableResponse)] } },
  async play({ canvasElement }) {
    const canvas = await submitRole(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("角色服务暂时不可用");
    await expect(canvas.getByLabelText("角色 ID")).toHaveValue(sampleRole.id);
    await expect(router.refresh).not.toHaveBeenCalled();
  },
};

export const Loading: Story = {
  parameters: { msw: { handlers: [createRoleHandler("infinite")] } },
  async play({ canvasElement }) {
    const canvas = await submitRole(canvasElement);
    await expect(canvas.getByRole("button", { name: "创建角色" })).toBeDisabled();
  },
};

export const SlowNetwork: Story = {
  parameters: { msw: { handlers: [createRoleHandler(2500)] } },
  async play({ canvasElement }) {
    const canvas = await submitRole(canvasElement);
    await expect(canvas.getByRole("button", { name: "创建角色" })).toBeDisabled();
    await expect(await canvas.findByRole("status", {}, { timeout: 5000 })).toHaveTextContent(
      "角色已创建",
    );
    await expect(canvas.getByRole("button", { name: "创建角色" })).toBeEnabled();
  },
};
