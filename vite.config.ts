import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [preact()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
});
