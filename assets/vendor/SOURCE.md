# 浏览器依赖

`pixi.min.js` 来自 PixiJS 6.5.10（MIT），使用本项目 `package-lock.json` 中锁定的依赖，通过 esbuild 重新构建。构建包括修复后的 `qs`，因此更换 npm 依赖时也应更新实际由浏览器加载的文件。

```bash
npm ci --ignore-scripts
npm run build:vendor
npm test
npm audit
```

`cubism4.min.js` 来自 `pixi-live2d-display` 0.4.0（MIT）的 Cubism 4 浏览器发行文件，使用全局 `PIXI`。升级 PixiJS 时需要同时验证 Live2D 模型、动作和鼠标跟随。

上游项目：<https://github.com/pixijs/pixijs>、<https://github.com/guansss/pixi-live2d-display>。
