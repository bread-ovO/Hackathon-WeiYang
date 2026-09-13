# 开发一个 BUGU 来源插件

当前开放的是只读、声明式 **Source** 插件：一个 JSON manifest 描述 HTTP 或 JSONL 数据如何映射成事件。无需修改 BUGU 核心，不运行插件 JavaScript、shell 或模型代码。Skill、Verifier、任意 SDK 插件尚未开放。

## 十分钟本地样例

在仓库根目录安装依赖后执行（Node 22.12+、pnpm 10.34.5）：

```bash
node scripts/check-source-plugin.mjs examples/sources/release-notes/plugin.json examples/sources/release-notes
```

预期输出 `{"ok":true,"kind":"local-jsonl","events":2,"done":true}`。命令只校验及读取样例，不写事项库、不启动网络、不打印正文。只传 manifest 路径时仅校验声明；HTTP 插件此命令不做联网试运行。较大文件的 `done:false` 表示本次达到批量上限，不能视为整个文件验收完成。

1. 启动 BUGU，在「我的工作区」创建测试项目。
2. 到「连接」→「插件」→「安装插件」，选择本仓库 `examples/sources/release-notes/plugin.json`。
3. 选择项目，点击「选择目录并试运行」，选 `examples/sources/release-notes` 目录。
4. 核对权限和试运行样例后点击「启用插件」。试运行本身不写入事项库，启用后才按声明间隔采集。
5. 在真实工作区查看候选「提交发布检查报告」及原文。两条事件中只有 user 的明确承诺生成候选；assistant 的建议不会生成用户承诺。若整理被暂停，先恢复本地候选整理。
6. 停用后不再采集；重新安装/试运行可启用。已收录历史保留，停用不是删除。

所有内容均为虚构样例。可以复制目录并修改 manifest 的 `id`、名称、相对文件名及字段映射，再授权复制后的目录。不要把私有凭据或真实工作内容提交到样例中。

## 契约与映射

- 可下载的 [JSON Schema](source-manifest.schema.json) 与运行时 [manifest.ts](../../packages/plugin-host/src/manifest.ts) 完全一致，测试防止二者漂移。
- 完整字段及两个传输示例见 [manifest v1](../engineering/插件manifest协议_v1.md)。
- 映射使用 JSON Pointer：`/note/body` 指向每条记录的正文，`~0`/`~1` 转义 `~`/`/`；不是 JS、模板或 JSONPath。
- `externalId` 是对象稳定标识，`revision` 是其版本，必须是字符串。同一对象修改内容必须换 revision；重放同修订应返回完全一致的内容、角色与时间。
- `occurredAt` 提供带时区的合法时间；`role` 取 user/assistant/tool/system。不要将机器人输出统一标成 user。
- 插件只输出事件，来源实例 ID 与授权版本由宿主注入。不能直接设置事项状态或绕过人工确认。
- 当前映射不支持数组展开、表达式计算和自定义转换代码；上游需提供可映射字段。复杂来源可以先由自有工具导出 JSONL，再交由 BUGU 只读收录。

## 两种运行方式

| 类型 | 数据结构 | 授权与限制 |
| --- | --- | --- |
| local-jsonl | 每行一个 UTF-8 JSON 对象，末尾换行 | 用户选择目录，只读 `transport.file` 指定的相对文件；不支持 glob、绝对路径、父级跳转或符号链接；最多 16 MiB/文件、128 KiB/行 |
| http-json | 响应 JSON 中的记录数组，recordsPointer 定位 | 仅允许已声明的单一公网 HTTPS 域名、443、GET；拒重定向、私网、任意 headers 和 URL 插值；凭据通过宿主保险库槽位授权 |

HTTP 的可安装示例见 [github-release-assets.json](../../examples/sources/github-release-assets.json)。自有 API 使用完整字段示例调整 recordsPointer 和 pagination；游标必须由服务器响应提供，空游标结束，循环游标会报错。每轮最多 20 页，响应最多 2 MiB，声明的记录预算也会生效。开发时先校验 manifest，再通过界面授权和试运行真实可访问的公开或已授权服务；不能把 JSON 校验成功当成联网验收成功。

凭据不写进 manifest。到设置保存凭据，在安装时选择用途匹配的引用。域名、凭据用途或文件范围变化后必须重新安装并授权试运行；失败时旧版本仍保留。当前没有历史版本列表的一键回退，需要重新安装所保留的旧 manifest 并重新试运行。

## 错误与恢复

| 现象 | 处理 |
| --- | --- |
| PLUGIN_MANIFEST_INVALID | 检查缺字段、类型、版本范围及额外字段；不能在 manifest 加 `$schema`，可通过编辑器外部关联本仓库 Schema |
| INVALID_JSONL / INVALID_UTF8 | 修复完整坏行或编码；末尾未完成行会留到下次，不提前确认游标 |
| INVALID_SOURCE_EVENT | 检查映射结果的角色、时间、ID、revision、正文长度；不隐式转数字为字符串 |
| SOURCE_REVISION_CONFLICT | 同一修订内容变化；保留旧版本并用新 revision 发布修改 |
| 路径/网络授权拒绝 | 重新选择正确目录或公网 HTTPS 域名；不要通过关闭校验来绕过 |
| 收录额度暂停 | 查看收录与磁盘预算，释放空间或调整预算后恢复；失败批次不推进游标 |

本地轮询支持追加和当前路径变化后的重扫，依靠稳定 ID/修订去重；不保证找回已被删除或移走的未读旧文件。需要可靠轮转时，上游保留记录并提供持久稳定 ID，或使用可回放的 HTTP 游标接口。

## 开发验证

```bash
# 新增或修改插件时仅运行相关测试
npx --yes pnpm@10.34.5 exec vitest run tests/unit/plugin-documentation.test.ts tests/unit/plugin-manifest.test.ts
# 运行时 Schema 变更后重新导出
node scripts/check-source-plugin.mjs --schema > docs/plugins/source-manifest.schema.json
```

公开源码接口包括 `parseSourceManifest`、`readLocalJsonl`、`createHttpJsonReader`（以 [导出入口](../../packages/plugin-host/src/index.ts) 为准）；它们供 BUGU 宿主及测试使用，并非插件可执行入口。界面安装始终只读取 JSON。样例测试覆盖嵌套字段映射和非法权限拒绝；第三方独立开发者的接入耗时/可用性仍需实测，不伪称自动化用例就是独立用户验收。
