# 添加 shadcn/ui 组件

在仓库根目录运行以下命令，按需添加组件：

```sh
pnpm --filter @pstack/web exec shadcn add <component>
```

检查生成代码，把 `import { cn } from "cn"` 改为项目提供的合并函数：

```ts
import { cn } from "@/lib/class-names";
```

当前官方 registry 直接导入 `cn`，CLI 不会把该导入改写为 `components.json` 的 `aliases.utils`。项目使用 `createCn({ prefix: "tw" })`，以便调用者的 `tw:h-12` 等类名正确覆盖组件默认值。

为新增工具类使用 Tailwind v4 的 `tw:` 前缀，例如 `tw:flex`、`tw:hover:bg-primary/90`。保留 `app/tailwind.css` 中的独立 theme、utilities 导入，不要替换成包含全局 Preflight 的入口。现有页面的 `.grid`、`.muted` 和表单 CSS 继续使用原规则。检查新增组件是否需要补充局部浏览器样式归一。

使用 `tw:font-sans` 或明确的字体族主题 token。当前 `cn@0.2.6` 对 `font-[Inter]` 等任意字体值存在分类限制，避免用这种写法覆盖字体族。

颜色映射位于 `app/tailwind.css`。修改主题时保留现有 `--muted` 的文字色含义；shadcn 的 muted 背景映射到 `--surface-soft`，muted foreground 映射到 `--muted`。

添加交互示例到 `apps/web/stories/ui`，验证类名覆盖的实际样式、输入和键盘操作，然后运行：

```sh
pnpm --filter @pstack/web typecheck
pnpm --filter @pstack/web storybook:test
pnpm lint
pnpm duplication:check
pnpm dependency:check
pnpm conventions:check
```

## 组件来源

Button、Input、Dialog 来源于 [shadcn/ui new-york-v4 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json)，采用 [MIT License](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)，Copyright (c) 2023 shadcn。项目调整了类名前缀、导入路径及关闭按钮中文文案。组件源代码属于项目，可在遵守上游许可证的前提下按需修改。

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
