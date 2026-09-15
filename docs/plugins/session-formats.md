# Claude Code / Codex / Kimi 会话格式与验证边界

BUGU 读取用户主动选择的目录，每个 `.jsonl` 文件独立授权、按 UTF-8 完整行增量同步。单文件每批最多 100 条消息，目录最多 200 个文件；更多内容点击「继续同步」，新增文件需要再次授权目录。没有自动扫描全部个人历史，也没有自动拉取云端聊天。

## 支持的消息形状

| 来源        | 识别与保留字段                                                                                              | 排除内容                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claude Code | 顶层 type=user/assistant，uuid、timestamp、message.role；content 为字符串或 text 块数组                     | 已知元数据；工具调用/结果、思考、图片等非文本块不作为用户承诺                           |
| Codex       | type=response_item，payload.type=message，payload.role=user/assistant，timestamp；input_text/output_text 块 | event_msg/session_meta/turn_context 等已知元数据；工具/推理项以及 system/developer 消息 |

未知记录/块类型、坏 JSON、已识别消息缺字段或超长正文会让当前文件报错，本批游标不提交；其他正常文件继续导入。错误不会显示消息正文或完整路径。空文本和已知纯非文本消息可跳过。字段修复后点击「继续同步」，已确认内容通过事件 ID/修订去重。

Codex 的 `ordinal` 可缺失或为 null。有合法 ordinal 时沿用旧版数字字符串 ID；否则使用读取器提供的行起始字节位置 `offset:<n>`。位置由文件读取器计算，消息不能伪造。追加、换行、中文、多批和重启后的进度保持稳定；此兼容方案限定追加式日志，不保证重排/重写文件后沿用原对象身份，也不保证找回已移走的未读轮转数据。

正常化器升级为 `@2`，使旧游标安全重扫，找回以前被静默跳过的无 ordinal 消息。已有合法 ordinal 或 Claude uuid 消息保留 ID、revision 和原文，不重复创建事项。同 ID 同修订变了内容则报冲突，不能通过重扫覆盖人工修改。历史导入曾截断过的超长消息现在会报错，不自动更改旧引用。

## 依据与局限

2026-09-14 核对 [Codex 官方 RolloutLine 定义](https://github.com/openai/codex/blob/a505c71490885a44979df056284badbfdd75b3fb/codex-rs/history/src/lib.rs)：ordinal 为可选 u64，时间与展开后的事件共同保存。BUGU 同时兼容有编号和无编号的上述消息形状，不把字段存在性绑定到某一个客户端版本。

[Claude Code 官方 hooks 文档](https://code.claude.com/docs/en/hooks)提供 transcript_path 用于定位会话文件；该入口不保证内部日志格式永远兼容。BUGU 明确校验上述受支持形状，未知变化给出诊断，不宣称支持所有版本。

测试只使用隔离目录中的虚构文本，按上述形状构造，不读取个人会话。桌面用例从授权→事件→后台候选→准确原文引用运行，并覆盖坏文件隔离、追加、重复同步、撤权；单元用例补足旧游标重扫和字节边界。第三方真实客户端导出的授权样本仍需独立验收，不将格式模拟测试冒充真实个人历史测试。

授权内容由启用的真实模型分段提取并复核，支持明确承诺、行动请求及后续进展；任务带原文来源进入待确认清单。模型未配置或失败时不生成替代任务，模型阶段不自动完成事项。覆盖及评测见 [真实模型提取](../engineering/真实模型任务提取与分段复核_2026-09-15.md)。

## Kimi Code CLI（L06）

新增「Kimi 会话」预置入口。只选择 `wire.jsonl`，排除没有逐条发生时间、可能因压缩而重写的 `context.jsonl`。默认选择起点为 `~/.kimi/sessions`，用户也可选其他目录。目录授权、分文件错误、续传与撤销规则沿用上述本地导入机制。

核对 [Kimi 官方 Wire 日志定义](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/wire/file.py) 与 [消息类型](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/wire/types.py)：记录包含秒级 Unix `timestamp` 和 `message:{type,payload}`。支持 1.1–1.10 metadata；TurnBegin/SteerInput 的 user_input 进入 user，TextPart 的 text 进入 assistant。已知工具/思考/控制事件跳过，未知结构报错。助手流式文本保留为原始片段，不冒充完整用户消息，也不触发用户承诺规则。

使用可信行字节位置生成稳定 ID；消息时间转成 UTC，绝不使用文件修改时间。相对截止时间按事件标注时区（Wire 为 UTC）解释；无法从 Wire 还原用户当时的本地时区，用户应在候选中核对。格式契约来自官方源码，测试正文由隔离合成样例提供；未读取真实个人历史。
