import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts", "src/windows-launcher.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  target: "node24",
  platform: "node",
  splitting: false,
});
