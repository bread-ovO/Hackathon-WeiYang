# BUGU 不咕

BUGU 不咕：把分散在工作上下文里的承诺、进展与依据整理成可跟进的事项。

本项目提交至 [Hackathon-WeiYang](https://github.com/bread-ovO/Hackathon-WeiYang)。采用 Electron + React + TypeScript + Cloudflare Kumo。业务目标见 [PRD](docs/product/多信源AI事项助手_PRD_v0.3.md)，设计见 [技术方案](docs/architecture/多信源AI事项助手_技术方案_v0.1.md)，进度见 [需求拆解](docs/planning/README.md)。

本轮验证与限制见 [基建交付记录](docs/engineering/基建交付记录_2026-09-12.md)。

数据与作业 S01–S08 已交付基础实现，实际范围、测试和剩余联验见 [交付记录](docs/engineering/数据与作业_S01-S08_交付记录_2026-09-13.md)；原 [实现报告](docs/engineering/数据与作业_S01-S08_实现报告_2026-09-12.md)保留为评审基线。

## 团队文档

| 文档 | 飞书入口 |
| --- | --- |
| PRD · 产品需求 | [产品需求文档](https://my.feishu.cn/docx/JQ11dTz4ioqXcExWlq2cMH9zn5e) |
| ERD · 工程设计 | [现有技术方案](https://my.feishu.cn/docx/BTFWdltVvoQs2exIwDKc1LNKnVh) |
| 多维表 · 需求拆解与进度 | [需求明细](https://my.feishu.cn/base/VHWebJShaa0nhnskizncs3GZnud?table=tblAzOvM7QohTvak) |

ERD 入口沿用此前创建的「技术方案」，尚无单独命名的 ERD 文档；历史文档中原项目名后续统一称为 BUGU 不咕。最新新增范围见 [Live2D 桌宠需求与架构增补](docs/product/BUGU_桌宠需求与架构增补.md)，对应多维表 PET01–PET16。

## 当前能力

- pnpm workspace、严格 TypeScript、包边界检查和 macOS CI 配置。
- React 桌面设计预览：事项列表/详情、来源记录、连接规划与真实核心/数据库健康状态。
- Electron sandbox renderer、最小 preload、白名单 IPC 与自定义本地资源协议。
- 独立 utilityProcess 核心，超时和有上限的崩溃重启。
- SQLite v2 及保守备份迁移、四维状态/条件/证据/决定模型、整页事件/作业/回执/游标事务。
- 持久作业租约与有界重试、业务原子提交与人工保护、中文/标识符候选检索、磁盘背压与暂停恢复。
- JSON Schema 输入契约及派生类型；领域、应用与适配器接口分层。

飞书、AI 会话、GitHub、模型与插件执行尚未接入；“示例体验”提供虚构事项，支持筛选、搜索、新增及可撤销的状态预览，仅保存在窗口内存；“我的工作区”显示真实未接入空态。语义条件核验、真实来源/模型 handler、事项页面与持久仓储联接、加密数据库仍待开发。核心已装配作业执行器，但无 handler 时不会消费或伪造完成作业。当前 SQLite 仅用于测试数据。

## 桌宠（规划中）

支持用户导入 Live2D Cubism 运行时模型，使用独立透明桌面窗口展示，由 Live2D 驱动待机、表情与动作；桌宠偶尔通过气泡主动说话，可调整频率、暂停和免打扰。首版优先文字气泡；TTS 和口型联动列为后续增强。默认不主动播音，不根据沉默推断事项完成。

**当前仅完成需求与架构拆解，未接入 Live2D SDK、模型导入或主动说话运行时。**

## 本地启动

需要 Node.js 22.12+（建议 Node 22）和 pnpm 10.34.5。首次原生模块构建可能需要 Xcode Command Line Tools。

```bash
npx --yes pnpm@10.34.5 install
npx --yes pnpm@10.34.5 rebuild:native
npx --yes pnpm@10.34.5 dev
```

正常 pnpm 已安装时可直接使用 `pnpm`。项目不修改全局工具。变更 Electron 或 SQLite 驱动版本后重新执行 `rebuild:native`。SQLite 集成测试使用 Electron 自带 Node，避免宿主 Node 与 Electron 的 native ABI 混用。

## 验证与构建

```bash
pnpm check
pnpm package:dir
```

`check` 顺序执行包边界、类型、单元、构建、SQLite 集成和桌面端到端测试。`package:dir` 生成 release/ 下的本地未签名应用目录，尚非可公开分发的安装包。CI 配置已提供，远端执行结果需推送后确认。

- 单元测试：输入校验、版本冲突、归档语义和页面信任边界。
- SQLite 集成：整页原子性、迁移/进程强杀、租约与业务幂等、真实写满恢复、120 条检索样例及 1 万事项性能基线。
- 桌面测试：独立临时用户目录、实际 SQLite 健康检查、无 Node 暴露、禁止弹出外链。

默认数据在 Electron 的 userData 目录下保存为 memo.sqlite。仅未打包应用可用 `MEMO_TEST_USER_DATA` 指定隔离测试目录；正式应用忽略此变量。测试自动清理自己创建的临时目录，不读取个人聊天或凭据。

## 工程结构

| 目录 | 职责 |
| --- | --- |
| apps/desktop | main、preload、renderer、core 入口与打包 |
| packages/contracts | 版本化 JSON Schema 和边界类型 |
| packages/domain | 与平台无关的领域规则 |
| packages/application | 接收等应用用例及存储接口 |
| packages/storage | SQLite、迁移与事务实现 |
| packages/connectors | 信源适配器接口，目前无真实采集 |
| packages/plugin-host | 插件 manifest 类型，目前不加载代码 |
| packages/model | 模型适配器接口，目前不发出请求 |
| packages/evals | 按时间回放的评测类型，真实样例待补 |

目前实际来源尚未接入；宿主登记来源后须显式授予范围，再按 stream 的检查点版本接收整页。来源登记不代替授权。数据库与业务提交基础已具备，真实连接器、推理 handler 及业务 UI 仍需按交付记录完成联合验收。

## 后续开发约束

领域包不依赖 Electron、数据库、网络或模型 SDK。插件和模型提交建议，不直接更新事项；UI 仅通过 preload 的命名方法调用宿主。新增 IPC 必须补 Schema、sender 检查及拒绝路径测试。

不得将生产凭据、用户原文或数据库提交到仓库。文档创作草稿与构建产物已在 .gitignore 中排除；产品文档、需求快照和图表仍保留。

界面封装与复用规范见 [Kumo skill](skills/kumo-desktop-ui/SKILL.md)，最新预览见 [界面设计交付](docs/design/界面重设计交付_2026-09-12.md)。
