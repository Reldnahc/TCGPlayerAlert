import { execFile } from "node:child_process";
import type { ShipmentTagDetector } from "./background-april-tag-detector.js";
import type { CameraCaptureAdapter, CameraFrame } from "./camera-capture.js";
import type { ShipmentScannerConfig } from "./config.js";
import { safeErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import { safeIdentifier } from "./logger.js";
import type {
  ShipmentScannerStatus,
  ShipmentScanResult,
} from "./shipment-scanner.js";
import {
  emptyShipmentTagConsensus,
  observeShipmentTagDetection,
  type ShipmentTagConsensus,
} from "./shipment-tag-consensus.js";

const SETTINGS_REFRESH_MILLISECONDS = 1_000;
const CAMERA_RETRY_MILLISECONDS = 5_000;
const READY_TAG_REFRESH_MILLISECONDS = 5_000;
const CAMERA_REARM_EMPTY_FRAMES = 5;

export type BackgroundCameraState =
  | "disabled"
  | "starting"
  | "running"
  | "processing"
  | "waiting-for-review"
  | "error"
  | "unavailable";

export interface BackgroundCameraStatus {
  readonly state: BackgroundCameraState;
  readonly deviceId: string;
  readonly consensus: ShipmentTagConsensus;
  readonly latchedTagId?: number | undefined;
  readonly lastFrameAt?: string;
  readonly lastDetectionAt?: string;
  readonly lastResultAt?: string;
  readonly lastResult?: ShipmentScanResult;
  readonly issue?: string | undefined;
}

export interface ManagedShipmentScannerStatus extends ShipmentScannerStatus {
  readonly backgroundCamera: BackgroundCameraStatus;
}

export interface ShipmentTagResolver {
  status(): Promise<ShipmentScannerStatus>;
  scan(tagId: number, signal?: AbortSignal): Promise<ShipmentScanResult>;
  markShipped(
    tagId: number,
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult>;
}

export interface ShipmentScanCue {
  play(result: ShipmentScanResult): void;
  failure(): void;
}

export class HostShipmentScanCue implements ShipmentScanCue {
  play(result: ShipmentScanResult): void {
    hostCue(
      result.state === "shipped" ||
        result.state === "already-processed" ||
        result.state === "matched",
    );
  }

  failure(): void {
    hostCue(false);
  }
}

export interface BackgroundShipmentScannerOptions {
  readonly settings: () => Promise<ShipmentScannerConfig>;
  readonly camera: CameraCaptureAdapter;
  readonly detector: ShipmentTagDetector;
  readonly scanner: ShipmentTagResolver;
  readonly logger: Logger;
  readonly cue?: ShipmentScanCue;
  readonly now?: () => Date;
}

interface ActiveCapture {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class BackgroundShipmentScanner {
  private readonly settings: BackgroundShipmentScannerOptions["settings"];
  private readonly camera: CameraCaptureAdapter;
  private readonly detector: ShipmentTagDetector;
  private readonly scanner: ShipmentTagResolver;
  private readonly logger: Logger;
  private readonly cue: ShipmentScanCue;
  private readonly now: () => Date;
  private active: ActiveCapture | undefined;
  private retryAfter = 0;
  private knownTagIds = new Set<number>();
  private knownTagIdsFetchedAt = 0;
  private emptyFrames = 0;
  private soundEnabled = false;
  private statusValue: BackgroundCameraStatus = {
    state: "disabled",
    deviceId: "",
    consensus: emptyShipmentTagConsensus(),
  };

  constructor(options: BackgroundShipmentScannerOptions) {
    this.settings = options.settings;
    this.camera = options.camera;
    this.detector = options.detector;
    this.scanner = options.scanner;
    this.logger = options.logger;
    this.cue = options.cue ?? new HostShipmentScanCue();
    this.now = options.now ?? (() => new Date());
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.reconcile(await this.settings(), signal);
        } catch (error) {
          this.logger.error("shipment-camera.settings-failed", {
            errorCode: safeErrorCode(error),
          });
          this.statusValue = {
            ...this.statusValue,
            state: "error",
            issue: "Background camera settings could not be loaded.",
          };
        }
        await wait(SETTINGS_REFRESH_MILLISECONDS, signal);
      }
    } finally {
      await this.stopCapture();
      this.detector.close();
    }
  }

  async status(): Promise<ManagedShipmentScannerStatus> {
    return {
      ...(await this.scanner.status()),
      backgroundCamera: this.cameraStatus(),
    };
  }

  cameraStatus(): BackgroundCameraStatus {
    return {
      ...this.statusValue,
      consensus: { ...this.statusValue.consensus },
    };
  }

  async markShipped(
    tagId: number,
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<ShipmentScanResult> {
    const result = await this.scanner.markShipped(tagId, orderNumber, signal);
    this.recordResult(result);
    if (this.statusValue.state === "waiting-for-review") {
      this.statusValue = {
        ...this.statusValue,
        state: "running",
        issue: undefined,
      };
    }
    return result;
  }

  private async reconcile(
    settings: ShipmentScannerConfig,
    signal: AbortSignal,
  ): Promise<void> {
    this.soundEnabled = settings.soundEnabled;
    const enabled = settings.enabled && settings.camera.enabled;
    const key = `${enabled ? "on" : "off"}\0${settings.camera.deviceId}`;
    if (!enabled) {
      await this.stopCapture();
      this.statusValue = {
        ...this.statusValue,
        state: "disabled",
        deviceId: settings.camera.deviceId,
        consensus: emptyShipmentTagConsensus(),
        latchedTagId: undefined,
        issue: undefined,
      };
      return;
    }
    if (this.active?.key === key) return;
    if (this.active !== undefined) await this.stopCapture();
    if (this.now().getTime() < this.retryAfter) return;
    this.startCapture(key, settings.camera.deviceId, signal);
  }

  private startCapture(
    key: string,
    deviceId: string,
    parentSignal: AbortSignal,
  ): void {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    this.emptyFrames = 0;
    this.statusValue = {
      ...this.statusValue,
      state: "starting",
      deviceId,
      consensus: emptyShipmentTagConsensus(),
      latchedTagId: undefined,
      issue: undefined,
    };
    const promise = this.consumeFrames(deviceId, controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.retryAfter = this.now().getTime() + CAMERA_RETRY_MILLISECONDS;
        this.statusValue = {
          ...this.statusValue,
          state: "error",
          issue:
            "The selected camera could not keep running. Check the device and camera permission.",
        };
        this.logger.error("shipment-camera.capture-failed", {
          errorCode: safeErrorCode(error),
          device: safeIdentifier(deviceId === "" ? "default" : deviceId),
        });
      })
      .finally(() => {
        parentSignal.removeEventListener("abort", abort);
        if (this.active?.controller === controller) this.active = undefined;
      });
    this.active = { key, controller, promise };
  }

  private async consumeFrames(
    deviceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let receivedFrame = false;
    for await (const frame of this.camera.frames({ deviceId }, signal)) {
      signal.throwIfAborted();
      receivedFrame = true;
      await this.processFrame(frame, signal);
    }
    if (!signal.aborted) {
      throw new Error(
        receivedFrame
          ? "The camera stream ended."
          : "The camera stream returned no frames.",
      );
    }
  }

  private async processFrame(
    frame: CameraFrame,
    signal: AbortSignal,
  ): Promise<void> {
    this.statusValue = {
      ...this.statusValue,
      state:
        this.statusValue.state === "waiting-for-review"
          ? "waiting-for-review"
          : "running",
      lastFrameAt: this.now().toISOString(),
      issue: undefined,
    };
    if (this.statusValue.state === "waiting-for-review") return;
    const detections = await this.detector.detect(frame);
    signal.throwIfAborted();
    if (detections.length === 0) {
      this.observeEmptyFrame();
      return;
    }
    this.emptyFrames = 0;
    if (detections.length > 1) {
      this.statusValue = {
        ...this.statusValue,
        consensus: emptyShipmentTagConsensus(),
        issue:
          "Multiple shipment tags are visible. Present one parcel at a time.",
      };
      return;
    }
    const detection = detections[0];
    if (detection === undefined) return;
    this.statusValue = {
      ...this.statusValue,
      lastDetectionAt: this.now().toISOString(),
    };
    if (detection.tagId === this.statusValue.latchedTagId) {
      this.statusValue = {
        ...this.statusValue,
        consensus: emptyShipmentTagConsensus(),
      };
      return;
    }
    await this.refreshKnownTags();
    const observation = observeShipmentTagDetection(
      this.statusValue.consensus,
      detection,
      this.knownTagIds,
    );
    if (!observation.accepted) return;
    this.statusValue = {
      ...this.statusValue,
      consensus: observation.consensus,
    };
    if (observation.confirmedTagId === undefined) return;
    this.statusValue = {
      ...this.statusValue,
      state: "processing",
      consensus: emptyShipmentTagConsensus(),
      latchedTagId: observation.confirmedTagId,
    };
    try {
      const result = await this.scanner.scan(
        observation.confirmedTagId,
        signal,
      );
      this.recordResult(result);
      if (this.soundEnabled) this.cue.play(result);
      this.knownTagIdsFetchedAt = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (this.soundEnabled) this.cue.failure();
      this.statusValue = {
        ...this.statusValue,
        state: "running",
        issue:
          "The shipment tag could not be resolved. Review the parcel before retrying.",
      };
      this.logger.error("shipment-camera.scan-failed", {
        errorCode: safeErrorCode(error),
        tagId: observation.confirmedTagId,
      });
    }
  }

  private recordResult(result: ShipmentScanResult): void {
    this.statusValue = {
      ...this.statusValue,
      state: result.state === "matched" ? "waiting-for-review" : "running",
      lastResult: result,
      lastResultAt: this.now().toISOString(),
      issue: undefined,
    };
  }

  private observeEmptyFrame(): void {
    this.emptyFrames += 1;
    if (this.emptyFrames < CAMERA_REARM_EMPTY_FRAMES) return;
    this.emptyFrames = 0;
    this.statusValue = {
      ...this.statusValue,
      consensus: emptyShipmentTagConsensus(),
      latchedTagId: undefined,
      issue: undefined,
    };
  }

  private async refreshKnownTags(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.knownTagIdsFetchedAt < READY_TAG_REFRESH_MILLISECONDS) {
      return;
    }
    const status = await this.scanner.status();
    this.knownTagIds = new Set(status.readyTagIds);
    this.knownTagIdsFetchedAt = now;
  }

  private async stopCapture(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.controller.abort();
    await active.promise;
  }
}

export function unavailableBackgroundCameraStatus(): BackgroundCameraStatus {
  return {
    state: "unavailable",
    deviceId: "",
    consensus: emptyShipmentTagConsensus(),
    issue: "Background capture is available while the service is running.",
  };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function hostCue(success: boolean): void {
  if (process.platform !== "win32") {
    process.stdout.write("\u0007");
    return;
  }
  const sound = success ? "Asterisk" : "Hand";
  execFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[System.Media.SystemSounds]::${sound}.Play()`,
    ],
    { timeout: 3_000, windowsHide: true },
    () => undefined,
  );
}
