import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

function ComponentExamples() {
  return (
    <div className="tw:grid tw:max-w-md tw:gap-6">
      <label className="tw:grid tw:gap-2">
        显示名称
        <Input placeholder="输入名称" />
      </label>
      <div className="tw:flex tw:flex-wrap tw:gap-3">
        <Button className="tw:h-12 tw:px-8">自定义按钮</Button>
        <Button variant="outline">次要操作</Button>
        <Button disabled>不可用</Button>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button>打开对话框</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑显示名称</DialogTitle>
            <DialogDescription>完成后关闭对话框，返回原来的操作位置。</DialogDescription>
          </DialogHeader>
          <label className="tw:grid tw:gap-2">
            新名称
            <Input placeholder="输入新名称" />
          </label>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const meta = {
  title: "UI/Components",
  component: ComponentExamples,
} satisfies Meta<typeof ComponentExamples>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const customButton = canvas.getByRole("button", { name: "自定义按钮" });
    await expect(customButton).toHaveStyle({ height: "48px", paddingLeft: "32px" });
    await expect(customButton).not.toHaveClass("tw:h-9", "tw:px-4");
    await expect(canvas.getByRole("button", { name: "不可用" })).toBeDisabled();

    const name = canvas.getByLabelText("显示名称");
    await userEvent.type(name, "张三");
    await expect(name).toHaveValue("张三");

    const trigger = canvas.getByRole("button", { name: "打开对话框" });
    await expect(trigger).toHaveStyle({ borderWidth: "0px" });
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "编辑显示名称" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription("完成后关闭对话框，返回原来的操作位置。");
    const dialogInput = within(dialog).getByLabelText("新名称");
    await waitFor(() => expect(dialogInput).toHaveFocus());
    await userEvent.type(dialogInput, "李四");
    await expect(dialogInput).toHaveValue("李四");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    const reopened = await page.findByRole("dialog", { name: "编辑显示名称" });
    await userEvent.click(within(reopened).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
