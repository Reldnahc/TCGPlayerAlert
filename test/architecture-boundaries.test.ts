import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const providerPackages = ["manapool-seller-api", "tcgplayer-private-api"];

describe("provider architecture boundary", () => {
  it("does not add provider SDK imports outside adapter folders", async () => {
    const files = await typescriptFiles(resolve(repositoryRoot, "src"));

    for (const packageName of providerPackages) {
      const packagePattern = new RegExp(
        String.raw`(?:from\s*|import\s*\()\s*["']${escapeRegExp(packageName)}["']`,
        "u",
      );
      const actualPaths: string[] = [];
      for (const path of files) {
        if (isProviderAdapterPath(path)) continue;
        const source = await readFile(resolve(repositoryRoot, path), "utf8");
        if (packagePattern.test(source)) actualPaths.push(path);
      }
      expect(actualPaths.sort(), packageName).toEqual([]);
    }
  });

  it("does not add provider-name literals outside adapter folders", async () => {
    const files = await typescriptFiles(resolve(repositoryRoot, "src"));
    const actual: Record<string, Record<string, number>> = {};
    for (const path of files) {
      if (isProviderAdapterPath(path) || path === "src/runtime.ts") continue;
      const source = await readFile(resolve(repositoryRoot, path), "utf8");
      for (const match of source.matchAll(/["'](tcgplayer|manapool)["']/gu)) {
        const providerId = match[1];
        if (providerId === undefined) continue;
        const counts = (actual[path] ??= {});
        counts[providerId] = (counts[providerId] ?? 0) + 1;
      }
    }
    expect(actual).toEqual({});
  });
});

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(absolutePath);
      if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) return [];
      return [relative(repositoryRoot, absolutePath).replaceAll("\\", "/")];
    }),
  );
  return paths.flat();
}

function isProviderAdapterPath(path: string): boolean {
  return path.startsWith("src/providers/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
