# 极简化作战 · SLIM MISSION（小而美）

> 目标：学习 pi（badlogic 极简编码代理）的思路——**每个概念只留一个实现，其余全删**。
> 用户已授权持续自主工作，直到达成下方完成标准。
> 本文件是唯一进度真相源：每次运行必须先核对上一次记录是否属实，再取下一任务。

## 基线（2026-09-14，main @ fda1ee5 / PR #120）

- 生产代码：39,763 行（packages/ + apps/，不含 dist）
- 测试代码：34,103 行（tests/）——测试/生产比 0.86，目标 < 0.7
- 已解决：model-store .ts/.js 双胞胎（后续 PR 已清，P0 免做）

## 任务清单

- [ ] T1 删 `packages/evals` 占位包（3 行接口+注释），连同 workspace 引用
- [ ] T2 storage 影子层裁决：`jobs.ts` vs `foundation/jobs.ts` 二选一，迁移调用点后删另一个
- [ ] T3 storage 影子层裁决：`search.ts` vs `foundation/search.ts`
- [ ] T4 storage 影子层裁决：`task-model.ts` vs `foundation/tasks.ts`（注意 task-model 已被重构到 753 行，可能已是存活方）
- [ ] T5 连接器收敛：`packages/connectors`（feishu/github/http/polling）与 `apps/desktop/src/main/{feishu,github}-runtime.ts`、`source-http.ts` 的源逻辑双写收敛；desktop 只留 IPC 接线
- [ ] T6 巨型文件拆分（>800 行）：`plan-changes.ts`(1211)、`source-associations.ts`(1042)、`export.ts`(992)、`main.tsx`(969)、`pet-live2d.ts`(905)、`timeline.ts`(883)、`desktop-controller.ts`(842)
- [ ] T7 测试瘦身：合并 tests/unit 与 tests/desktop 中测同一逻辑的用例；删测 mock 的 mock；保持验收覆盖不减
- [ ] T8 终验：全量相关单测 + typecheck + check:boundaries 全绿，标记 MISSION COMPLETE，开 PR

## 规则（每条都必须遵守）

1. 遵守仓库 `AGENTS.md`：改后跑相关单测与 typecheck；跨包改动跑 `pnpm check:boundaries`；默认不跑全量 E2E。
2. **不删需求功能**，只删重复实现/死码。删模块前先 grep 确认无调用点。
3. 只动 `chore/slim` 分支；绝不 force-push、绝不直接推 main、不动他人分支。
4. 完成一个任务 = 提交（conventional commit，注明净删行数）+ 推送 origin + 在下方日志追加记录（时间/做了什么/验证证据/下一步）。
5. 测试/typecheck 失败不许记为完成；修复后重验，或如实记录失败原因。
6. **不得凭接口存在推断完成**（AGENTS.md 原文）。验证靠跑，不靠看。

## 完成标准（MISSION COMPLETE 条件）

- 无同概念双实现（T2-T5 全做完）
- 无占位/死包；无 >800 行生产文件
- 测试行数 / 生产代码 < 0.7
- 相关单测、typecheck、check:boundaries 全绿
- 向 main 开 PR（`chore: 极简化瘦身——影子层收敛、死包清除、巨型文件拆分`）

## 进度日志（追加，勿删历史）

### 2026-09-14（会话启动）
- 建立工作树 `../slim-work`（分支 chore/slim @ fda1ee5），写作战文件。
- 下一步：T1 删 evals 死包 → 跑 typecheck 验证 → 提交推送。
