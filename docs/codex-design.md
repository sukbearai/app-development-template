# Codex 界面设计审查

项目在 `.agents/skills/pstack-x-hallmark` 保存 Hallmark 的 Codex 适配版。它提供视觉审查、组件设计和参考页面分析，显式调用时才加载。默认只读审查，不改页面。

## 发现与使用

Codex 会从项目的 `.agents/skills` 发现该技能，无需安装到个人技能目录或创建全局链接。重新加载技能或开始新会话后，可以这样调用：

```text
$pstack-x-hallmark audit apps/web/components/admin/form-field.tsx
$pstack-x-hallmark 改进用户列表在窄屏上的布局，保留现有视觉体系。
$pstack-x-hallmark study <参考页面 URL>
```

本适配版针对 Codex 编写和验证，不修改 Claude Code 或 Cursor 配置。`.agents/skills` 是项目技能目录，本身不限制其他支持该约定的工具读取。技能不是应用运行依赖，也不参与 CI 自动设计评分。

## 项目约束与验证

新页面、结构改版或明确要求设计替代方案时，技能会按[设计参考选择指南](../.agents/skills/pstack-x-hallmark/references/design-selection.md)加载相关资料：

- Cobalt 用于技术页面的层级、代码展示和细线分隔。
- Grid 用于指标、表格、筛选区和设置页面的对齐。
- Workbench 用真实截图和操作说明组织产品介绍。
- Narrative Workflow 用于有真实阶段的流程与指南。
- Component Playground 复用 Storybook 展示组件与交互状态。

普通后台修改保持现有布局；审查中的结构替代只作为建议。用户要求新的官网或展示页视觉方向时，可以探索配色与字体，但样式限于该页面，不改变共享后台体系。

适配版识别 `apps/web` 的 vinext 运行方式，复用 `apps/web/app/globals.css` 中的视觉 tokens、现有字体和组件。后台页面保持同一设计系统，不自动轮换主题，不另建根目录 `tokens.css`。只在缺失信息影响设计决定时提问。

审查结果区分浏览器观察与源码推断。组件状态使用现有 [Storybook 流程](component-development.md)；页面改动使用项目的 [浏览器验证技能](../.agents/skills/verify-pstack-x/SKILL.md)。没有实际观察的视口、交互和状态不计为通过。

适配来源为 [Nutlope/hallmark](https://github.com/Nutlope/hallmark)，版本 1.1.0，提交 `13ac0ec7e148655948100b6396439e481361d690`。只保留适合当前项目的规则，完整来源与 MIT 许可见 [技能入口](../.agents/skills/pstack-x-hallmark/SKILL.md) 和 [LICENSE](../.agents/skills/pstack-x-hallmark/LICENSE)。升级时对照此提交审查规则变化，避免覆盖项目适配。

各参考文件的来源由 `tools/upstream-sources.json` 分别记录。运行 `pnpm tooling:upstream:check --remote` 查询更新，按[来源维护流程](tooling-updates.md)审查并更新受影响的参考；未修改的参考保留原提交记录。
