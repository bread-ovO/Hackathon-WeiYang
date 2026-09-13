# Source 插件 manifest 协议 v1

2026-09-13 · P01。本文定义声明式插件的安装前契约。后续已新增 local-jsonl 和 HTTPS JSON 读取模块，见 [HTTP 运行时](HTTP声明式来源运行时_2026-09-13.md)；安装、持久授权、试运行与 HTTP 界面已接入；当前使用步骤见 [插件开发指南](../plugins/README.md)。它不会加载插件代码。

## 唯一字段定义与 API

运行时唯一字段定义在 `packages/plugin-host/src/manifest.ts` 的 `pluginManifestSchema`，采用 JSON Schema Draft-07，Ajv 严格验证；`SourceManifest` 从 Schema 派生。Schema 的 `$id` 仅用于识别，不需要发起网络请求。

- `validateSourceManifest(unknown, hostVersion?)` 返回 `{ ok: true, manifest }` 或 `{ ok: false, issues }`。成功结果是与输入分离的副本。
- `parseSourceManifest(unknown, hostVersion?)` 返回同一派生类型，失败抛 `InvalidSourceManifestError`，包含结构化 `issues`。
- `isHostApiCompatible(range, hostVersion?)` 判断宿主稳定版本是否落在区间内。
- 当前宿主 API 版本为 `1.0.0`；仅支持 `schemaVersion: 1`、`sourceType: "source"`，未知 kind、未知字段和不兼容版本均拒绝。

调用者应先将包内 manifest 按严格 UTF-8 JSON 解码，并限制文本大小（上限 128 KiB），再传入此 API。校验器接收 JSON 值，不读取文件，不解析可执行对象或字符串模板。

## 共同字段

| 字段 | 含义与约束 |
| --- | --- |
| `id` | 2–64 字符，小写 ASCII 字母开头，其余为字母、数字和单个分段连字符；不可作为路径直接拼接 |
| `version` | 严格三段 SemVer，可带合法预发布和 build 标识；每个主版本数最多 9 位，总长 128 |
| `schemaVersion` | 固定 1 |
| `sourceType` | 固定 source；Skill、Verifier 不在 v1 开放范围 |
| `displayName` | 1–80 字符的展示名称，UI 作为纯文本显示 |
| `hostApiRange` | `minInclusive` ≤ 宿主 < `maxExclusive`；两端为无预发布/build 的三段稳定版本。最小值必须小于上界。不接受 `^`、`~`、`*` 或 npm 字符串表达式 |
| `sampling` | `intervalSeconds` 为 60–86400，`maxRecordsPerRun` 为 1–1000 |
| `mapping` | 只映射 externalId、revision、occurredAt、role、text，五项必填 |

所有对象禁止额外字段。`code`、`eval`、`shell`、`command`、headers、任意依赖和插值表达式均不属于协议。

## 权限声明与传输

`permissions` 始终包含 domains、directories、credentials，禁止把实际 token、真实用户目录或环境变量写入 manifest。声明只是申请，不能替代用户授权。

`http-json` 首版只支持一个明确 ASCII DNS 域名和 HTTPS GET，不支持通配域、IP 字面量、localhost、用户信息、非 443 端口、fragment 或静态查询串。URL 域名必须与声明完全一致。可申请一个凭据槽位，用 id 和 purpose 说明；`credentialId` 必须对应该槽位。传输中没有秘密字段，由宿主代理注入 Bearer 凭据。无需凭据时，credentials 为空且省略 credentialId。

HTTP 响应最多 2 MiB，每轮最多 20 页，最多 60 次/分钟；`recordsPointer` 指向响应事件数组。多页读取必须声明 `pagination.cursorPointer` 和 `cursorParameter`。执行器应把服务端游标作为参数值编码，不把它解释为 URL；空游标结束，重复游标终止，不能无限翻页。

`local-jsonl` 不申请域名或凭据，只申请一个目录槽位 `{ id, purpose }`，由用户在安装时选择真实目录。`transport.directoryId` 必须匹配；file 是精确的 `.jsonl` 相对文件名，可带 ASCII 子目录，不支持 glob、绝对路径、点段、盘符或目录扫描。文件最多 16 MiB，单行最多 128 KiB，单行限制不得高于文件限制。

