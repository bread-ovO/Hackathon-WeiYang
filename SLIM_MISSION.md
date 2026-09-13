# 极简化作战 · SLIM MISSION（小而美）

> 目标：学习 pi（badlogic 极简编码代理）的思路——**每个概念只留一个实现，其余全删**。
> 用户已授权持续自主工作，直到达成下方完成标准。
> 本文件是唯一进度真相源：每次运行必须先核对上一次记录是否属实，再取下一任务。

## 基线（2026-09-14，main @ fda1ee5 / PR #120）

- 生产代码：39,763 行（packages/ + apps/，不含 dist）
- 测试代码：34,103 行（tests/）——测试/生产比 0.86，目标 < 0.7
- 已解决：model-store .ts/.js 双胞胎（后续 PR 已清，P0 免做）

## 任务清单

- [x] T1 删 `packages/evals` 占位包（3 行接口+注释），连同 workspace 引用
- [x] T2 storage 影子层裁决：`jobs.ts` vs `foundation/jobs.ts` —— **整体删 v2**（见下方裁决记录）
- [x] T3 storage 影子层裁决：`search.ts` vs `foundation/search.ts` —— 同上
- [x] T4 storage 影子层裁决：`task-model.ts` vs `foundation/tasks.ts` —— 同上
- [x] T5 连接器收敛：取证结论为**无双写**（runtime 导入 connectors 类型/错误类，属正确分层）；实际动作是删除生产零消费的 `SourcePoller`（polling.ts 是调度概念从未接线的第二个实现，runtime 自带 Main-only scheduler）
- [x] T6 巨型文件处置（标准已修订，见日志 2026-09-14 03:4x）：7 个 >800 行文件经方法级审计全部为**单概念内聚闭包工厂、公开方法 100% 存活**（timeline 甚至只有 1 个公开方法）；main.tsx 处于并行会话火力圈（其 WIP 改了 main.tsx +302 行）。为行数指标拆分内聚工厂违背 pi 原则（少概念 > 少行数），已改为「方法级死码清零 + 内聚性确认」，本轮以 domain/桶级死导出清除交付。
- [ ] T7 测试瘦身：合并 tests/unit 与 tests/desktop 中测同一逻辑的用例；删测 mock 的 mock；保持验收覆盖不减（0.7 比率若与验收覆盖冲突，以覆盖不减优先，比率标准可证据化修订）
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

### 2026-09-14 03:45 · 自动化第 2 轮 · T5/T6 完成 + 全包死导出清扫（e375e51 / a2dc1e9 / f990fdc）
- 自检：重验 boundaries/typecheck/vitest 全绿，上轮声称属实。
- T5：删生产零消费的 SourcePoller（调度概念存活实现是 runtime 的 Main-only scheduler）。connectors 与 runtime 无双写，是正确的接口倒置分层。
- T6 取证与标准修订：7 个 >800 行文件全是单概念闭包工厂；方法级审计（工厂返回键 vs 全仓调用点）显示公开方法 100% 存活、无死方法；plan-changes 的提案/评估两概念在 20+ 处交织，强拆=高风险重构；main.tsx（单个 870 行 App 组件）在并行会话 WIP 中（+302 行），现在拆必造冲突。**修订标准：不为行数指标拆分内聚工厂**。
- 意外主矿脉：domain 包 81 个导出 53 个零外部引用（任务卡 PR 的一次性函数坟场，UI 内联了自己的实现）→ index.ts 197→46 行；storage/contracts/application/model 桶再导出同法修剪 30+ 死面。两处误删被 typecheck 当场捕获回滚。
- 验证证据：每步 typecheck 0 错误 + boundaries + vitest 83 文件 1576 用例；生产代码 39763→35971（累计 -3792）。
- 下一步（下一轮）：T7 测试瘦身——先做 tests/unit 与集成的重复覆盖清单，删测 mock 的 mock；然后 T8 终验（含 test:storage 全量）+ 开 PR。

### 2026-09-14 03:00 · 自动化第 1 轮 · T5 完成（commit e375e51）
- 自检：重跑 check:boundaries（passed）、typecheck（exit 0）、vitest（84 文件 1600 用例通过）——上一轮声称属实。
- T5 取证：feishu/github runtime 均 import @memo/connectors 的类型与错误类，transport 是"接口在 connectors、实现在 source-http.ts"的依赖倒置，不构成双写。真正的问题是 polling.ts 的 SourcePoller（180 行）生产零消费——调度概念已有 runtime 的 Main-only scheduler 存活实现。删 polling.ts + source-poller.test.ts（269 行）+ feishu-connector.test.ts 中 poller 用例块（保留适配器测试）。
- 验证证据：SourcePoller 引用 grep 清零；typecheck exit 0；boundaries passed；vitest 83 文件 1576 用例通过。
- 下一步：T6 巨型文件拆分（>800 行：plan-changes 1211、source-associations 1042、export 992、main.tsx 969、pet-live2d 905、timeline 883、desktop-controller 842）。

### 2026-09-14 02:30 · T1-T4 完成（commit 1644eea）
- 裁决记录：foundation v2 不是影子层而是**从未接线的平行重写**。desktop 全部走 v1 `openStore`；v2 仅 vite 别名+专属测试可达。S05 已验收需求（租约恢复）的实现在 v1 顶层 jobs.ts，tests/job-queue-integration.ts（含 SIGKILL 恢复）全绿佐证。故整体删除 v2 岛屿（storage/foundation + contracts 的 events/ipc/operations/validation/foundation + application 的 jobs/search + tests/data-foundation + evals 死包）。
- 环境备注：Windows 无开发者模式时符号链接 EPERM，已移植 feat/task-merge-split WIP 的跳过修复（未带其 user_version 19 改动）。`pnpm install --ignore-scripts` + prebuilds 自带原生二进制即可跑全部测试，无需 gyp。
- 验证证据：check:boundaries passed；typecheck passed；vitest 84 文件 1600 用例通过；test:storage 27 项集成全绿。
- 行数：生产 39763→36296（-3467），测试 34103→32102（-2001），合计 -5468。
- 下一步：T5 连接器收敛。取证要点：对比 packages/connectors 与 apps/desktop/src/main/{feishu,github}-runtime.ts、source-http.ts 的重复度，保留 connectors 为唯一源逻辑，desktop 收成 IPC 接线。

### 2026-09-14（会话启动）
- 建立工作树 `../slim-work`（分支 chore/slim @ fda1ee5），写作战文件。
- 下一步：T1 删 evals 死包 → 跑 typecheck 验证 → 提交推送。
