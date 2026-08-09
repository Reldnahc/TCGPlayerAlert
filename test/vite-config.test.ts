import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchJsAruco2AprilTagDictionary } from "../vite.config.js";

describe("AprilTag browser bundle compatibility", () => {
  it("replaces the package's browser-unsafe CommonJS initializer", () => {
    const source = [
      "var AR = this.AR || require('../aruco').AR;",
      "AR.DICTIONARIES['APRILTAG_36h11'] = {};",
    ].join("\n");

    expect(
      patchJsAruco2AprilTagDictionary(
        source,
        "C:\\repo\\node_modules\\js-aruco2\\src\\dictionaries\\apriltag_36h11.js",
      ),
    ).toBe(
      [
        "var AR = require('../aruco').AR;",
        "AR.DICTIONARIES['APRILTAG_36h11'] = {};",
      ].join("\n"),
    );
    expect(
      patchJsAruco2AprilTagDictionary(source, "C:\\repo\\src\\unrelated.js"),
    ).toBeUndefined();
    expect(() =>
      patchJsAruco2AprilTagDictionary(
        "var AR = require('../aruco').AR;",
        "C:\\repo\\node_modules\\js-aruco2\\src\\dictionaries\\apriltag_36h11.js",
      ),
    ).toThrow("The pinned js-aruco2 AprilTag dictionary initializer changed.");
  });

  it("does not ship the fatal top-level-this access in the production chunk", async () => {
    const assetsDirectory = join(process.cwd(), "dist", "web", "assets");
    const assets = await readdir(assetsDirectory);
    const visionChunk = assets.find(
      (asset) => asset.startsWith("VisionLabPage-") && asset.endsWith(".js"),
    );
    if (visionChunk === undefined) {
      throw new Error("The production Scan lab chunk is missing.");
    }
    const source = await readFile(join(assetsDirectory, visionChunk), "utf8");

    expect(source).toContain("APRILTAG_36h11");
    expect(source).not.toContain("(void 0).AR");
  });
});
