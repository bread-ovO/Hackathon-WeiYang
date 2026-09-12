# MineContext 本地编译与 Codex 设计补充

日期：2026-09-12。用途：为本项目下一版界面提供可追溯的设计依据。

## 研究边界

MineContext 来自官方仓库 https://github.com/volcengine/MineContext ，固定提交 `171c7a9ea8091e326ddcf0f10718aa1b58c83c65`，本地源码现位于 `.research/MineContext/`（初始编译路径 `/tmp/minecontext-research-20260912` 保留为软链接）。本轮执行桌面源码编译并运行 Electron，不将官方演示 GIF 当成本机运行结果。

Codex 的本机应用标识为 `com.openai.codex`。电脑操作工具明确返回 `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`，因此没有读取它的当前窗口，也没有绕过限制。以下 Codex 结论来自官方文档，不能视为本机动画、像素尺寸或性能实测。原 Codex 文档地址当前重定向到 ChatGPT Learn，文档已采用 ChatGPT/Codex 跨客户端表述；不能把其中所有页面描述都套到某个旧版本。

## 编译验证

- 前端按仓库 pnpm-lock 安装 1370 个包；实际 Electron 37.3.0、Vite 7.1.2，React 19、TypeScript 5 系列。
- 首次原生依赖构建因系统 Python 缺少 distutils 失败，改为仅在该命令指定现有 bundled Python，`electron-builder install-app-deps` 成功；未更改系统 Python 或全局 pnpm。
- `electron-vite build` 成功生成 main/preload/renderer；主进程约 3.79 MB，renderer 主 chunk 约 7.45 MB（未压缩构建输出大小，不能当成运行内存或加载耗时）。构建存在 `${titleBg}` 资源路径警告。
- 本轮是源码运行环境，未构建签名安装包，也未验证模型推理质量和屏幕采集能力。
- 研究副本使用独立 userData、独立后端数据目录和 18733 端口；停用屏幕任务初始化，避免枚举/采集用户窗口。后端通过本地 Python 源码启动器运行。这些是研究环境调整，不属于竞品原始产品行为。

## MineContext 启动体验：等待状态需要解释

本地后端尚未就绪时，实机停留在 Welcome 页面和 0% 进度。主进程日志已报告 error，前台仍显示“唤醒 Context-Aware AI partner”的等待说明。源码 `components/Loading/index.tsx` 对 error 只设置进度 0，没有对应的错误原因、重试或离线入口；starting 进度主要根据时间增长，不能代表真实初始化百分比。

这是一项可复现的错误状态设计观察，不代表正式安装包必然启动失败。我们的设计应让已有事项先可见，再在受影响的连接/能力上显示问题；后台状态不能阻断整个工作区。加载进度没有真实分母时，用阶段文字比百分比更诚实。

## Codex 值得学习的工作组织

