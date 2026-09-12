# BUGU 不咕

BUGU 不咕：把分散在工作上下文里的承诺、进展与依据整理成可跟进的事项。

本项目提交至 [Hackathon-WeiYang](https://github.com/bread-ovO/Hackathon-WeiYang)。采用 Electron + React + TypeScript + Cloudflare Kumo。业务目标见 [PRD](docs/product/多信源AI事项助手_PRD_v0.3.md)，设计见 [技术方案](docs/architecture/多信源AI事项助手_技术方案_v0.1.md)，进度见 [需求拆解](docs/planning/README.md)。

本轮验证与限制见 [基建交付记录](docs/engineering/基建交付记录_2026-09-12.md)。

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
- SQLite v1–v6 显式迁移、WAL/FULL、外键、事件/作业/游标事务和修订去重。
- 按项目隔离的 SQLite 候选检索索引，支持中文短词、英文与代码标识符；人工事项变更与候选索引事务同步。
- 持久作业队列：原子领取、30 秒租约、续租与过期回收、最多 3 次尝试、失败码和旧执行者结果拒绝。
- JSON Schema 输入契约及派生类型；领域、应用与适配器接口分层。

已支持用户选择本地 JSONL 导出文件、按项目导入、增量同步和撤销授权；飞书、原生 AI 会话格式、GitHub 专用授权和模型执行尚未接入；“示例体验”提供虚构事项，支持筛选、搜索、新增及可撤销的状态预览，仅保存在窗口内存；“我的工作区”已支持真实项目、手动事项、标题与状态修改、归档及重启恢复。自动条件核验、后台消费器、飞书/GitHub 自动采集及加密数据库仍待开发。

## 桌宠（规划中）

支持用户导入 Live2D Cubism 运行时模型，使用独立透明桌面窗口展示，由 Live2D 驱动待机、表情与动作；桌宠偶尔通过气泡主动说话，可调整频率、暂停和免打扰。首版优先文字气泡；TTS 和口型联动列为后续增强。默认不主动播音，不根据沉默推断事项完成。

**已有资源预检与受控导入存储模块，支持 staging 复制后重验、去重、选择和移除；未接入 Live2D SDK、模型导入界面或主动说话运行时。**

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
- SQLite 集成：重复输入、事务中途失败、重开恢复、未来迁移版本拒绝。
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
| packages/plugin-host | 版本化 manifest 校验、local-jsonl 与 HTTPS JSON 读取模块；含安装/授权、试运行与启停界面 |
| packages/model | 模型适配器接口，目前不发出请求 |
| packages/evals | 按时间回放的评测类型，真实样例待补 |

队列存储与故障恢复说明见 [S05 交付记录](docs/engineering/S05_持久作业与租约恢复_2026-09-13.md)。作业处理器尚未连接真实模型；不把队列领取等同于事项处理成功。

连接页可通过原生文件选择器授权单个 JSONL 文件，事件、作业、项目关系和游标事务落库。连接仅读取所选文件，需手动同步。迁移 v1 建立最小表结构，v2 增加可重建候选检索索引；v3 增加项目、条件版本、证据关系、人工决定/修订和待发送 outbox，v4 增加截止时间及全事项列表检索索引；v5 增加来源授权版本与撤销保护；没有后台消费器或通知配送。

## 后续开发约束

领域包不依赖 Electron、数据库、网络或模型 SDK。插件和模型提交建议，不直接更新事项；UI 仅通过 preload 的命名方法调用宿主。新增 IPC 必须补 Schema、sender 检查及拒绝路径测试。

不得将生产凭据、用户原文或数据库提交到仓库。文档创作草稿与构建产物已在 .gitignore 中排除；产品文档、需求快照和图表仍保留。

界面封装与复用规范见 [Kumo skill](skills/kumo-desktop-ui/SKILL.md)，最新预览见 [界面设计交付](docs/design/界面重设计交付_2026-09-12.md)。

真实工作区与第二批实现边界见[交付记录](docs/engineering/真实工作区与模型导入_2026-09-13.md)。真实工作区已支持条件版本编辑/历史、截止时间、收录状态及数据库筛选分页；来源/活跃度筛选、自动重放保护流水线及人工撤销仍待开发。

第三批[交付说明](docs/engineering/条件编辑与分页_2026-09-13.md)与[插件 manifest 协议](docs/engineering/插件manifest协议_v1.md)。

第四批[本地 JSONL 导入交付](docs/engineering/本地JSONL导入_2026-09-13.md)：文件格式、容量边界和撤权行为。

真实工作区现支持[事项与证据导出](docs/engineering/事项与证据导出_2026-09-13.md)：按项目或选中事项保存 JSON，保留条件历史、人工决定与证据状态，可选择是否包含引用原文。

第六批新增[HTTPS JSON 来源运行时](docs/engineering/HTTP声明式来源运行时_2026-09-13.md)，支持受限网络请求、分页、取消与统一事件映射；已在第八批接入宿主安装和授权流程。

第七批新增[宿主凭据保护](docs/engineering/宿主凭据保护_2026-09-13.md)：设置页可通过原生文件选择器导入 Token，使用系统加密独立存储，界面仅显示名称、域名与用途；尚未绑定连接或模型。

第八批新增[插件安装与授权生命周期](docs/engineering/插件安装与授权生命周期_2026-09-13.md)：连接页安装声明式 JSON，确认范围并试运行后启用；支持按间隔收录、停用、卸载保留历史，以及系统凭据代理。数据库迁移至 v6。
