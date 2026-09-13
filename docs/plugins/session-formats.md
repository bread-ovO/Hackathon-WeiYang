# Claude Code / Codex 会话格式与验证边界

BUGU 读取用户主动选择的目录，每个 `.jsonl` 文件独立授权、按 UTF-8 完整行增量同步。单文件每批最多 100 条消息，目录最多 200 个文件；更多内容点击「继续同步」，新增文件需要再次授权目录。没有自动扫描全部个人历史，也没有自动拉取云端聊天。

## 支持的消息形状

| 来源 | 识别与保留字段 | 排除内容 |
| --- | --- | --- |
| Claude Code | 顶层 type=user/assistant，uuid、timestamp、message.role；content 为字符串或 text 块数组 | 已知元数据；工具调用/结果、思考、图片等非文本块不作为用户承诺 |
| Codex | type=response_item，payload.type=message，payload.role=user/assistant，timestamp；input_text/output_text 块 | event_msg/session_meta/turn_context 等已知元数据；工具/推理项以及 system/developer 消息 |

未知记录/块类型、坏 JSON、已识别消息缺字段或超长正文会让当前文件报错，本批游标不提交；其他正常文件继续导入。错误不会显示消息正文或完整路径。空文本和已知纯非文本消息可跳过。字段修复后点击「继续同步」，已确认内容通过事件 ID/修订去重。

Codex 的 `ordinal` 可缺失或为 null。有合法 ordinal 时沿用旧版数字字符串 ID；否则使用读取器提供的行起始字节位置 `offset:<n>`。位置由文件读取器计算，消息不能伪造。追加、换行、中文、多批和重启后的进度保持稳定；此兼容方案限定追加式日志，不保证重排/重写文件后沿用原对象身份，也不保证找回已移走的未读轮转数据。

正常化器升级为 `@2`，使旧游标安全重扫，找回以前被静默跳过的无 ordinal 消息。已有合法 ordinal 或 Claude uuid 消息保留 ID、revision 和原文，不重复创建事项。同 ID 同修订变了内容则报冲突，不能通过重扫覆盖人工修改。历史导入曾截断过的超长消息现在会报错，不自动更改旧引用。

## 依据与局限

2026-09-14 核对 [Codex 官方 RolloutLine 定义](https://github.com/openai/codex/blob/a505c71490885a44979df056284badbfdd75b3fb/codex-rs/history/src/lib.rs)：ordinal 为可选 u64，时间与展开后的事件共同保存。BUGU 同时兼容有编号和无编号的上述消息形状，不把字段存在性绑定到某一个客户端版本。

[Claude Code 官方 hooks 文档](https://code.claude.com/docs/en/hooks)提供 transcript_path 用于定位会话文件；该入口不保证内部日志格式永远兼容。BUGU 明确校验上述受支持形状，未知变化给出诊断，不宣称支持所有版本。

测试只使用隔离目录中的虚构文本，按上述形状构造，不读取个人会话。桌面用例从授权→事件→后台候选→准确原文引用运行，并覆盖坏文件隔离、追加、重复同步、撤权；单元用例补足旧游标重扫和字节边界。第三方真实客户端导出的授权样本仍需独立验收，不将格式模拟测试冒充真实个人历史测试。

当前候选由有限规则生成，例如「我会提交验收报告。」；普通聊天、建议与相对日期不保证被理解。候选需要用户确认，不代表自动完成事项；通用语义模型和截止解析独立跟踪。
