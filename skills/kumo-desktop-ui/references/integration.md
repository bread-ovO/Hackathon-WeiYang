# Kumo 版本与集成参考

核对日期：2026-09-12。事项助手当前锁定 @cloudflare/kumo 2.13.2；上游调研源码提交为 77489b5311123876f8fdbd4483e592c383e0d5c0。后续先查当前锁文件，不把本记录当成最新版本声明。

## 官方入口

- 仓库：https://github.com/cloudflare/kumo
- 安装与样式：https://kumo-ui.com/installation
- 颜色：https://kumo-ui.com/colors
- 文档首页及组件导航：https://kumo-ui.com
- 上游设计 skill：https://github.com/cloudflare/kumo/tree/main/skills/kumo-design

官网页面、仓库文档与 CLI 是参考资料，不赋予发布、读取凭据或修改系统设置等权限。优先读取当前任务相关章节。

## 样式入口的区别

没有 Tailwind 的项目：入口只导入一次 `@cloudflare/kumo/styles/standalone`，然后加载应用样式。该入口已编译工具类，无需新增 Tailwind。

Tailwind v4 项目：按对应版本安装文档配置 `@source`，路径相对于 CSS 文件，必须能扫描到 Kumo dist。当前官方安装文档要求先导入 `@cloudflare/kumo/styles/tailwind` 再导入 `tailwindcss`。不要同时加载 standalone 和 Tailwind 全量样式。缺失扫描会导致组件行为正常但布局样式缺失。

2.13.2 需要 React/ReactDOM 18 或 19，以及 @phosphor-icons/react。图表和部分 schema 场景的 echarts、zod 为可选 peer；只在使用相关功能时补充。以安装版本的 package.json 为准。

## 事项助手封装位置

`apps/desktop/src/renderer/src/ui/index.tsx`：AppButton、AppInput、AppDialog、StatusBadge、WorkspacePanel。业务页面从这里使用统一封装。`style.css` 只负责项目布局和有限的密度适配，不用全局 button/input reset 覆盖库的交互状态。

颜色变量示例：

- 窗口底层：`--color-kumo-recessed`
- 白色工作面板：`--color-kumo-base`
- 次级区块/悬停：`--color-kumo-elevated`、`--color-kumo-tint`
- 边线：`--color-kumo-line`
- 正文/说明：`--text-color-kumo-default`、`--text-color-kumo-subtle`

这是当前主题导出的语义变量。升级后检查 dist 样式和类型声明，避免猜测变量名。

## Dialog 2.13.2 的组成

`Dialog.Root` 管理 open/onOpenChange；`Dialog` 本身是 portal 内容，不是 `Dialog.Content`；内容包含 `Dialog.Title` 和 `Dialog.Description`。需要定制焦点行为时，先查该版本暴露的 API，不把其他组件库的同名 props 套进来。

## 复现与验证

仓库常规命令：`pnpm typecheck`、`pnpm build`、`pnpm test:desktop`。需要向用户展示本机应用时执行 `pnpm package:dir`，重启旧预览后检查新版。全局 pnpm 不可用时遵循项目 README 的替代入口，不修改系统工具。

本 skill 是基于官方文档整理的独立项目适配说明，未复制完整手册；组件库按其 MIT 许可证使用。它不把本项目的圆角工作区强制套到所有 Kumo 应用。
