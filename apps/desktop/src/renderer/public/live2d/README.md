# Vendored Live2D runtime

These files ship with the app under their original licenses:

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `live2dcubismcore.min.js` | Cubism SDK for Web 5-r.5（Core 6.0.0.1），官方 zip sha256 `67064a7fb1812cf502f5c4a03bfe12cc638c756621bb4acf06bb28763df06ba0` | Live2D 专有软件许可；`RedistributableFiles.txt`（本目录副本）明确允许随应用再分发 |
| `live2dcubismframework.min.js` | 同 zip 的 `Framework/`（MIT）经 `scripts/fetch-pet-sdk.mjs` 的 esbuild 伞式入口打包（IIFE，全局名 `Live2DCubismFramework`） | MIT（`FRAMEWORK-LICENSE.md`） |
| `shaders/` | 同 zip 的 `Framework/Shaders/WebGL` | 随 Framework 一并按 MIT 分发 |

更新流程：修改 `scripts/fetch-pet-sdk.mjs` 中 pin 的 zip URL 与 sha256 → 重新生成 bundle → 覆盖本目录 → 在 PET01 验证记录补充矩阵。

PET15 发布清单负责确认 SDK Release License 的公开分发条件；模型资产**永不**进入本目录或仓库。
