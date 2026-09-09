import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("server build isolation", () => {
  it("preserves independently built browser assets", async () => {
    const buildConfig = await readFile(
      new URL("../tsup.config.mjs", import.meta.url),
      "utf8",
    );

    expect(buildConfig).toContain(
      'clean: ["!web/**", "!browser-extension/**"]',
    );
  });
});
