import { createHash } from "node:crypto";

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

function write(
  level: "info" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const destination = level === "error" ? process.stderr : process.stdout;
  destination.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}

export const jsonLogger: Logger = {
  info: (event, fields) => write("info", event, fields),
  error: (event, fields) => write("error", event, fields),
};

export function safeIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
