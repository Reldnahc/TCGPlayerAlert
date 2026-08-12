import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionRoot = join(repositoryRoot, "browser-extension");
const iconsRoot = join(extensionRoot, "icons");
const storeAssetsRoot = join(extensionRoot, "store-assets");
const iconSource = await readFile(join(iconsRoot, "icon.svg"));
const icon = await loadImage(iconSource);

await mkdir(iconsRoot, { recursive: true });
await mkdir(storeAssetsRoot, { recursive: true });

for (const size of [16, 32, 48, 96, 128]) {
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(icon, 0, 0, size, size);
  await writeFile(
    join(iconsRoot, `icon-${String(size)}.png`),
    canvas.toBuffer("image/png"),
  );
}

const promo = createCanvas(440, 280);
const context = promo.getContext("2d");
const gradient = context.createLinearGradient(0, 0, 440, 280);
gradient.addColorStop(0, "#eef8f5");
gradient.addColorStop(1, "#d8eee8");
context.fillStyle = gradient;
context.fillRect(0, 0, 440, 280);

context.fillStyle = "#ffffff";
roundRect(context, 24, 32, 392, 216, 22);
context.fill();
context.strokeStyle = "#b8d8d0";
context.lineWidth = 2;
context.stroke();
context.drawImage(icon, 48, 86, 104, 104);

context.fillStyle = "#17202a";
context.font = '700 27px "Segoe UI", sans-serif';
context.fillText("TCGPlayerAlert", 178, 101);
context.font = '700 20px "Segoe UI", sans-serif';
context.fillText("Session Connector", 178, 132);
context.fillStyle = "#52606d";
context.font = '14px "Segoe UI", sans-serif';
context.fillText("Connect your signed-in seller session", 178, 165);
context.fillText("to the local app on this computer.", 178, 187);
context.fillStyle = "#126b57";
context.font = '700 11px "Segoe UI", sans-serif';
context.fillText("PRIVATE  •  LOCAL  •  USER INITIATED", 178, 218);

await writeFile(
  join(storeAssetsRoot, "chrome-small-promo-440x280.png"),
  promo.toBuffer("image/png"),
);

function roundRect(target, x, y, width, height, radius) {
  target.beginPath();
  target.roundRect(x, y, width, height, radius);
}
