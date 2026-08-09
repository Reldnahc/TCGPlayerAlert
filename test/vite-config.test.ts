import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AprilTag browser bundle compatibility", () => {
  it("ships the pinned worker and a valid WebAssembly module", async () => {
    const vendorDirectory = join(
      process.cwd(),
      "dist",
      "web",
      "vendor",
      "apriltag-js",
    );
    const [worker, wasm, license] = await Promise.all([
      readFile(join(vendorDirectory, "detector-worker.js"), "utf8"),
      readFile(join(vendorDirectory, "apriltag_wasm.wasm")),
      readFile(join(vendorDirectory, "LICENSE"), "utf8"),
    ]);

    expect(worker).toContain("importScripts");
    expect(wasm.subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]));
    expect(license).toContain("BSD 2-Clause License");
  });

  it("does not retain the legacy js-aruco2 compatibility path", async () => {
    const manifest = await readFile(
      join(process.cwd(), "package-lock.json"),
      "utf8",
    );
    const viteConfig = await readFile(
      join(process.cwd(), "vite.config.ts"),
      "utf8",
    );

    expect(manifest).not.toContain('"js-aruco2"');
    expect(viteConfig).not.toContain("js-aruco2");
  });
});
