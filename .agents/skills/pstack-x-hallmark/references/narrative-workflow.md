# Narrative Workflow for real stages

Use when the task has an actual order, such as initialization, upload processing, or recovery. A single action does not need a wizard or a numbered timeline.

For a guide, show the prerequisites, ordered steps, expected result of each step, and the next action. Name stages with the user's actions. Add a small real capture only when it clarifies the step. Keep navigation and explanations accessible without animation.

For an existing workflow UI, derive stages and labels from the implemented state and contracts. Distinguish a user action from an asynchronous system step. Show progress, failure, retry, and completion only where the real behavior supports them. An unknown duration does not justify a fabricated percentage or ETA.

Preserve existing retry, authorization, transaction, and idempotency behavior. Do not add cancellation, rollback, or a recovery operation merely because it would fit the diagram. A recovery guide may describe an operation without authorizing the agent to run it.

Use a semantic ordered list or the established stepper component. Keep the current step identifiable beyond color. On narrow screens, prefer a readable vertical sequence. Preserve access to the active form and its errors rather than compressing every stage into the viewport.

Adapted from [Hallmark Narrative Workflow](https://github.com/Nutlope/hallmark/blob/13ac0ec7e148655948100b6396439e481361d690/skills/hallmark/references/macrostructures/14-narrative-workflow.md). Large decorative stage numbers and animated transitions are optional visual choices.
