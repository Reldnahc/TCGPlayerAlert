import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandPrinter } from "../src/index.js";

const syntheticPdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

describe("command printer", () => {
  it("submits a temporary PDF without a shell and removes the spool file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-print-"));
    try {
      const printer = new CommandPrinter(
        {
          adapter: "command",
          executable: process.execPath,
          arguments: [
            "-e",
            "const fs=require('node:fs');process.exit(fs.existsSync(process.argv[1])?0:1)",
            "{file}",
          ],
          printerName: "Synthetic Printer",
          timeoutSeconds: 10,
        },
        directory,
      );

      await printer.submit({
        idempotencyKey: "synthetic:order:action",
        jobName: "synthetic-job",
        mediaType: "application/pdf",
        bytes: syntheticPdf,
      });

      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies a missing executable as a definite print failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-print-"));
    try {
      const printer = new CommandPrinter(
        {
          adapter: "command",
          executable: join(directory, "missing-print-executable"),
          arguments: ["{file}"],
          printerName: "Synthetic Printer",
          timeoutSeconds: 10,
        },
        directory,
      );

      await expect(
        printer.submit({
          idempotencyKey: "synthetic:order:action",
          jobName: "synthetic-job",
          mediaType: "application/pdf",
          bytes: syntheticPdf,
        }),
      ).rejects.toMatchObject({ code: "PRINT_FAILED" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