官方文档将持续工作组织为项目及其中的独立任务；不同结果有各自上下文，相关文件和指导保留在项目中。侧栏示例以置顶、项目、会话组织入口。设计价值在于用户可以回到一个明确的工作对象，继续之前的工作，而不是每次重新描述问题。[官方项目文档](https://learn.chatgpt.com/docs/projects)、[官方功能示例](https://learn.chatgpt.com/docs/features)。

官方 Review pane 允许查看实际变更、选择范围，并围绕具体行给反馈。它把“助手的说明”和“可检查的结果”联系起来。对本项目的启发是：事项状态旁边能打开对应来源记录和条件变化；“建议完成”必须有可检查的根据。[官方审阅文档](https://learn.chatgpt.com/docs/code-review)。

以上是交互组织的借鉴，不据此推断 Codex 使用 Swift、Electron 或某个动画库。技术栈不能从丝滑的外观反推。

## 对本项目的具体取舍

| 设计问题 | 下一版建议 | 借鉴依据 |
| --- | --- | --- |
| 一进入就是空态宣传 | 首页成为可扫描的跟进清单：事项名称、当前状态、最近变化、下一步 | MineContext 待办组织；Codex 围绕持续工作对象组织 |
| 信息卡片权重一样 | 事项列表占主要空间，连接和设置保持低层级入口 | 前轮 AirJelly 连接列表观察 |
| AI 结论缺少依据 | 点开事项后显示承诺、完成条件、状态变化、来源记录 | Codex 把结果和逐项反馈联系起来 |
| 需要换页才能核对 | 来源详情在侧面打开，保留事项选中状态与列表位置 | Codex Review pane 的上下文连续性；MineContext 分栏源码 |
| 后台状态占主导航 | 常规状态收至设置；错误在相关连接和受影响事项处提示 | 本轮 MineContext 启动错误状态 |
| “AI 风格”替代产品特点 | 用事项进展、条件差异和来源关系体现特色；减少口号、装饰图案和无业务含义的卡片 | 本项目自身的产品价值 |

推荐保持“连接”作为导航名，页标题“应用与文件”，具体证据称“来源记录”。主页面可以命名“跟进”，并用“待确认、进行中、等待反馈”等筛选组织事项；最终状态名称须与 PRD 的业务状态对齐，不能仅为视觉新增状态。

下一轮应先做有代表性数据的可点击界面，覆盖：新事项待确认、等待他人反馈、证据不足的建议完成、连接断开、无事项。测试能否快速回答“这是什么事、现在卡在哪、为什么这么判断、下一步做什么”。这些是设计验收问题，尚无客户可用性测试结果。

## 前后端连通与首次配置验证

Python 3.11 环境已完成依赖安装。由于默认下载源速度慢，本次使用命令级清华 PyPI 镜像完成安装；没有修改全局包管理器配置。`GET http://127.0.0.1:18733/api/health` 返回 HTTP 200，状态 healthy，config/storage 为 true，llm 为 false。健康响应中的 capture=true 仅表示组件初始化，不能解释为正在录屏；原配置的各采集器均关闭，研究副本也没有启动屏幕任务。

实机初次配置页显示模型平台 Doubao/OpenAI/Custom、模型选择、API Key 和 Get started，没有跳过按钮。视觉上黑色标题与主按钮清晰，表单在左侧，右侧大量留白。它适合面向能配置模型的用户，但让普通客户先处理模型信息才能看见价值，存在转化负担；这是设计判断，未做转化数据验证。

为继续观察原业务组件，本地研究编译增加 `VITE_RESEARCH_SKIP_SETUP=1`，仅略过模型配置页，不伪造模型健康、不填入密钥、不生成假业务数据。这意味着后续页面是“真实源码组件 + 正常本地后端 + 未配置模型的研究入口”，不能称为完整正常 onboarding，也没有验证 AI 生成内容。研究补丁保存在本目录 evidence 中，便于复核差异。

## 业务页面实机观察

已实际查看首页、展开/关闭 Chat with AI 侧栏、添加待办弹窗、待办完成状态，以及 Screen Monitor 未授权页。数据只来自应用自动生成的教程和本地虚构样例。通过 UI 新增 `[调研样例] 核对需求评审反馈`，点击完成后进入折叠的 Done 分组；没有运行录屏或模型问答。第一次键盘输入中文未成功，留下一个 `[]` 测试项，这是自动化输入问题，不把它列为产品缺陷。

### 首页的优点和问题都比演示图更明确

- 176px 侧栏容纳 Home、Screen Monitor、Settings 和 Creation 文档树。数字来自源码，实机确认了对应组织形式。导航对象具体，选中态克制，文档可以直接回到上次工作内容。
- 主区为独立白色圆角面板，侧栏和窗口底色区分层级；黑色按钮突出主要动作，局部颜色用于标签。视觉辨识不全靠渐变或通用 AI 图案。
- 真实首页上方有大标题、介绍、全年热力图以及 Todos/Creation/Context/Chat 四个统计块。当前窗口中待办内容靠下，其他活动与创作需要滚动。首次无数据时多个区域同时空白。这是我们应避免照搬的部分。
- Chat with AI 按需展开，关闭后主区恢复空间。源码给主区最小宽度 600px、助手 340px；实机展开后标题被截断、热力图被压缩，说明固定最小宽度仍需要小窗口策略。我们的详情面板在窄窗口应切换到单列，并保留返回位置。
- 主区、Proactive Feed、助手同时出现时会形成三个注意力中心。我们的首页只需要事项列表与当前事项详情；额外 AI 建议不宜长期占据第三列。

### 待办交互值得复用，信息模型需要扩展

添加弹窗只要求内容与优先级；列表按 Urgent/Low Priority 等分组，每行有完成和复制等动作，完成项进入可折叠 Done 分组。这条路径很短。

本项目可借鉴列表行的轻量操作，但不能把一个圆形勾选框当成系统核验。人工标记完成、系统建议完成、条件尚不满足必须可区分；点开来源依据时保留原事项位置。默认教程作为待办出现在 Urgent 分组也值得慎重：我们应将引导与真实承诺明确区分，避免用户把系统教程误认为工作优先级。

### Screen Monitor

未授权时页面直接解释需要录屏权限，并给 Enable Permission 按钮。权限在相关功能位置呈现这一点值得借鉴。本轮没有点击该按钮，也没有把页面的隐私宣传当成已经核验的数据处理保证。

## 最终设计方向

功能范围继续以 AirJelly 扩展为基准；MineContext 提供开源实现与交互参考；Codex 提供“持续任务与可核对结果”的组织思路。我们的特色应落在：**每个事项都有来处、变化和可解释的完成条件**。

下一版主结构建议为“紧凑导航 → 跟进列表 → 按需展开的事项详情”。首屏把最近变化、卡点和下一步放在前面，统计放到次级位置。无需复制竞品的品牌、图标、标题或整个首页。

## 本地文件与复现

完整源码与依赖已移到项目内 `.research/MineContext/`，加入 gitignore，避免将第三方仓库和依赖提交进我们的工程。独立数据位于 `.research/profile/` 和 `.research/backend-data/`。原 `/tmp` 路径保留为兼容软链接。桌面与后端的开发数据库通过 `frontend/backend/persist` 软链接指向同一研究数据库。

本次观察结束后已退出研究用 Electron，确认没有遗留 `opencontext.cli` 后台进程。

- 源码：[MineContext](../../.research/MineContext/README_zh.md)
- 调整内容：[研究补丁](./evidence/minecontext-research.patch)
- Python 启动适配：[启动器](./evidence/minecontext-backend-launcher.sh)
- 本次解析到的 Python 版本：[依赖记录](./evidence/minecontext-python-freeze.txt)

当前机器可再次运行（保留本轮软链接时）：

```sh
cd '/Users/xiangyang/Documents/ChatGPT/多信源智能备忘录/.research/MineContext/frontend'
node node_modules/electron/cli.js .
```

重新编译研究入口：`VITE_RESEARCH_SKIP_SETUP=1 node node_modules/electron-vite/bin/electron-vite.js build`。去掉该环境变量重新编译即可恢复模型配置门槛；其他隔离修改以补丁为准。此处提供的是本地研究启动方法，不是面向最终用户的发行流程。
