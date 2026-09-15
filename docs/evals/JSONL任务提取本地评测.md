# JSONL 任务提取本地评测

这套评测检查：授权读取 JSONL 后，该跟进的任务是否进入清单，是否漏项、误收、重复，以及阶段和原文依据是否正确。所有输入均为仓库中的合成会话，数据库、JSONL 和 CLI 工作目录独立隔离；不扫描个人会话，不读取或复制登录凭据。

当前实现统一走真实模型，已删除规则提取选项。历史数据保留在 [旧基线与问题清单](JSONL提取基线_2026-09-15.md)；当前结果见 [真实模型提取修复评测](真实模型提取修复评测_2026-09-15.md)，实现见 [分段提取与复核](../engineering/真实模型任务提取与分段复核_2026-09-15.md)。

## 数据集与独立性

- `tests/fixtures/extraction/corpus.ts`：原有 60 个会话、49 个目标。普通 JSONL、Codex、Claude Code、Kimi 各 15 个，涵盖承诺、指令、多目标、进展、无任务与上下文。
- `tests/fixtures/extraction/holdout.ts`：修复前补充固定的 40 个验证会话、33 个目标，四种格式各 10 个。包含新措辞、否定、引用、独立目标、采纳建议、长会话及远距离验收。

原 60 例和评分器保持不变。基于其失败案例调整生产提示词与处理逻辑，不修改标注，不删除难例，不用选择性重试拼出好成绩。40 例也由开发代理编写，未经独立人工标注，属于额外合成验证集，不能视为真实用户留出集。若根据该集调参，应将其列为回归集，并另建独立验证集。

格式分组使用不同内容，组间分数不代表解析器孰优；生产 mapper 的逐字、角色与 ID 一致性另由 round-trip 单元测试验证。

## 运行

```sh
# 原 60 例、新 40 例、全部 100 例
pnpm eval:extract --live --suite baseline --output test-results/extraction/baseline
pnpm eval:extract --live --suite holdout --output test-results/extraction/holdout
pnpm eval:extract --live --suite all --output test-results/extraction/all

# 单例定位与完整重复运行；每轮分别报告
pnpm eval:extract --live --case request-fix
pnpm eval:extract --live --suite all --repeat 2

# Claude CLI；不指定模型时如实记录为 CLI 默认
pnpm eval:extract --provider claude-cli --live --suite all --model <模型名>

# API 仅使用评测专用 BUGU_EVAL_API_KEY 环境变量；不要将密钥写入命令或报告
pnpm eval:extract --provider responses --live --suite all --base-url https://api.openai.com/v1 --model <模型名>
pnpm eval:extract --provider chat-completions --live --suite all --base-url https://api.openai.com/v1 --model <模型名>
```

没有全局 pnpm 时使用 `npx --yes pnpm@10.34.5`。必须显式 `--live`；默认提供方为 Codex CLI。每次至多 100 例、3 轮。`--target` 默认 0.99。子集报告带 `subset: true`，子集达标不能解释为完整集达标。

每段真实模型提取、复核各一次，合计共用 60 秒超时。连续 3 次模型失败后停止后续请求，未运行案例留在分母。纯工具或助手记录没有可分析的用户上下文时不请求模型；不把它们算成模型调用。CLI 自行处理已有登录，调用使用临时工作目录、禁工具、禁规则加载和不持久会话参数。

`report.json` 保存每例预期、预测、引用、阶段、原始模型回复、错误、耗时、窗口数、实际调用数、幂等和人工状态保护结果，另存语料及代码哈希。`report.md` 汇总结果；`fixtures/*.jsonl` 为实际读取的输入。CLI 未暴露实际路由模型名，报告只记录 CLI 版本和请求模型标识，不猜测服务端模型。

## 计分与 99% 门槛

真正计分的是生产 `readLocalJsonl → source observation → analyzeTasks → discover → SQLite 任务` 链路，包含两遍真实模型、结构校验、原文校验和最终入库。脚本先确认来源处理没有创建任何规则任务，再遍历全部会话片段，并重放写入和游标检查幂等。

任务必须命中运行前标注的目标词组，并引用原请求消息 ID 和逐字原文。一对一最大匹配保证：重复预测只算一个正确任务，合并了两个独立任务的预测也只能匹配一个。

| 指标 | 口径 |
| --- | --- |
| 精确率 | TP / (TP + FP)：收进来的任务有多少正确 |
| 召回率 | TP / (TP + FN)：应该收录的任务找到多少 |
| F1 | 精确率与召回率的调和平均 |
| 会话完全正确 | 无漏项、无多项，所有阶段和必要后续依据都正确 |
| 错误、覆盖与持久化 | 失败不移出分母；检查窗口是否截断、无规则建项、重放无重复、业务状态未自动完成 |

完整运行必须同时满足精确率、召回率、会话完全正确率 ≥99%，无模型错误或覆盖截断，且写入检查通过，命令才返回成功。没有任何任务预测时精确率为 N/A，不伪装为 100%。JSON 中 `runs[].combined` 沿用历史字段名，目前仅表示真实模型最终入库结果，没有混合规则输出。

关键词匹配无法完整衡量语义等价，严格标题改写可能被计漏项；因此原始预测保留供复核，不悄悄改评分器。暂不评价日期/负责人提取、跨会话或跨渠道归并、工具结果真实性。

会话完全正确率附 Wilson 95% 区间，仅作样本量参考。合成分布、未独立标注和案例相关性都会影响外推；重复运行不增加独立样本量。固定集 100% 不足以声称真实场景稳定达到 99%。

## 桌面 E2E 与回归

```sh
pnpm exec vitest run tests/unit/extraction-score.test.ts tests/unit/extraction-format.test.ts tests/unit/task-analyzer.test.ts tests/unit/automatic-analysis.test.ts tests/unit/task-model-host.test.ts
pnpm test:storage model-only-extraction-integration task-analysis-integration processing-integration
pnpm build

# 未配置模型、暂停与重启路径可离线验证
pnpm test:desktop tests/desktop/jsonl-extraction.spec.ts tests/desktop/processing.spec.ts

# 四种 JSONL：真实模型、实际后台调度、入列、引用、增量与重放
BUGU_EVAL_LIVE=1 pnpm test:desktop tests/desktop/jsonl-extraction.spec.ts tests/desktop/processing.spec.ts
```

文件选择器使用测试路径，其余走真实读取、模型、IPC、存储和 UI。包含不完整尾行、重复同步、任务到达动画，以及后台新增时保留编辑草稿。无模型对照验证任务始终为零；暂停控制跨重启保留。存储和边界测试使用的合成模型响应仅用于事务、授权及校验测试，不计入真实模型准确率。

只运行受影响的 E2E，不恢复全量 CI。
