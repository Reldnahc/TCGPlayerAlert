import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(repositoryRoot, "dist", "browser-extension");
const artifactRoot = join(repositoryRoot, "artifacts", "browser-extension");
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

await mkdir(artifactRoot, { recursive: true });

const artifacts = [];
for (const browserName of ["chromium", "firefox"]) {
  const sourceDirectory = join(distributionRoot, browserName);
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "manifest.json"), "utf8"),
  );
  const archiveName = `tcgplayer-alert-session-connector-${browserName}-${manifest.version}.zip`;
  const archivePath = join(artifactRoot, archiveName);
  const zip = new JSZip();
  for (const path of await filesWithin(sourceDirectory)) {
    zip.file(
      relative(sourceDirectory, path).split(sep).join("/"),
      await readFile(path),
      {
        binary: true,
        date: fixedTimestamp,
        createFolders: false,
      },
    );
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
  await writeFile(archivePath, bytes);
  artifacts.push({
    name: archiveName,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

await writeFile(
  join(artifactRoot, "SHA256SUMS.txt"),
  `${artifacts.map(({ name, digest }) => `${digest}  ${name}`).join("\n")}\n`,
);

process.stdout.write(
  `Packaged ${artifacts.length} submission archives in ${artifactRoot}.\n`,
);

async function filesWithin(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesWithin(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}
