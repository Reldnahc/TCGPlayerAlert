import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export async function openDefaultBrowser(url: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const windowsDirectory = process.env.WINDIR;
  const executable =
    windowsDirectory === undefined
      ? "rundll32.exe"
      : join(windowsDirectory, "System32", "rundll32.exe");
  if (windowsDirectory !== undefined) {
    try {
      await access(executable);
    } catch {
      return false;
    }
  }
  try {
    const child = spawn(executable, ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
