import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(repositoryRoot, "browser-extension");
const outputRoot = join(repositoryRoot, "dist", "browser-extension");
const sharedFiles = [
  "background.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "PRIVACY.md",
];
const browsers = [
  { name: "chromium", manifest: "chromium-manifest.json" },
  { name: "firefox", manifest: "firefox-manifest.json" },
];

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
}

process.stdout.write(
  "Built Firefox and Chromium connector extensions in dist/browser-extension.\n",
);