P02 运行时仍必须检查 DNS 解析后私网地址、每次重定向目标、代理凭据转发范围、规范化文件路径和符号链接，并执行 timeout/实际字节/速率/分页/记录数量上限。manifest URL 通过不代表目的服务器安全。停用应取消正在执行的采集；升级扩权应重新授权。P01 仅负责声明校验；已实现的运行时范围和剩余宿主集成以 HTTP 运行时交付说明为准。

## 字段映射

选择器是 `{ "pointer": "/field" }`，采用 JSON Pointer 的 `/` 分段以及 `~0`、`~1` 转义，长度最多 256；不是 JSONPath、JavaScript、正则或模板。role 额外支持 `{ "constant": "user" }`，枚举为 user/assistant/tool/system。

对 HTTP，映射相对于 recordsPointer 选中的每个记录；对 JSONL，映射相对于每行 JSON 对象。解释器只访问 JSON 自有属性，不访问原型链；不做隐式字符串转换、时间猜测或任意格式化。缺失/类型错误记录须拒绝并报告。

宿主注入 `schemaVersion: 1` 和已授权安装实例的 `sourceInstanceId`，不能由插件覆写。映射结果必须再次通过 `@memo/contracts` 的 `parseSourceEvent`。插件无法映射事项状态、完成条件或数据库字段。

## 完整合法示例：HTTP

```json
{
  "id": "example-http",
  "version": "1.0.0",
  "schemaVersion": 1,
  "sourceType": "source",
  "displayName": "Example HTTP events",
  "hostApiRange": { "minInclusive": "1.0.0", "maxExclusive": "2.0.0" },
  "kind": "http-json",
  "permissions": {
    "domains": ["api.example.com"],
    "directories": [],
    "credentials": [{ "id": "api-token", "purpose": "只读获取用户授权的事件" }]
  },
  "sampling": { "intervalSeconds": 300, "maxRecordsPerRun": 100 },
  "transport": {
    "url": "https://api.example.com/events",
    "method": "GET",
    "recordsPointer": "/items",
    "maxResponseBytes": 1048576,
    "maxPages": 5,
    "requestsPerMinute": 12,
    "credentialId": "api-token",
    "pagination": { "cursorPointer": "/next_cursor", "cursorParameter": "cursor" }
  },
  "mapping": {
    "externalId": { "pointer": "/id" },
    "revision": { "pointer": "/revision" },
    "occurredAt": { "pointer": "/created_at" },
    "role": { "pointer": "/role" },
    "text": { "pointer": "/content" }
  }
}
```

响应形状：`{ "items": [{ "id": "event-001", "revision": "r1", "created_at": "2026-09-13T00:00:00Z", "role": "user", "content": "合成测试事项" }], "next_cursor": null }`。此为合成内容，不发起请求。

## 完整合法示例：本地 JSONL

```json
{
  "id": "example-local",
  "version": "1.0.0",
  "schemaVersion": 1,
  "sourceType": "source",
  "displayName": "Example local export",
  "hostApiRange": { "minInclusive": "1.0.0", "maxExclusive": "2.0.0" },
  "kind": "local-jsonl",
  "permissions": {
    "domains": [],
    "directories": [{ "id": "exports", "purpose": "读取用户明确选择的导出目录" }],
    "credentials": []
  },
  "sampling": { "intervalSeconds": 300, "maxRecordsPerRun": 100 },
  "transport": {
    "directoryId": "exports",
    "file": "events.jsonl",
    "maxFileBytes": 1048576,
    "maxLineBytes": 131072
  },
  "mapping": {
    "externalId": { "pointer": "/id" },
    "revision": { "pointer": "/revision" },
    "occurredAt": { "pointer": "/created_at" },
    "role": { "constant": "user" },
    "text": { "pointer": "/content" }
  }
}
```

每行示例：`{ "id": "event-001", "revision": "r1", "created_at": "2026-09-13T00:00:00Z", "content": "合成测试事项" }`。它与 HTTP 示例映射到同一组 SourceEvent 字段。

## 验证范围

单元测试 `tests/unit/plugin-manifest.test.ts` 覆盖两个完整样例、必填字段、插件 SemVer、宿主区间端点、未知版本/kind、执行字段拒绝、域名/凭据/目录范围、读取上限、JSON Pointer 和 SourceEvent 目标字段。所有输入均为合成内存数据，不访问真实目录或网络。

P01 的通过标准仅是协议可验证、版本不兼容及无效声明被拒绝。授权执行、安装升级回滚、来源采集、暂停取消和真实事件落库由后续 P02 等任务验收。
