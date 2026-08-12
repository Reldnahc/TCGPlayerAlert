import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(
  repositoryRoot,
  "browser-extension",
  "store-assets",
);
const outputPath = join(outputDirectory, "connector-screenshot-1280x800.png");

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          if (message?.type === "connection-status") {
            callback({ paired: false, port: 47_831 });
            return;
          }
          callback({ ok: false, message: "Preview request only." });
        },
      },
    };
  });
  const page = await context.newPage();
  await page.goto(
    pathToFileURL(
      join(
        repositoryRoot,
        "dist",
        "browser-extension",
        "chromium",
        "popup.html",
      ),
    ).href,
  );
  await page.locator("#connect").waitFor({ state: "visible" });
  await page.addStyleTag({
    content: `
      body {
        width: 1280px;
        min-height: 800px;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 20% 20%, rgb(255 255 255 / 90%), transparent 36%),
          linear-gradient(135deg, #dcefe9, #edf7f4);
      }
      main {
        width: 400px;
        border: 1px solid #b8d8d0;
        border-radius: 16px;
        padding: 24px;
        background: #f8fafc;
        box-shadow: 0 24px 70px rgb(23 32 42 / 20%);
      }
    `,
  });

  const disclosure = page.locator("#session-disclosure");
  if (!(await disclosure.isVisible())) {
    throw new Error("The required session disclosure is not visible.");
  }
  if (
    (await page.locator("#connect").textContent())?.trim() !==
    "Connect and share session"
  ) {
    throw new Error("The initial consent action has unexpected text.");
  }
  if ((await page.locator("label[for=pairing-code]").count()) !== 1) {
    throw new Error("The pairing input does not have its expected label.");
  }

  await page.screenshot({ path: outputPath });
  await context.close();
} finally {
  await browser.close();
}

process.stdout.write(
  `Captured extension listing screenshot at ${outputPath}.\n`,
);
