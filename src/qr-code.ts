import jsQR from "jsqr";
import * as QRCode from "qrcode";

type JsQrDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { readonly inversionAttempts: "dontInvert" },
) => { readonly data: string } | null;

const decodeQr = jsQR as unknown as JsQrDecoder;

export interface QrCodeMatrix {
  readonly rows: readonly string[];
  readonly quietZoneModules: number;
  readonly sizeMm: number;
}

const MAXIMUM_QR_PIXELS = 16_000_000;
const QR_VALUE_PATTERN = /^TCGA1:[A-Z0-9]{16}$/u;

export function createShipmentQrCode(value: string): QrCodeMatrix {
  if (!QR_VALUE_PATTERN.test(value)) {
    throw new TypeError("A valid shipment verification code is required.");
  }
  const qrCode = QRCode.create([{ data: value, mode: "alphanumeric" }], {
    errorCorrectionLevel: "Q",
  });
  const rows = Array.from({ length: qrCode.modules.size }, (_, row) =>
    Array.from({ length: qrCode.modules.size }, (_, column) =>
      qrCode.modules.get(row, column) === 1 ? "1" : "0",
    ).join(""),
  );
  return {
    rows,
    quietZoneModules: 4,
    sizeMm: 14,
  };
}

export function decodeShipmentQrPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | undefined {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAXIMUM_QR_PIXELS ||
    data.length !== width * height * 4
  ) {
    return undefined;
  }
  const result = decodeQr(data, width, height, {
    inversionAttempts: "dontInvert",
  });
  return result === null ? undefined : result.data;
}
