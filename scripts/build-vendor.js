"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { build } = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["pixi.js"],
    outfile: "assets/vendor/pixi.min.js",
    bundle: true,
    format: "iife",
    globalName: "PIXI",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "inline",
    metafile: true,
    write: false,
    banner: { js: "/*! PixiJS 6.5.10 (MIT); rebuilt with locked dependencies by npm run build:vendor. */" },
  });
  if (!Object.keys(result.metafile.inputs).some((name) => name.startsWith("node_modules/qs/"))) {
    throw new Error("构建未包含预期的 qs 依赖，请检查打包入口。");
  }
  await fs.writeFile(path.join(root, "assets/vendor/pixi.min.js"), result.outputFiles[0].contents);
  console.log("已使用 package-lock.json 中的依赖重新构建 PixiJS 浏览器资源。");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
