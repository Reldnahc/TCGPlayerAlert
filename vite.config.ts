import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

const APRILTAG_DICTIONARY_MODULE =
  "/js-aruco2/src/dictionaries/apriltag_36h11.js";
const BROKEN_COMMONJS_INITIALIZER =
  "var AR = this.AR || require('../aruco').AR;";
const PORTABLE_COMMONJS_INITIALIZER = "var AR = require('../aruco').AR;";

export function patchJsAruco2AprilTagDictionary(
  code: string,
  id: string,
): string | undefined {
  if (!id.replaceAll("\\", "/").endsWith(APRILTAG_DICTIONARY_MODULE)) {
    return undefined;
  }
  if (!code.includes(BROKEN_COMMONJS_INITIALIZER)) {
    throw new Error(
      "The pinned js-aruco2 AprilTag dictionary initializer changed.",
    );
  }
  return code.replace(
    BROKEN_COMMONJS_INITIALIZER,
    PORTABLE_COMMONJS_INITIALIZER,
  );
}

const patchAprilTagDictionaryPlugin: Plugin = {
  name: "patch-js-aruco2-apriltag-dictionary-commonjs",
  enforce: "pre",
  transform(code, id) {
    const patched = patchJsAruco2AprilTagDictionary(code, id);
    return patched === undefined ? null : { code: patched, map: null };
  },
};

export default defineConfig({
  root: "src/web",
  plugins: [patchAprilTagDictionaryPlugin, preact()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
});
