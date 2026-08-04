import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandPrinterConfig } from "./config.js";
import { ApplicationError } from "./errors.js";

export interface PrintJob {
  readonly idempotencyKey: string;
  readonly jobName: string;
  readonly mediaType: "application/pdf";
  readonly bytes: Uint8Array;
}

export interface Printer {
  submit(job: PrintJob, signal?: AbortSignal): Promise<void>;
}

function safeJobName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80);
  return normalized || "print-job";
}

export class CommandPrinter implements Printer {
  private readonly spoolDirectory: string;

  constructor(
    private readonly config: CommandPrinterConfig,
    spoolDirectory: string,
  ) {
    this.spoolDirectory = resolve(spoolDirectory);
  }

  async submit(job: PrintJob, signal?: AbortSignal): Promise<void> {
    await mkdir(this.spoolDirectory, { recursive: true });
    const jobName = safeJobName(job.jobName);
    const filePath = resolve(
      this.spoolDirectory,
      `${jobName}-${randomUUID()}.pdf`,
    );
    if (
      !filePath.startsWith(`${this.spoolDirectory}\\`) &&
      !filePath.startsWith(`${this.spoolDirectory}/`)
    ) {
      throw new ApplicationError(
        "PRINT_FAILED",
        "The print spool path was unsafe.",
      );
    }
    await writeFile(filePath, job.bytes, { flag: "wx", mode: 0o600 });
    try {
      const argumentsList = this.config.arguments.map((argument) =>
        argument
          .replaceAll("{file}", filePath)
          .replaceAll("{printer}", this.config.printerName)
          .replaceAll("{job}", jobName),
      );
      await executePrintCommand(
        this.config.executable,
        argumentsList,
        this.config.timeoutSeconds * 1000,
        signal,
      );
    } finally {
      await removeTemporaryFile(filePath);
    }
  }
}

async function executePrintCommand(
  executable: string,
  argumentsList: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new ApplicationError(
      "PRINT_FAILED",
      "Print submission was canceled before it began.",
    );
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let spawned = false;
    let settled = false;
    const child = spawn(executable, argumentsList, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const finish = (error?: ApplicationError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const abort = () => {
      child.kill();
      finish(
        new ApplicationError(
          spawned ? "PRINT_AMBIGUOUS" : "PRINT_FAILED",
          spawned
            ? "Print submission was canceled after the print process started."
            : "Print submission was canceled before the print process started.",
        ),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new ApplicationError(
          "PRINT_AMBIGUOUS",
          "The print process timed out after submission began.",
        ),
      );
    }, timeoutMs);
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      finish(
        new ApplicationError(
          spawned ? "PRINT_AMBIGUOUS" : "PRINT_FAILED",
          spawned
            ? "The print process failed after submission began."
            : "The configured print executable could not be started.",
          { cause: error },
        ),
      );
    });
    child.once("exit", (code, exitSignal) => {
      if (code === 0) finish();
      else {
        finish(
          new ApplicationError(
            "PRINT_AMBIGUOUS",
            `The print process ended without confirmation (${code === null ? (exitSignal ?? "unknown") : String(code)}).`,
          ),
        );
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function removeTemporaryFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      if (attempt < 4) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
  }
  throw new ApplicationError(
    "PRINT_AMBIGUOUS",
    "The temporary print file could not be removed after submission.",
  );
}
