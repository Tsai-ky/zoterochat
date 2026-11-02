/**
 * zotero-plugin-scaffold 的薄包装。
 *
 * 直接调用 scaffold 编程接口，而不是使用 CLI：
 * - 0.9.3 的 checkGitIgnore() 漏了 await，启动时会无条件读取 .gitignore。
 *
 * 构建会同时产出 update.json，发布时把它上传到 GitHub Release 的 `release` 标签。
 */
import console from "node:console";
import process from "node:process";
import { Build, Config, Serve, Test } from "zotero-plugin-scaffold";

const command = process.argv[2] ?? "build";
const commands = { build: Build, serve: Serve, test: Test };
const Command = commands[command];

if (!Command) {
  console.error(`Unknown scaffold command: ${command}`);
  process.exit(1);
}

process.env.NODE_ENV =
  command === "build"
    ? "production"
    : command === "test"
      ? "test"
      : "development";

try {
  const ctx = await Config.loadConfig({});
  const instance = new Command(ctx);
  process.on("SIGINT", instance.exit.bind(instance));
  await instance.run();
} catch (e) {
  console.error(e);
  process.exit(1);
}
