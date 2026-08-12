import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const APP_URL = "http://127.0.0.1:47831";
const RELEASES_URL =
  "https://api.github.com/repos/Reldnahc/TCGPlayerAlert/releases/latest";
const UPDATE_TIMEOUT_MILLISECONDS = 5_000;

type JsonObject = Record<string, unknown>;

interface GithubAsset {
  readonly name?: unknown;
  readonly digest?: unknown;
  readonly browser_download_url?: unknown;
}

interface GithubRelease {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

export interface VerifiedRelease {
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly filename: string;
}

interface UpdateSettings {
  readonly version: 1;
  readonly checkOnLaunch: boolean;
}

export function compareVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = parseVersion(left);
  const [rightMajor, rightMinor, rightPatch] = parseVersion(right);
  const differences = [
    leftMajor - rightMajor,
    leftMinor - rightMinor,
    leftPatch - rightPatch,
  ];
  for (const difference of differences) {
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function selectVerifiedRelease(
  value: unknown,
  currentVersion: string,
): VerifiedRelease | undefined {
  if (!isObject(value)) return undefined;
  const release = value as GithubRelease;
  if (release.draft === true || release.prerelease === true) return undefined;
  if (typeof release.tag_name !== "string") return undefined;

  const version = release.tag_name.startsWith("v")
    ? release.tag_name.slice(1)
    : release.tag_name;
  try {
    if (compareVersions(version, currentVersion) <= 0) return undefined;
  } catch {
    return undefined;
  }

  if (!Array.isArray(release.assets)) return undefined;
  const filename = `TCGPlayerAlert-Setup-${version}-win-x64.exe`;
  const asset = release.assets.find(
    (candidate): candidate is GithubAsset =>
      isObject(candidate) && candidate.name === filename,
  );
  if (
    asset === undefined ||
    typeof asset.browser_download_url !== "string" ||
    !asset.browser_download_url.startsWith("https://github.com/") ||
    typeof asset.digest !== "string"
  ) {
    return undefined;
  }
  const digestMatch = /^sha256:([a-f\d]{64})$/iu.exec(asset.digest);
  if (digestMatch === null) return undefined;
  const sha256 = digestMatch[1];
  if (sha256 === undefined) return undefined;

  return {
    version,
    downloadUrl: asset.browser_download_url,
    sha256: sha256.toLowerCase(),
    filename,
  };
}

export function createInstalledConfig(
  template: unknown,
  userDataDirectory: string,
): JsonObject {
  if (!isObject(template)) {
    throw new Error("The installed configuration template is not an object.");
  }
  const result = structuredClone(template);
  result.stateFile = join(userDataDirectory, "data", "state.json");
  result.spoolDirectory = join(userDataDirectory, "spool");
  setNestedPath(
    result,
    ["shipmentScanner", "stateFile"],
    [userDataDirectory, "data", "shipment-scans.json"],
  );
  setNestedPath(
    result,
    ["priceUpdateQueue", "stateFile"],
    [userDataDirectory, "data", "price-updates.json"],
  );
  setNestedPath(
    result,
    ["inventoryAdditionQueue", "stateFile"],
    [userDataDirectory, "data", "inventory-additions.json"],
  );
  return result;
}

async function main(): Promise<number> {
  const installRoot = resolve(
    option("--install-root") ?? dirname(dirname(process.execPath)),
  );
  const appDirectory = join(installRoot, "app");
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim().length === 0) {
    return 2;
  }
  const userDataDirectory = join(localAppData, "TCGPlayerAlert");
  const logDirectory = join(userDataDirectory, "logs");
  const logPath = join(logDirectory, "service.log");
  const launcherLogPath = join(logDirectory, "launcher.log");
  await mkdir(logDirectory, { recursive: true });

  try {
    const configPath = await ensureInstalledConfiguration(
      appDirectory,
      userDataDirectory,
    );
    const currentVersion = await installedVersion(appDirectory);
    try {
      if (await shouldCheckForUpdates(userDataDirectory)) {
        const updateStarted = await startAvailableUpdate(
          currentVersion,
          userDataDirectory,
          launcherLogPath,
        );
        if (updateStarted) return 0;
      }
    } catch (error) {
      await logLauncherEvent(launcherLogPath, "update-check-failed", error);
    }

    if (await appIsRunning()) {
      openBrowser(APP_URL);
      return 0;
    }

    const logDescriptor = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [
        join(appDirectory, "dist", "cli.js"),
        "start",
        "--config",
        configPath,
        "--port",
        "47831",
      ],
      {
        cwd: appDirectory,
        detached: true,
        env: process.env,
        stdio: ["ignore", logDescriptor, logDescriptor],
        windowsHide: true,
      },
    );
    closeSync(logDescriptor);

    const ready = await waitForApplication(child);
    child.unref();
    if (!ready) {
      await logLauncherEvent(
        launcherLogPath,
        "application-start-failed",
        new Error(`See ${logPath}`),
      );
      return 2;
    }
    openBrowser(APP_URL);
    return 0;
  } catch (error) {
    await logLauncherEvent(launcherLogPath, "launcher-failed", error);
    return 2;
  }
}

