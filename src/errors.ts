export type ApplicationErrorCode =
  | "CONFIGURATION_ERROR"
  | "PERSISTENCE_ERROR"
  | "PROVIDER_ERROR"
  | "PRINT_FAILED"
  | "PRINT_AMBIGUOUS"
  | "PAIRING_REQUIRED"
  | "TRACKING_REQUIRED"
  | "REVIEW_REQUIRED";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class ConfigurationError extends ApplicationError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      "CONFIGURATION_ERROR",
      `Configuration is invalid (${String(issues.length)} issue${issues.length === 1 ? "" : "s"}).`,
    );
    this.name = "ConfigurationError";
    this.issues = [...issues];
  }
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ApplicationError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "UNEXPECTED_ERROR";
}
