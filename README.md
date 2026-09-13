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
- SQLite v1–v12 显式迁移、WAL/FULL、外键、事件/作业/游标事务和修订去重。
- 按项目隔离的 SQLite 候选检索索引，支持中文短词、英文与代码标识符；人工事项变更与候选索引事务同步。
- 收录预算：队列、数据库与 WAL 占用、磁盘剩余空间预检，超额整批回滚并保留游标；配置和恢复边界见 [收录背压交付](docs/engineering/收录背压与磁盘预算_2026-09-13.md)。
- 持久作业队列：原子领取、30 秒租约、续租与过期回收、最多 3 次尝试、失败码和旧执行者结果拒绝。
- JSON Schema 输入契约及派生类型；领域、应用与适配器接口分层。
- 引用版本复核：不同内容版本立即触发复核，可在详情中确认具体引用所使用的已知版本，保留原文与人工决定；见 [版本复核交付](docs/engineering/引用版本复核与重新确认_2026-09-13.md)。
- GitHub 专用连接：限定仓库与保险库凭据验证、持久分页及限流恢复、暂停与撤销、PR 观察记录；见 [GitHub 采集交付](docs/engineering/GitHub专用连接与持久采集_2026-09-13.md)。
- 显式消息撤回：授权收录撤回记录后立即标记引用失效，保留人工事项；详情显示撤回依据，导出保留失效关系与隐私选项，见 [撤回处理交付](docs/engineering/消息撤回与引用失效_2026-09-13.md)。

已支持用户选择本地 JSONL 导出文件、按项目导入、增量同步和撤销授权；GitHub 已支持限定仓库令牌与持久轮询；飞书、原生 AI 会话格式和模型执行尚未接入；“示例体验”提供虚构事项，支持筛选、搜索、新增及可撤销的状态预览，仅保存在窗口内存；“我的工作区”已支持真实项目、手动事项、标题与状态修改、归档及重启恢复。已接通本机有限规则的后台候选整理，支持暂停和原文依据；模型语义处理、自动条件核验、飞书专用自动采集及加密数据库仍待开发。

## 桌宠（逐步接入）

支持用户导入 Live2D Cubism 运行时模型，使用独立透明桌面窗口展示，由 Live2D 驱动待机、表情与动作；桌宠偶尔通过气泡主动说话，可调整频率、暂停和免打扰。首版优先文字气泡；TTS 和口型联动列为后续增强。默认不主动播音，不根据沉默推断事项完成。

**设置页已接通模型目录选择、入口确认、资源预检与受控导入，支持去重、当前模型选择、移除和重启恢复。本地安装受支持的运行库后，可在独立透明窗口显示当前模型，播放 Idle 与物理动画。已支持拖动、缩放、置顶、位置恢复、透明区穿透、模型表情动作与手动文字气泡。macOS 已接通可选自动话语、频率上限、静默与暂停及系统抑制；默认关闭且不播音。**

本地开发准备运行库：执行 `node scripts/fetch-pet-sdk.mjs`，在设置的「选择运行库目录」中选择 `.pet-sdk/runtime`。安装器仅接受仓库固定版本、大小和哈希匹配的文件；运行库与示例模型不随应用打包。随后导入模型、设为当前并点击「显示桌宠」。隐藏或切换模型会释放窗口，重新显示需点击按钮。模型与 SDK 的发布许可见 [许可边界](docs/engineering/Live2D许可与发布边界_2026-09-13.md)。


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
| packages/connectors | 来源适配器；GitHub 已接宿主持久采集，飞书适配器尚待专用连接 |
| packages/plugin-host | 版本化 manifest 校验、local-jsonl 与 HTTPS JSON 读取模块；含安装/授权、试运行与启停界面 |
| packages/model | 模型适配器接口，目前不发出请求 |
| packages/evals | 按时间回放的评测类型，真实样例待补 |

队列存储与故障恢复说明见 [S05 交付记录](docs/engineering/S05_持久作业与租约恢复_2026-09-13.md)。作业处理器已接本地明确承诺规则，只生成待确认候选。尚未连接真实模型；不把队列领取等同于事项处理成功。

连接页可通过原生文件选择器授权单个 JSONL 文件，事件、作业、项目关系和游标事务落库。连接仅读取所选文件，需手动同步。迁移 v1 建立最小表结构，v2 增加可重建候选检索索引；v3 增加项目、条件版本、证据关系、人工决定/修订和待发送 outbox，v4 增加截止时间及全事项列表检索索引；v5 增加来源授权版本与撤销保护；v8 增加本地候选后台处理记录与规则依据；尚无通知配送。

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

第九批[连接轮询与恢复](docs/engineering/连接轮询与恢复_2026-09-13.md)：插件网络错误按间隔退避并展示成功/重试时间；飞书/GitHub 适配器增加响应、分页、缓存与取消校验。专用授权入口和宿主传输仍待集成。

第十批[专用来源 HTTPS 宿主层](docs/engineering/专用来源HTTPS宿主层_2026-09-13.md)：复用受限传输支持 ETag/304 和限流响应；凭据在每次请求前按授权范围重新读取。专用连接配置与持久调度仍待接入。

第十一批[桌宠模型管理交付](docs/engineering/桌宠模型管理交付_2026-09-13.md)：真实设置页、目录授权会话、独立 worker 与受控模型存储；不等同于 SDK 渲染验收。

第十二批[SDK 兼容性重验](docs/engineering/PET01_Cubism_SDK兼容性验证_2026-09-13.md)已在 macOS arm64 验证真实动作与坏 MOC 拒绝；[许可清单](docs/engineering/Live2D许可与发布边界_2026-09-13.md)更正 Framework 非 MIT，并保留正式发布待确认项。

第十三批[桌宠独立窗口与真实渲染](docs/engineering/桌宠独立窗口与真实渲染交付_2026-09-13.md)：本地可信运行库安装、独立透明窗口、真实 Idle/物理动画与失败释放。表情调度、气泡和穿透仍待完成。

第十四批[桌宠拖动与透明区穿透](docs/engineering/桌宠拖动与透明区穿透交付_2026-09-13.md)：受限窗口偏好、系统坐标拖动、像素命中与持久恢复；macOS 使用真实系统鼠标验收。

第十五批[桌宠表情动作与气泡](docs/engineering/桌宠表情动作与气泡交付_2026-09-13.md)：真实单次动作和限时表情回待机、串行纯文本气泡；运行库需重新生成并安装 actions1 版本。

第十六批[桌宠自动话语与免打扰](docs/engineering/桌宠自动话语与免打扰交付_2026-09-13.md)：持久冷却、每日上限与去重，静默/暂停及 macOS 全屏与系统状态抑制。

第十七批[桌宠帧率与恢复](docs/engineering/桌宠帧率与恢复交付_2026-09-13.md)：闲置15fps/活动30fps、WebGL受限恢复和着色器迟到回调释放保护；运行库需升级为lifecycle1。


第十八批[事件入口一致性与退出验收](docs/engineering/事件入口一致性与退出验收_2026-09-13.md)：同修订冲突事务拒绝、v7 时间上下文与项目隔离查询；补本地插件在途退出和同步时间恢复。事项自动消费者及迟到计划更新尚未接通。


第十九批[本地候选整理闭环](docs/engineering/本地候选整理闭环_2026-09-13.md)：授权事件经后台规则处理进入待确认候选，暂停持久化，修订保留待复核且不覆盖人工更改；详情可见原文与规则来源，导出升级至 v2 并保留相关依据。有限规则不能替代完整模型语义理解。
