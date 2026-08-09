import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import type {
  CommandPrinterConfig,
  PrinterConfig,
  WindowsNativeLabelPrinterConfig,
  WindowsPdfPrinterConfig,
} from "./config.js";
import { ApplicationError } from "./errors.js";
import type { QrCodeMatrix } from "./qr-code.js";

export interface PrintJobBase {
  readonly idempotencyKey: string;
  readonly jobName: string;
}

export interface PdfPrintJob extends PrintJobBase {
  readonly mediaType: "application/pdf";
  readonly bytes: Uint8Array;
}

export interface AddressLabelPrintJob extends PrintJobBase {
  readonly mediaType: "application/vnd.tcgplayer-alert.address-label+json";
  readonly page: {
    readonly widthMm: number;
    readonly heightMm: number;
    readonly marginMm: number;
    readonly fontSize: number;
  };
  readonly lines: readonly string[];
  readonly qrCode?: QrCodeMatrix;
}

export type PrintJob = PdfPrintJob | AddressLabelPrintJob;
export type PrintMediaType = PrintJob["mediaType"];

export interface Printer {
  readonly acceptedMediaTypes: ReadonlySet<PrintMediaType>;
  submit(job: PrintJob, signal?: AbortSignal): Promise<void>;
}

export interface RasterizedPage {
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly pngBytes: Uint8Array;
}

export interface PdfPageRenderer {
  render(bytes: Uint8Array, dpi: number): Promise<readonly RasterizedPage[]>;
}

export class PdfJsPageRenderer implements PdfPageRenderer {
  async render(
    bytes: Uint8Array,
    dpi: number,
  ): Promise<readonly RasterizedPage[]> {
    if (bytes.byteLength < 5 || bytes.byteLength > 50 * 1024 * 1024) {
      throw new ApplicationError(
        "PRINT_FAILED",
        "The PDF byte size is outside the supported print range.",
      );
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfJsRoot = resolve(
      dirname(
        fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")),
      ),
      "..",
      "..",
    );
    const loadingTask = getDocument({
      data: Uint8Array.from(bytes),
      cMapPacked: true,
      cMapUrl: pdfJsFactoryPath(pdfJsRoot, "cmaps"),
      isEvalSupported: false,
      standardFontDataUrl: pdfJsFactoryPath(pdfJsRoot, "standard_fonts"),
      stopAtErrors: true,
      wasmUrl: pdfJsFactoryPath(pdfJsRoot, "wasm"),
    });
    let document: Awaited<typeof loadingTask.promise> | undefined;
    try {
      document = await loadingTask.promise;
      if (document.numPages < 1 || document.numPages > 50) {
        throw new ApplicationError(
          "PRINT_FAILED",
          "The PDF page count is outside the supported print range.",
        );
      }
      const pages: RasterizedPage[] = [];
      let totalPixels = 0;
      for (
        let pageNumber = 1;
        pageNumber <= document.numPages;
        pageNumber += 1
      ) {
        const page = await document.getPage(pageNumber);
        const physicalViewport = page.getViewport({ scale: 1 });
        const renderViewport = page.getViewport({ scale: dpi / 72 });
        const width = Math.ceil(renderViewport.width);
        const height = Math.ceil(renderViewport.height);
        totalPixels += width * height;
        if (width < 1 || height < 1 || width * height > 40_000_000) {
          throw new ApplicationError(
            "PRINT_FAILED",
            "A PDF page is outside the supported rendered size.",
          );
        }
        if (totalPixels > 100_000_000) {
          throw new ApplicationError(
            "PRINT_FAILED",
            "The PDF exceeds the supported total rendered size.",
          );
        }
        const canvas = createCanvas(width, height);
        const context = canvas.getContext("2d");
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport: renderViewport,
          intent: "print",
          background: "rgb(255,255,255)",
        }).promise;
        pages.push({
          widthPoints: physicalViewport.width,
          heightPoints: physicalViewport.height,
          pngBytes: await canvas.encode("png"),
        });
        page.cleanup();
      }
      return pages;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PRINT_FAILED",
        "The PDF could not be rendered for printing.",
        { cause: error },
      );
    } finally {
      await document?.destroy();
    }
  }
}

function pdfJsFactoryPath(root: string, directory: string): string {
  return `${join(root, directory).replaceAll("\\", "/")}/`;
}

function safeJobName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80);
  return normalized || "print-job";
}

export class CommandPrinter implements Printer {
  readonly acceptedMediaTypes = new Set<PrintMediaType>(["application/pdf"]);
  private readonly spoolDirectory: string;

  constructor(
    private readonly config: CommandPrinterConfig,
    spoolDirectory: string,
  ) {
    this.spoolDirectory = resolve(spoolDirectory);
  }

