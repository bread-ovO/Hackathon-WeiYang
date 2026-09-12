# PET01 · Cubism SDK for Web 兼容性验证

2026-09-13 在本机重新验证。此前记录把 Framework 标成 MIT、以混入手工呼吸的像素变化证明动作播放，并使用未隔离的 Electron profile；这些依据不能直接作为最终验收，本版已更正并重跑。

## 已验证结果

官方 Cubism SDK for Web 5-r.5，Core 6.0.0.1，在 macOS arm64、Electron 44.3.0 / Chromium 152.0.7977.78 的隔离 sandbox renderer 中完成 Haru 离线加载和真实动作驱动。验证使用 WebGL2。

| 指标 | strict CSP | wasm 对照 CSP |
| --- | --- | --- |
| `WebAssembly.compile` 是否允许 | false | true |
| 模型参数 / drawables | 42 / 84 | 42 / 84 |
| 三帧动作管理器更新 | true / true / true | true / true / true |
| 三帧非透明像素数 | 30086 / 30054 / 29790 | 30086 / 30054 / 29790 |
| 三帧 RGBA 哈希 | 2134855089 / 1282125645 / 2706175156 | 同左 |
| 参数变化与取值范围 | 通过 | 通过 |
| 坏 MOC：Core / Framework 拒绝 | true / true | true / true |
| 资源释放 / 清理错误 | true / 空 | true / 空 |

strict 使用 `script-src 'self'`。当前固定 Core 在 WebAssembly.compile 被策略拒绝时仍通过完整验证；这说明该版本当前环境不需要放宽生产 CSP，但没有据此确认 Core 内部采用哪条实现路径，也不能推及未来版本。

原记录中的 Windows 结论未在本次复现；不作为本次已验证平台。此处不包含生产透明窗口、多模型切换、长时性能或主动话语，仍分别由 PET05/PET06/PET14 等任务完成。

## 本次修正

- 下载前创建隔离缓存目录，HTTPS 限时限量并校验固定 SHA-256，完成后原子放入缓存。每次从同一已校验 ZIP 重新解压，不信任旧目录仅“文件存在”。
- fixture 使用独立临时 userData/sessionData，退出后清理。仅读取固定 loopback 服务，不允许外部窗口、外部导航或权限请求。
- 测试服务器拒绝目录穿越、编码穿越、符号链接和目录读取；异常路径返回固定响应，不崩溃或读取服务根外文件。
- 不再手工修改 ParamBreath。真实 motion manager 用三个时间增量驱动；同时断言更新结果、有限且范围内的真实参数变化、非透明像素和 RGBA 哈希变化。
- Core 与 Framework 的坏 MOC 结果分别断言 null。所有路径都执行模型、动作、纹理、渲染器和 Framework 释放；记录清理结果。

## 已从固定版本源码核实的 API

1. `CubismFramework.startUp()` 后执行 `initialize()`。
2. `CubismModelSettingJson(buffer, buffer.byteLength)` 和 `CubismMotion.create(buffer, buffer.byteLength)` 均提供长度。
3. `moc.createModel()` 已执行初始化，不再次调用 model.initialize。
4. `startMotionPriority(motion, autoDelete, priority)` 的第二参是布尔值，不是时间。
5. `updateMotion(model, deltaTimeSeconds)` 内部累加时间，不能传 performance.now 的绝对秒值。
6. 动作使用 model3 中的眼动/口型 ID 设定 effect IDs；静态 shaders、模型和 moc 也需要释放。

生产 `pet-live2d.ts` 仍未接入实际窗口，其旧调用需要在 PET06 接线时按这些 API 修正；不能把验证 harness 的完成等同于生产渲染器完成。

## 复现和证据

```bash
node scripts/fetch-pet-sdk.mjs
pnpm exec playwright test tests/desktop/pet/pet-verify.spec.ts
```

结果 JSON 作为 Playwright 附件 `sdk-verification.json` 保存；截图为 `test-results/pet01-strict.png` 与 `pet01-wasm.png`，含样例署名。无 SDK 资产的 CI 显式跳过两项；本机实际安装固定测试资产后两项均通过。结构化运行摘录见同目录 `PET01_macOS运行证据_2026-09-13.json`。

Framework 适用 Live2D Open Software License，Core 与 Haru 有各自协议；具体发布分类尚待确认。完整清单、固定哈希与官方来源见 [Live2D 许可与发布边界](Live2D许可与发布边界_2026-09-13.md)。SDK 与模型不进仓库、不随本批应用产物发布。
