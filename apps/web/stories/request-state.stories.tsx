import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { http } from "msw";
import { RequestState } from "./request-state";
import { roleListHandler, sampleRole, unavailableResponse } from "./role-handlers";

const meta = {
  title: "Admin/Request state",
  component: RequestState,
  parameters: { msw: { handlers: [roleListHandler([sampleRole])] } },
} satisfies Meta<typeof RequestState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText(sampleRole.name)).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: { msw: { handlers: [roleListHandler([])] } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText("暂无角色")).toBeVisible();
  },
};

export const Error: Story = {
  parameters: { msw: { handlers: [http.get("/api/trpc/roles.list", unavailableResponse)] } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "角色服务暂时不可用",
    );
  },
};

export const Loading: Story = {
  parameters: { msw: { handlers: [roleListHandler([], "infinite")] } },
  async play({ canvasElement }) {
    await expect(
      await within(canvasElement).findByRole("status", { name: "正在加载角色" }),
    ).toBeVisible();
  },
};

export const SlowNetwork: Story = {
  parameters: { msw: { handlers: [roleListHandler([sampleRole], 2500)] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("status", { name: "正在加载角色" })).toBeVisible();
    await expect(await canvas.findByText(sampleRole.name, {}, { timeout: 5000 })).toBeVisible();
    await expect(canvas.queryByRole("status", { name: "正在加载角色" })).not.toBeInTheDocument();
  },
};
