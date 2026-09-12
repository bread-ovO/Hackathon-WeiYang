# PET01 · Cubism SDK for Web 兼容性验证记录

验证日期：2026-09-13。负责人：yunyancuo（品鉴会话）。对应多维表 PET01「模型格式与 SDK 兼容性验证」，验收标准：至少使用一份有合法使用权的模型完成离线加载和动画；不兼容 moc3 给出明确错误。

## 结论（已验证）

官方 Cubism SDK for Web **5-r.5**（Core **6.0.0.1**，Framework MIT）在 Electron 44.3.0 sandbox 渲染器内完成离线加载与动画，验收标准达成于 Windows x64：

- 离线加载：官方样例模型 Haru（SDK zip 自带，合法使用权）加载成功，42 参数、84 drawable、2 纹理。
- 动画：`haru_g_idle.motion3.json` 驱动渲染，连续三帧（间隔 120/240ms）画布像素哈希各不相同；截图见 `test-results/pet01-*.png`（测试运行时生成）。
- 不兼容 moc3：垃圾字节经 `CubismMoc.create(bytes, true)` 一致性校验返回 `null`（Framework 层），`Live2DCubismCore.Moc.fromArrayBuffer` 同样返回 `null`（Core 层）。**契约是返回 null 而非抛异常**，调用方必须判空——PET03 导入校验与 PET06 渲染需遵守。

### 支持矩阵

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| Electron | 44.3.0（Chromium 152.0.7977.78，Windows x64） | — | sandbox、contextIsolation、nodeIntegration 关闭，与生产窗口一致 |
| Cubism Core | 6.0.0.1（0x06000001） | Live2D 专有；`RedistributableFiles.txt` 明确 `live2dcubismcore.min.js`/`d.ts` 可再分发 | 版本读取 `Version.csmGetVersion()`，编码 `major<<24 \| minor<<16 \| patch<<8 \| rev` |
| Cubism Framework | 5-r.5 源码 | MIT | esbuild 打包为 IIFE（`Live2DCubismFramework` 全局） |
| 样例模型 | Haru（SDK zip 内置） | Live2D 样例数据条款 | 不入库；仅存于 `.pet-sdk/` |
| SDK zip | CubismSdkForWeb-5-r.5.zip，sha256 `67064a7f…df06ba0` | Live2D 专有 | 由 `scripts/fetch-pet-sdk.mjs` 固定校验下载 |

macOS 侧未在本记录验证（按 PET16，macOS 首验在集成验收执行）；CI 无授权资产，PET01 测试在资产缺失时显式 skip 并说明原因。

## 关键发现：生产 CSP 无需放宽

生产 CSP `script-src 'self'` 下 `WebAssembly.compile` 被 CSP 拦截（strict 变体实测 `wasmAllowed=false`），但 Core 6.0.0.1 在此环境下仍完成全链路加载与动画（判定为非 WASM 路径/回退）。**桌宠窗口不需要为 Live2D 加 `'wasm-unsafe-eval'`**。若未来升级 Core 后强制要求 WASM，需重新评估并单独评审 CSP 变更。

（勘误：早期一次 strict 变体失败源于验证脚本把 `CubismFramework.startUp` 误写为 `startup`，曾被误判为 CSP 拦截；已修正并以双变体测试锁定真实结论。）

## Framework 5 API 陷阱清单（PET06 实现必读）

1. `CubismFramework.startUp()`——大写 U（`startup` 不存在）。
2. `CubismMotion.create(buffer, size)` 必须显式传字节长度；漏传时静默解析失败返回 `null`。
3. 动作播放前必须 `motion.setEffectIds(eyeBlinkIds, lipSyncIds)`（ids 取自 model3.json 的 `getEyeBlinkParameterId/getLipSyncParameterId`），否则 `doUpdateParameters` 读 null 崩溃。
4. 渲染器用 `new CubismRenderer_WebGL(width, height)` + `initialize(model)` + `startUp(gl)` + `loadShaders(path)`；基类 `CubismRenderer.create()` 返回 null。
5. Shader 是外部文件：`Framework/Shaders/WebGL/*` 必须随宿主一起供到同源路径。
6. 驱动动作用 `CubismMotionManager.updateMotion(model, t)`（demo 同款）。
7. `CubismMoc.create` 带 `shouldCheckMocConsistency=true` 是官方一致性门禁，失败返回 null 不抛错。

## 复现

```bash
node scripts/fetch-pet-sdk.mjs   # 下载 zip（sha256 校验）→ .pet-sdk/（gitignored）→ 打 Framework bundle
pnpm exec playwright test tests/desktop/pet/pet-verify.spec.ts
```

测试在 `strict`（生产 CSP 原样）与 `wasm`（加 `'wasm-unsafe-eval'` 对照）两个变体下各自断言完整加载+动画+坏 moc3 拒绝；Electron fixture 与生产同等安全姿态（sandbox、contextIsolation、权限全拒）。资产缺失时 skip 并注明原因，不以占位冒充通过。

## 边界与未验证项

- 本记录不构成 PET15（发布许可检查）：SDK Release License 的发布条件、收入门槛适用性需在发布前单独核对；`.pet-sdk/` 与模型资产不随仓库分发。
- 未验证 WebGL context lost 恢复、长时运行内存曲线（PET14）、透明窗口合成（PET05）、多模型切换资源释放（PET06 验收项）。
- Windows x64 单平台实测；Chromium 具体版本号由测试运行时输出（见 spec `PET01 … versions:` 日志）。
