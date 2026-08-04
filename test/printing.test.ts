import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  CommandPrinter,
  PdfJsPageRenderer,
  WindowsNativeLabelPrinter,
  WindowsPdfPrinter,
  type WindowsSpoolPayload,
} from "../src/index.js";

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

describe("Windows printer adapters", () => {
  it("passes a structured label to the native spooler and removes customer data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-print-"));
    let payload: WindowsSpoolPayload | undefined;
    try {
      const printer = new WindowsNativeLabelPrinter(
        {
          adapter: "windows-native-label",
          printerName: "Synthetic Label Printer",
          timeoutSeconds: 10,
        },
        directory,
        async (payloadPath) => {
          payload = JSON.parse(
            await readFile(payloadPath, "utf8"),
          ) as WindowsSpoolPayload;
        },
      );

      await printer.submit({
        idempotencyKey: "synthetic:order:label",
        jobName: "synthetic-label",
        mediaType: "application/vnd.tcgplayer-alert.address-label+json",
        page: { widthMm: 89, heightMm: 28, marginMm: 3, fontSize: 10 },
        lines: ["Example Recipient", "123 Example Street"],
      });

      expect(payload).toMatchObject({
        kind: "label",
        printerName: "Synthetic Label Printer",
        lines: ["Example Recipient", "123 Example Street"],
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders PDF pages before handing them to the Windows spooler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-print-"));
    let renderedAtDpi = 0;
    let payload: WindowsSpoolPayload | undefined;
    try {
      const printer = new WindowsPdfPrinter(
        {
          adapter: "windows-pdf",
          printerName: "Synthetic Office Printer",
          timeoutSeconds: 10,
          dpi: 150,
          scale: "shrink",
        },
        directory,
        {
          render: (_bytes, dpi) => {
            renderedAtDpi = dpi;
            return Promise.resolve([
              {
                widthPoints: 612,
                heightPoints: 792,
                pngBytes: new Uint8Array([137, 80, 78, 71]),
              },
            ]);
          },
        },
        async (payloadPath) => {
          payload = JSON.parse(
            await readFile(payloadPath, "utf8"),
          ) as WindowsSpoolPayload;
          if (payload.kind === "raster-pages") {
            expect(await readFile(payload.pages[0]?.path ?? "")).toEqual(
              Buffer.from([137, 80, 78, 71]),
            );
          }
        },
      );

      await printer.submit({
        idempotencyKey: "synthetic:order:packing-slip",
        jobName: "synthetic-packing-slip",
        mediaType: "application/pdf",
        bytes: syntheticPdf,
      });

      expect(renderedAtDpi).toBe(150);
      expect(payload).toMatchObject({
        kind: "raster-pages",
        printerName: "Synthetic Office Printer",
        scale: "shrink",
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("PDF.js page renderer", () => {
  it("renders a synthetic PDF to a PNG without an installed PDF viewer", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([144, 72]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("Synthetic packing slip", { x: 12, y: 36, size: 10, font });
    const pages = await new PdfJsPageRenderer().render(
      await document.save(),
      144,
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ widthPoints: 144, heightPoints: 72 });
    expect(Array.from(pages[0]?.pngBytes.slice(0, 8) ?? [])).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
  });
});
