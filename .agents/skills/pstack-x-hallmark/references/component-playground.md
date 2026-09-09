# Component Playground through Storybook

Use for component documentation, usage examples, and interactive states. The existing `apps/web/stories` and Storybook setup are the implementation home; do not create a competing gallery or preview server.

Group examples by a useful capability such as forms, navigation, data display, or feedback. Import the production component. Present a real preview beside its minimal usage example and explain any meaningful variant or state.

Expose only relevant controls and states. Reuse existing Storybook request handlers and decorators to show pending, failure, success, empty, and slow-response behavior. Label fixtures as examples. Keep mocks out of production modules and respect shared contracts.

Make example code match the rendered component and its public props. A copy action must copy the displayed code and provide accessible feedback. Do not add framework-switching tabs to a React-only project or duplicate the same example for visual variety.

Use story interaction tests for actual keyboard and pointer behavior. Run the relevant Storybook checks from the skill entrypoint and inspect the rendered states. Storybook verifies isolated components; application authorization, persistence, and routing still need the project's application verification.

Adapted from [Hallmark Component Playground](https://github.com/Nutlope/hallmark/blob/13ac0ec7e148655948100b6396439e481361d690/skills/hallmark/references/macrostructures/21-component-playground.md). The existing Storybook implementation replaces the upstream standalone code-and-preview page format.