  async submit(job: PrintJob, signal?: AbortSignal): Promise<void> {
    if (job.mediaType !== "application/pdf") {
      throw unsupportedMediaType();
    }
    await mkdir(this.spoolDirectory, { recursive: true });
    const jobName = safeJobName(job.jobName);
    const filePath = resolve(
      this.spoolDirectory,
      `${jobName}-${randomUUID()}.pdf`,
    );
    if (!isChildPath(this.spoolDirectory, filePath)) {
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
      await executePrintProcess(
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

interface WindowsSpoolPayloadBase {
  readonly printerName: string;
  readonly jobName: string;
}

interface WindowsLabelPayload extends WindowsSpoolPayloadBase {
  readonly kind: "label";
  readonly page: AddressLabelPrintJob["page"] & {
    readonly landscape: boolean;
  };
  readonly lines: readonly string[];
  readonly qrCode?: QrCodeMatrix;
}

interface WindowsRasterPayload extends WindowsSpoolPayloadBase {
  readonly kind: "raster-pages";
  readonly scale: WindowsPdfPrinterConfig["scale"];
  readonly pages: readonly {
    readonly path: string;
    readonly widthPoints: number;
    readonly heightPoints: number;
  }[];
}

export type WindowsSpoolPayload = WindowsLabelPayload | WindowsRasterPayload;
export type WindowsPrintExecutor = (
  payloadPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<void>;

export class WindowsNativeLabelPrinter implements Printer {
  readonly acceptedMediaTypes = new Set<PrintMediaType>([
    "application/vnd.tcgplayer-alert.address-label+json",
  ]);

  constructor(
    private readonly config: WindowsNativeLabelPrinterConfig,
    private readonly spoolDirectory: string,
    private readonly execute: WindowsPrintExecutor = executeWindowsPrint,
  ) {}

  async submit(job: PrintJob, signal?: AbortSignal): Promise<void> {
    if (
      job.mediaType !== "application/vnd.tcgplayer-alert.address-label+json"
    ) {
      throw unsupportedMediaType();
    }
    await withSpoolWorkspace(
      this.spoolDirectory,
      job.jobName,
      async (directory) => {
        const payload: WindowsLabelPayload = {
          kind: "label",
          printerName: this.config.printerName,
          jobName: safeJobName(job.jobName),
          page: {
            ...job.page,
            landscape: job.page.widthMm > job.page.heightMm,
          },
          lines: job.lines,
          ...(job.qrCode === undefined ? {} : { qrCode: job.qrCode }),
        };
        const payloadPath = join(directory, "payload.json");
        await writePrivateJson(payloadPath, payload);
        await this.execute(
          payloadPath,
          this.config.timeoutSeconds * 1000,
          signal,
        );
      },
    );
  }
}

export class WindowsPdfPrinter implements Printer {
  readonly acceptedMediaTypes = new Set<PrintMediaType>(["application/pdf"]);

  constructor(
    private readonly config: WindowsPdfPrinterConfig,
    private readonly spoolDirectory: string,
    private readonly renderer: PdfPageRenderer = new PdfJsPageRenderer(),
    private readonly execute: WindowsPrintExecutor = executeWindowsPrint,
  ) {}

  async submit(job: PrintJob, signal?: AbortSignal): Promise<void> {
    if (job.mediaType !== "application/pdf") throw unsupportedMediaType();
    if (signal?.aborted) throw canceledBeforeSubmission();
    const pages = await this.renderer.render(job.bytes, this.config.dpi);
    await withSpoolWorkspace(
      this.spoolDirectory,
      job.jobName,
      async (directory) => {
        const pageMetadata: WindowsRasterPayload["pages"][number][] = [];
        for (const [index, page] of pages.entries()) {
          const path = join(directory, `page-${String(index + 1)}.png`);
          await writeFile(path, page.pngBytes, { flag: "wx", mode: 0o600 });
          pageMetadata.push({
            path,
            widthPoints: page.widthPoints,
            heightPoints: page.heightPoints,
          });
        }
        const payload: WindowsRasterPayload = {
          kind: "raster-pages",
          printerName: this.config.printerName,
          jobName: safeJobName(job.jobName),
          scale: this.config.scale,
          pages: pageMetadata,
        };
        const payloadPath = join(directory, "payload.json");
        await writePrivateJson(payloadPath, payload);
        await this.execute(
          payloadPath,
          this.config.timeoutSeconds * 1000,
          signal,
        );
      },
    );
  }
}

export function createPrinter(
  config: PrinterConfig,
  spoolDirectory: string,
): Printer {
  if (config.adapter === "command") {
    return new CommandPrinter(config, spoolDirectory);
  }
  if (config.adapter === "windows-native-label") {
    return new WindowsNativeLabelPrinter(config, spoolDirectory);
  }
  return new WindowsPdfPrinter(config, spoolDirectory);
}

async function withSpoolWorkspace<T>(
  spoolDirectory: string,
  jobName: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const root = resolve(spoolDirectory);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, `${safeJobName(jobName)}-`));
  if (!isChildPath(root, directory)) {
    throw new ApplicationError(
      "PRINT_FAILED",
      "The print spool path was unsafe.",
    );
  }
  let outcome:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: unknown;
      };
  try {
    outcome = { ok: true, value: await operation(directory) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  } catch (cleanupError) {
    throw new ApplicationError(
      "PRINT_AMBIGUOUS",
      "Temporary print data could not be removed after submission.",
      {
        cause: outcome.ok
          ? cleanupError
          : new AggregateError([outcome.error, cleanupError]),
      },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function isChildPath(parent: string, child: string): boolean {
  return child.startsWith(`${parent}\\`) || child.startsWith(`${parent}/`);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
}

async function executeWindowsPrint(
  payloadPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new ApplicationError(
      "PRINT_FAILED",
      "This printer adapter requires Windows.",
    );
  }
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
  const encodedScript = Buffer.from(WINDOWS_PRINT_SCRIPT, "utf16le").toString(
    "base64",
  );
  const environment = copyEnvironment([
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ]);
  environment.TCGPLAYER_ALERT_PRINT_PAYLOAD = payloadPath;
  await executePrintProcess(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedScript,
    ],
    timeoutMs,
    signal,
    environment,
    new Set([10]),
  );
}

function copyEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function executePrintProcess(
  executable: string,
  argumentsList: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  definiteFailureCodes: ReadonlySet<number> = new Set(),
): Promise<void> {
  if (signal?.aborted) throw canceledBeforeSubmission();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let spawned = false;
    let settled = false;
    const child = spawn(executable, argumentsList, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      ...(environment === undefined ? {} : { env: environment }),
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
      if (code === 0) {
        finish();
      } else if (code !== null && definiteFailureCodes.has(code)) {
        finish(
          new ApplicationError(
            "PRINT_FAILED",
            "The configured printer or print document failed preflight validation.",
          ),
        );
      } else {
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

function unsupportedMediaType(): ApplicationError {
  return new ApplicationError(
    "CONFIGURATION_ERROR",
    "The selected printer adapter does not accept this document type.",
  );
}

function canceledBeforeSubmission(): ApplicationError {
  return new ApplicationError(
    "PRINT_FAILED",
    "Print submission was canceled before it began.",
  );
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

export const WINDOWS_PRINT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $payloadPath = [Environment]::GetEnvironmentVariable('TCGPLAYER_ALERT_PRINT_PAYLOAD')
  if ([String]::IsNullOrWhiteSpace($payloadPath)) { throw 'Missing payload.' }
  $payload = Get-Content -Raw -LiteralPath $payloadPath | ConvertFrom-Json
  $installed = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters)
  if ($installed -notcontains [string]$payload.printerName) { throw 'Printer unavailable.' }

  $document = New-Object System.Drawing.Printing.PrintDocument
  $document.PrinterSettings.PrinterName = [string]$payload.printerName
  $document.DocumentName = [string]$payload.jobName
  $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

  if ($payload.kind -eq 'label') {
    $configuredWidth = [Math]::Max(1, [int][Math]::Round([double]$payload.page.widthMm / 25.4 * 100))
    $configuredHeight = [Math]::Max(1, [int][Math]::Round([double]$payload.page.heightMm / 25.4 * 100))
    $portraitWidth = [Math]::Min($configuredWidth, $configuredHeight)
    $portraitHeight = [Math]::Max($configuredWidth, $configuredHeight)
    $document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('TCGPlayerAlert label', $portraitWidth, $portraitHeight)
    $document.DefaultPageSettings.Landscape = [bool]$payload.page.landscape
    $font = New-Object System.Drawing.Font('Arial', [single]$payload.page.fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    $text = [String]::Join([Environment]::NewLine, @($payload.lines))
    $margin = [single]([double]$payload.page.marginMm / 25.4 * 100)
    $qr = $payload.qrCode
    $qrSize = if ($null -eq $qr) { [single]0 } else { [single]([double]$qr.sizeMm / 25.4 * 100) }
    $qrGap = if ($null -eq $qr) { [single]0 } else { [single](2 / 25.4 * 100) }
    $handler = [System.Drawing.Printing.PrintPageEventHandler]{
      param($sender, $eventArgs)
      $eventArgs.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
      $printableArea = $eventArgs.PageSettings.PrintableArea
      $reportedPrintableWidth = [single]$printableArea.Width
      $reportedPrintableHeight = [single]$printableArea.Height
      if ([bool]$payload.page.landscape) {
        $printableWidth = [single][Math]::Max($reportedPrintableWidth, $reportedPrintableHeight)
        $printableHeight = [single][Math]::Min($reportedPrintableWidth, $reportedPrintableHeight)
      } else {
        $printableWidth = [single][Math]::Min($reportedPrintableWidth, $reportedPrintableHeight)
        $printableHeight = [single][Math]::Max($reportedPrintableWidth, $reportedPrintableHeight)
      }
      $contentWidth = [single]($printableWidth - 2 * $margin)
      $contentHeight = [single]($printableHeight - 2 * $margin)
      if ($contentWidth -le 0 -or $contentHeight -le 0) { throw 'The configured label margins exceed the printer printable area.' }
      if ($null -ne $qr -and ($qrSize -gt $contentWidth -or $qrSize -gt $contentHeight)) { throw 'The QR code does not fit inside the printer printable area.' }
      $textWidth = [single]($contentWidth - $qrSize - $qrGap)
      if ($textWidth -le 0) { throw 'The address and QR code do not fit inside the printer printable area.' }
      $bounds = New-Object System.Drawing.RectangleF($margin, $margin, $textWidth, $contentHeight)
      $format = New-Object System.Drawing.StringFormat
      try {
        $format.Trimming = [System.Drawing.StringTrimming]::Word
        $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
        $eventArgs.Graphics.DrawString($text, $font, [System.Drawing.Brushes]::Black, $bounds, $format)
        if ($null -ne $qr) {
          $rows = @($qr.rows)
          $quiet = [int]$qr.quietZoneModules
          $totalModules = $rows.Count + 2 * $quiet
          $moduleSize = [single]($qrSize / $totalModules)
          $qrX = [single]($printableWidth - $margin - $qrSize)
          $qrY = $margin
          for ($row = 0; $row -lt $rows.Count; $row += 1) {
            $modules = [string]$rows[$row]
            for ($column = 0; $column -lt $modules.Length; $column += 1) {
              if ($modules[$column] -ne '1') { continue }
              $moduleX = [single]($qrX + ($column + $quiet) * $moduleSize)
              $moduleY = [single]($qrY + ($row + $quiet) * $moduleSize)
              $eventArgs.Graphics.FillRectangle([System.Drawing.Brushes]::Black, $moduleX, $moduleY, $moduleSize, $moduleSize)
            }
          }
        }
      } finally {
        $format.Dispose()
      }
      $eventArgs.HasMorePages = $false
    }
  } elseif ($payload.kind -eq 'raster-pages') {
    if (@($payload.pages).Count -lt 1) { throw 'No rendered pages.' }
    $pageState = @{ Index = 0 }
    $handler = [System.Drawing.Printing.PrintPageEventHandler]{
      param($sender, $eventArgs)
      $page = @($payload.pages)[$pageState.Index]
      $image = [System.Drawing.Image]::FromFile([string]$page.path)
      try {
        $eventArgs.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
        $eventArgs.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $available = $eventArgs.MarginBounds
        $physicalWidth = [double]$page.widthPoints / 72 * 100
        $physicalHeight = [double]$page.heightPoints / 72 * 100
        $fit = [Math]::Min($available.Width / $physicalWidth, $available.Height / $physicalHeight)
        if ($payload.scale -eq 'actual-size') { $factor = 1.0 }
        elseif ($payload.scale -eq 'shrink') { $factor = [Math]::Min(1.0, $fit) }
        else { $factor = $fit }
        $targetWidth = [single]($physicalWidth * $factor)
        $targetHeight = [single]($physicalHeight * $factor)
        $x = [single]($available.Left + ($available.Width - $targetWidth) / 2)
        $y = [single]($available.Top + ($available.Height - $targetHeight) / 2)
        $target = New-Object System.Drawing.RectangleF($x, $y, $targetWidth, $targetHeight)
        $eventArgs.Graphics.DrawImage($image, $target)
      } finally {
        $image.Dispose()
      }
      $pageState.Index += 1
      $eventArgs.HasMorePages = $pageState.Index -lt @($payload.pages).Count
    }
  } else {
    throw 'Unsupported payload.'
  }
} catch {
  exit 10
}

try {
  $document.add_PrintPage($handler)
  $document.Print()
  exit 0
} catch {
  exit 20
} finally {
  if ($null -ne $handler) { $document.remove_PrintPage($handler) }
  if ($null -ne $font) { $font.Dispose() }
  if ($null -ne $document) { $document.Dispose() }
}
`;
