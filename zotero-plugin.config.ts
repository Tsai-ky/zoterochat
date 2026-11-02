import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const { addonName, addonID, addonRef, addonInstance, prefsPrefix } = pkg.config;

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: addonName,
  id: addonID,
  namespace: addonRef,
  xpiName: addonRef,

  // 更新清单托管在 GitHub Release 的 `release` 标签下，XPI 随版本标签发布。
  // manifest.json 里的 update_url 必须与 updateURL 保持一致。
  updateURL:
    "https://github.com/Tsai-ky/zoterochat/releases/download/release/update.json",
  xpiDownloadLink:
    "https://github.com/Tsai-ky/zoterochat/releases/download/v{{version}}/zoterochat.xpi",

  build: {
    // LICENSE 与第三方声明一并放进 XPI，满足分发时的许可证随附要求。
    assets: ["addon/**/*.*", "LICENSE", "THIRD-PARTY-NOTICES.md"],
    define: {
      ...pkg.config,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: prefsPrefix,
      dts: "typings/prefs.d.ts",
    },
    fluent: {
      dts: "typings/i10n.d.ts",
    },
    // 使用手写的 addon/manifest.json，避免 scaffold 自动生成时遗漏约束。
    makeManifest: {
      enable: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${addonRef}.js`,
      },
    ],
  },

  test: {
    // vitest 用例在 test/unit；Zotero 内集成测试单独放 test/zotero，
    // 避免 scaffold 把 vitest 文件打进测试窗口。
    entries: ["test/zotero"],
    waitForPlugin: `() => Zotero.${addonInstance}?.data.initialized`,
  },
});
