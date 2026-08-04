import { spawn } from "node:child_process";
import { join } from "node:path";

export interface InstalledPrinter {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface PrinterDiscoveryResult {
  readonly supported: boolean;
  readonly printers: readonly InstalledPrinter[];
  readonly issue?: string;
}

type PowerShellRunner = (
  encodedScript: string,
  timeoutMs: number,
) => Promise<string>;

export async function discoverInstalledPrinters(
  platform = process.platform,
  runPowerShell: PowerShellRunner = executePowerShell,
): Promise<PrinterDiscoveryResult> {
  if (platform !== "win32") {
    return {
      supported: false,
      printers: [],
      issue:
        "Automatic printer discovery is currently available on Windows only.",
    };
  }
  try {
    const encodedScript = Buffer.from(
      WINDOWS_PRINTER_DISCOVERY_SCRIPT,
      "utf16le",
    ).toString("base64");
    const output = await runPowerShell(encodedScript, 10_000);
    return { supported: true, printers: parseDiscoveredPrinters(output) };
  } catch {
    return {
      supported: true,
      printers: [],
      issue:
        "Windows printer discovery failed. Existing configured printer names are still available.",
    };
  }
}

export function parseDiscoveredPrinters(output: string): InstalledPrinter[] {
  const parsed = JSON.parse(output.trim() || "[]") as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const printers: InstalledPrinter[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const source = value as Record<string, unknown>;
    if (
      typeof source.name !== "string" ||
      !source.name.trim() ||
      source.name.length > 1024 ||
      typeof source.isDefault !== "boolean"
    ) {
      continue;
    }
    printers.push({ name: source.name.trim(), isDefault: source.isDefault });
  }
  return printers.sort(
    (left, right) =>
      Number(right.isDefault) - Number(left.isDefault) ||
      left.name.localeCompare(right.name),
  );
}

async function executePowerShell(
  encodedScript: string,
  timeoutMs: number,
): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const executable = systemRoot
    ? join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedScript,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: copyEnvironment([
          "SystemRoot",
          "WINDIR",
          "PATH",
          "PATHEXT",
          "TEMP",
          "TMP",
          "USERPROFILE",
        ]),
      },
    );
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`Printer discovery failed: ${stderr}`));
    });
  });
}

function copyEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const WINDOWS_PRINTER_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
$settings = New-Object System.Drawing.Printing.PrinterSettings
$defaultName = [string]$settings.PrinterName
$result = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object {
  [PSCustomObject]@{
    name = [string]$_
    isDefault = ([string]$_ -eq $defaultName)
  }
})
$result | ConvertTo-Json -Compress
`;
