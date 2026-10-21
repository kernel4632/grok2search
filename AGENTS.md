# AGENTS.md

## Git 工作流

- 任何代码/文档修改完成后，立即 `git add`、提交并推送到 `origin/main`，不要等用户提醒。
- 提交前至少运行 `bun test` 和 `bun x tsc --noEmit`。
- 不提交 `config.json`、`accounts.json`、`data/` 等含凭据或运行时数据的文件。
