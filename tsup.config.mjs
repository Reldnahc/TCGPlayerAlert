import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts", "src/windows-launcher.ts"],
  format: ["esm"],
  sourcemap: true,
  // A standalone server build must not delete independently built UI assets.
  clean: ["!web/**", "!browser-extension/**"],
  target: "node24",
  platform: "node",
  splitting: false,
});
