import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
  splitting: false,
});
