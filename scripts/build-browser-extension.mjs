import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(repositoryRoot, "browser-extension");
const outputRoot = join(repositoryRoot, "dist", "browser-extension");
const sharedFiles = ["background.js", "popup.html", "popup.css", "popup.js"];
const browsers = [
  {
    name: "chromium",
    manifest: "chromium-manifest.json",
    iconSizes: [16, 32, 48, 128],
  },
  {
    name: "firefox",
    manifest: "firefox-manifest.json",
    iconSizes: [16, 32, 48, 96, 128],
  },
];

await rm(outputRoot, { force: true, recursive: true });

for (const browser of browsers) {
  const destination = join(outputRoot, browser.name);
  await mkdir(destination, { recursive: true });
  await copyFile(
    join(sourceRoot, browser.manifest),
    join(destination, "manifest.json"),
  );
  for (const file of sharedFiles) {
    await copyFile(join(sourceRoot, file), join(destination, file));
  }
  await mkdir(join(destination, "icons"), { recursive: true });
  for (const size of browser.iconSizes) {
    await copyFile(
      join(sourceRoot, "icons", `icon-${String(size)}.png`),
      join(destination, "icons", `icon-${String(size)}.png`),
    );
  }
}

process.stdout.write(
  "Built Firefox and Chromium connector extensions in dist/browser-extension.\n",
);
