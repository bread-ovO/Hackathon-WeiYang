# Project instructions

- Read README.md and the relevant PRD / technical plan before changing product behavior.
- Keep domain logic platform-independent. Run `pnpm check:boundaries` after cross-package changes.
- Renderer code must use the typed preload bridge; never expose raw ipcRenderer, Node, credentials, or arbitrary file access.
- Model/provider and connector outputs are untrusted input. Validate before persistence or business decisions.
- Do not infer completion from inactivity. Keep archive, business status, and evidence status distinct.
- Use isolated test directories; do not read real chats, coding history, or credentials for tests.
- After changes, run relevant tests and typecheck. Run only E2E specs affected by the change; do not run the full E2E suite by default. For foundation changes, run relevant unit tests and boundary checks; run `pnpm package:dir` for native dependency or packaging changes. Repository CI workflows are intentionally removed. Verify changes locally with targeted checks; do not restore automatic full-suite CI unless the user requests it.
- Use `npx --yes pnpm@10.34.5` if the global pnpm command is unavailable. Do not change global developer tooling to compensate.
- Do not mark requirements complete merely because an interface or placeholder exists. Record verified scope and remaining gaps.