async function ensureInstalledConfiguration(
  appDirectory: string,
  userDataDirectory: string,
): Promise<string> {
  const configDirectory = join(userDataDirectory, "config");
  const configPath = join(configDirectory, "local.json");
  await mkdir(configDirectory, { recursive: true });
  try {
    await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const source = await readFile(
      join(appDirectory, "config", "local.example.json"),
      "utf8",
    );
    const installed = createInstalledConfig(
      JSON.parse(source),
      userDataDirectory,
    );
    await writeFile(
      configPath,
      `${JSON.stringify(installed, undefined, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
  }
  return configPath;
}

async function shouldCheckForUpdates(
  userDataDirectory: string,
): Promise<boolean> {
  if (process.env.TCGPLAYER_ALERT_DISABLE_UPDATES === "1") return false;
  const path = join(userDataDirectory, "updates.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isObject(value) && value.checkOnLaunch !== false;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const defaults: UpdateSettings = { version: 1, checkOnLaunch: true };
    await writeFile(path, `${JSON.stringify(defaults, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  }
}

async function installedVersion(appDirectory: string): Promise<string> {
  const packageMetadata = JSON.parse(
    await readFile(join(appDirectory, "package.json"), "utf8"),
  ) as unknown;
  if (
    !isObject(packageMetadata) ||
    typeof packageMetadata.version !== "string"
  ) {
    throw new Error("Installed package metadata does not contain a version.");
  }
  parseVersion(packageMetadata.version);
  return packageMetadata.version;
}

async function startAvailableUpdate(
  currentVersion: string,
  userDataDirectory: string,
  launcherLogPath: string,
): Promise<boolean> {
  const response = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `TCGPlayerAlert/${currentVersion}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MILLISECONDS),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GitHub release check returned HTTP ${String(response.status)}.`,
    );
  }
  const release = selectVerifiedRelease(await response.json(), currentVersion);
  if (release === undefined) return false;

  const updateDirectory = join(userDataDirectory, "updates");
  const installerPath = join(updateDirectory, release.filename);
  await mkdir(updateDirectory, { recursive: true });
  if (!(await fileMatchesDigest(installerPath, release.sha256))) {
    const download = await fetch(release.downloadUrl, {
      headers: { "User-Agent": `TCGPlayerAlert/${currentVersion}` },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!download.ok) {
      throw new Error(
        `Update download returned HTTP ${String(download.status)}.`,
      );
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== release.sha256) {
      throw new Error("Downloaded update failed SHA-256 verification.");
    }
    const temporaryPath = `${installerPath}.download`;
    await writeFile(temporaryPath, bytes);
    await unlink(installerPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    await rename(temporaryPath, installerPath);
  }

  await logLauncherEvent(
    launcherLogPath,
    "update-started",
    new Error(`${currentVersion} -> ${release.version}`),
  );
  const installer = spawn(
    installerPath,
    [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/CURRENTUSER",
      "/CLOSEAPPLICATIONS",
      "/RESTARTAPPLICATIONS",
      "/AUTOLAUNCH=1",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  installer.unref();
  return true;
}

async function fileMatchesDigest(
  path: string,
  expected: string,
): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === expected;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function appIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${APP_URL}/api/settings`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const value = (await response.json()) as unknown;
    return isObject(value) && typeof value.revision === "string";
  } catch {
    return false;
  }
}

async function waitForApplication(
  child: ReturnType<typeof spawn>,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await appIsRunning()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

function openBrowser(url: string): void {
  const child = spawn("explorer.exe", [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function logLauncherEvent(
  path: string,
  event: string,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  await appendFile(
    path,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, error: errorMessage })}\n`,
    "utf8",
  ).catch(() => undefined);
}

function setNestedPath(
  root: JsonObject,
  keys: readonly [string, string],
  pathParts: readonly string[],
): void {
  const parent = root[keys[0]];
  if (!isObject(parent)) {
    throw new Error(`Configuration template is missing ${keys[0]}.`);
  }
  parent[keys[1]] = join(...pathParts);
}

function parseVersion(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) throw new Error(`Invalid application version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  process.exitCode = await main();
}
