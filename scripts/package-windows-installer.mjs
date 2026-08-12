import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const NODE_VERSION = "24.18.0";
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(repositoryRoot, "artifacts", "windows");
const stageDirectory = join(artifactsDirectory, "stage");
const cacheDirectory = join(artifactsDirectory, "cache");
const stageAppDirectory = join(stageDirectory, "app");
const packageMetadata = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const appVersion = packageMetadata.version;
const stageOnly = process.argv.includes("--stage-only");

requireStableVersion(appVersion);
assertChildPath(artifactsDirectory, stageDirectory);
await rm(stageDirectory, { recursive: true, force: true });
await mkdir(join(stageAppDirectory, "config"), { recursive: true });

await Promise.all([
  cp(join(repositoryRoot, "dist"), join(stageAppDirectory, "dist"), {
    recursive: true,
  }),
  cp(
    join(repositoryRoot, "config", "local.example.json"),
    join(stageAppDirectory, "config", "local.example.json"),
  ),
  cp(
    join(repositoryRoot, "package.json"),
    join(stageAppDirectory, "package.json"),
  ),
  cp(
    join(repositoryRoot, "package-lock.json"),
    join(stageAppDirectory, "package-lock.json"),
  ),
  cp(join(repositoryRoot, ".packages"), join(stageAppDirectory, ".packages"), {
    recursive: true,
  }),
  cp(
    join(repositoryRoot, "installer", "TCGPlayerAlert.vbs"),
    join(stageDirectory, "TCGPlayerAlert.vbs"),
  ),
]);

const npmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
run(process.execPath, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: stageAppDirectory,
});
await removeDirectoriesNamed(
  join(stageAppDirectory, "node_modules"),
  ".jest-cache",
);
await Promise.all([
  rm(join(stageAppDirectory, ".packages"), { recursive: true, force: true }),
  rm(join(stageAppDirectory, "package-lock.json"), { force: true }),
]);

await stageNodeRuntime();
await createApplicationIcon();
await writeFile(
  join(stageDirectory, "build-info.json"),
  `${JSON.stringify(
    {
      applicationVersion: appVersion,
      nodeVersion: NODE_VERSION,
      architecture: "win-x64",
    },
    undefined,
    2,
  )}\n`,
  "utf8",
);

if (stageOnly) {
  process.stdout.write(`Staged Windows application at ${stageDirectory}\n`);
  process.exit(0);
}

const compiler = await findInnoSetupCompiler();
run(compiler, [
  "/Q",
  `/DSourceDir=${stageDirectory}`,
  `/DAppVersion=${appVersion}`,
  `/DOutputDir=${artifactsDirectory}`,
  join(repositoryRoot, "installer", "TCGPlayerAlert.iss"),
]);

const installerName = `TCGPlayerAlert-Setup-${appVersion}-win-x64.exe`;
const installerPath = join(artifactsDirectory, installerName);
const digest = createHash("sha256")
  .update(await readFile(installerPath))
  .digest("hex");
await writeFile(
  join(artifactsDirectory, `${installerName}.sha256`),
  `${digest}  ${installerName}\n`,
  "utf8",
);
process.stdout.write(`Created ${installerPath}\nSHA-256 ${digest}\n`);

async function stageNodeRuntime() {
  await mkdir(cacheDirectory, { recursive: true });
  const archivePath = join(cacheDirectory, NODE_ARCHIVE);
  const checksumsUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
  const checksumResponse = await globalThis.fetch(checksumsUrl);
  if (!checksumResponse.ok) {
    throw new Error(
      `Unable to retrieve Node.js checksums: HTTP ${checksumResponse.status}`,
    );
  }
  const checksums = await checksumResponse.text();
  const checksumLine = checksums
    .split(/\r?\n/u)
    .find((line) => line.endsWith(`  ${NODE_ARCHIVE}`));
  if (checksumLine === undefined) {
    throw new Error(`Node.js checksum list does not contain ${NODE_ARCHIVE}.`);
  }
  const expectedDigest = checksumLine.slice(0, 64).toLowerCase();

  let archive = await readOptionalFile(archivePath);
  if (archive === undefined) {
    const archiveResponse = await globalThis.fetch(
      `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`,
    );
    if (!archiveResponse.ok) {
      throw new Error(
        `Unable to retrieve Node.js runtime: HTTP ${archiveResponse.status}`,
      );
    }
    archive = Buffer.from(await archiveResponse.arrayBuffer());
    await writeFile(archivePath, archive);
  }
  const actualDigest = createHash("sha256").update(archive).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Cached ${NODE_ARCHIVE} failed official SHA-256 verification.`,
    );
  }

  const zip = await JSZip.loadAsync(archive);
  const archiveRoot = `node-v${NODE_VERSION}-win-x64`;
  const runtimeDirectory = join(stageDirectory, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  for (const filename of ["node.exe", "LICENSE"]) {
    const entry = zip.file(`${archiveRoot}/${filename}`);
    if (entry === null)
      throw new Error(`${NODE_ARCHIVE} is missing ${filename}.`);
    await writeFile(
      join(runtimeDirectory, filename),
      await entry.async("nodebuffer"),
    );
  }
}

async function createApplicationIcon() {
  const png = await readFile(
    join(repositoryRoot, "browser-extension", "icons", "icon-128.png"),
  );
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(128, 6);
  header.writeUInt8(128, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  await writeFile(
    join(stageDirectory, "TCGPlayerAlert.ico"),
    Buffer.concat([header, png]),
  );
}

async function findInnoSetupCompiler() {
  const candidates = [
    process.env.INNO_SETUP_COMPILER,
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : join(process.env["ProgramFiles(x86)"], "Inno Setup 6", "ISCC.exe"),
    process.env.ProgramFiles === undefined
      ? undefined
      : join(process.env.ProgramFiles, "Inno Setup 6", "ISCC.exe"),
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
  ].filter((candidate) => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the supported installation locations.
    }
  }
  throw new Error(
    "Inno Setup 6 was not found. Install JRSoftware.InnoSetup or set INNO_SETUP_COMPILER.",
  );
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}.`);
  }
}

function requireStableVersion(value) {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(
      `Installer versions must be stable semantic versions: ${value}`,
    );
  }
}

function assertChildPath(parent, child) {
  const relationship = relative(resolve(parent), resolve(child));
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    isAbsolute(relationship)
  ) {
    throw new Error(`Refusing to replace unsafe staging path: ${child}`);
  }
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readOptionalFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function removeDirectoriesNamed(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name === name) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removeDirectoriesNamed(path, name);
    }
  }
}
