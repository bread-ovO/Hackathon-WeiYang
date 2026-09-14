# BUGU 不咕 · 鸟娘视觉 v1

使用内置 imagegen 生成。主视觉含字标，应用图标为无字版本。角色设计参考白面鸮的灰白羽毛与冷静气质，加入布谷鸟条纹羽翼、橙色羽饰和任务勾选胸扣。

- `bugu-wordmark.png`：品牌主视觉。
- `bugu-icon.png`：方形应用图标视觉稿。

已应用于侧栏 Logo、聊天头像与欢迎图、窗口/Dock、托盘及 macOS/Windows/Linux 打包图标。运行 `node apps/desktop/scripts/generate-app-icon.mjs` 可从原图无裁剪缩放生成各尺寸 PNG 和 ICO。位图不是可驱动的 Live2D 模型，现有桌宠模型保持独立。

## 主视觉生成提示词

Use case: logo-brand.
Create a polished square brand mascot key visual / app icon for a Chinese desktop AI task assistant named exactly "BUGU 不咕". Main subject is an ORIGINAL anime cuckoo-bird girl, with a calm quietly competent slightly sleepy expression, inspired by the restrained white/gray feathered aesthetic and composure of Ptilopsis from Arknights, but a distinctly new cuckoo character with her own silhouette and costume.
Composition: one single large centered chibi head-and-shoulders mascot, extremely readable iconic silhouette, occupying the top 75 percent; a beautifully balanced bold wordmark "BUGU 不咕" in the lower 20 percent. No other text. App identity design, not an illustrated poster or mockup sheet.
Character: soft silver-gray short bob with two broad rounded feather tufts angled outward (bird feathers, not cat ears), subtle dark gray cuckoo feather barring along the ends, warm amber eyes with small highlights, pale face, tiny confident smile. A short charcoal and ivory feather cape with only two broad striped wing shapes framing her shoulders. One small warm orange feather accessory. A simple orange check-shaped clasp subtly suggests reliable task follow-through. No headset, no medical staff, no existing character insignias. Cute and sophisticated, friendly adult-coded mascot, no sexualization.
Graphic style: premium Japanese game-inspired character-logo illustration distilled into bold flat shapes, controlled clean dark outlines, sparse cel shading, meticulous symmetrical balance with a little organic asymmetry in the hair. White, charcoal, silver gray and BUGU warm orange (#FF812B). Avoid fine texture and unnecessary accessories. Character must read at app-icon sizes.
Background: full square very light warm ivory with generous safe padding, no external device mockup, no drop shadow, no grid, no multiple variants. Wordmark dark charcoal, exact legible text "BUGU 不咕", contemporary rounded sans serif, balanced and spacious. High-resolution production-quality single graphic.

## 图标编辑提示词

Edit this BUGU brand mascot into a finished square desktop APPLICATION ICON. Preserve exactly the same original bird-girl identity: silver bob, cuckoo striped feather ears, amber eyes, orange feather accessory, calm smile and orange check clasp. Remove ALL lettering and wordmark. Enlarge the centered head-and-shoulders portrait to fill the square with 8 percent safe padding, keep ALL feather ear tips and hair within the canvas, no clipping. Simplify thin hair lines and feather patterns slightly for excellent small-size readability. The face should be the main focus. Solid warm ivory background covering the entire square, opaque. Flat crisp cel-shaded anime brand illustration, no mockup, no frame, no rounded corner cutouts, no shadow, no extra items. Just a single production-ready icon.



## 验证

macOS arm64 目录包构建通过，包内包含新 icon.icns；在打包应用中确认侧栏、聊天欢迎图和头像正常加载，并检查宽窄窗口字标不换行。类型检查、7 项托盘单元测试和单个 app.spec.ts 通过。Windows ICO 与 Linux 配置已更新，未在对应操作系统打包验收。截图见 docs/evals/screenshots/birdgirl-brand。
