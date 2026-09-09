const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAXIMUM_REMOTE_ID_CODE_POINTS = 256;

export interface ProviderOrderRef {
  readonly connectionId: string;
  readonly remoteId: string;
}

export class MarketplaceValidationError extends Error {
  readonly code = "INVALID_MARKETPLACE_CONTRACT";

  constructor(message: string) {
    super(message);
    this.name = "MarketplaceValidationError";
  }
}

export function parseProviderId(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new MarketplaceValidationError("The provider ID is invalid.");
  }
  return value;
}

export function parseConnectionId(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new MarketplaceValidationError("The connection ID is invalid.");
  }
  return value;
}

export function parseRemoteId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > MAXIMUM_REMOTE_ID_CODE_POINTS ||
    /\p{Cc}/u.test(value) ||
    !isUriEncodable(value)
  ) {
    throw new MarketplaceValidationError("The remote entity ID is invalid.");
  }
  return value;
}

export function parseProviderOrderRef(value: unknown): ProviderOrderRef {
  if (!isRecord(value)) {
    throw new MarketplaceValidationError(
      "The provider order reference is invalid.",
    );
  }
  return {
    connectionId: parseConnectionId(value.connectionId),
    remoteId: parseRemoteId(value.remoteId),
  };
}

export function orderRefKey(ref: ProviderOrderRef): string {
  const validated = parseProviderOrderRef(ref);
  return `${validated.connectionId}/${encodeURIComponent(validated.remoteId)}`;
}

export function parseOrderRefKey(value: unknown): ProviderOrderRef {
  if (typeof value !== "string") {
    throw new MarketplaceValidationError("The provider order key is invalid.");
  }
  const separator = value.indexOf("/");
  if (separator < 1 || value.slice(separator + 1).includes("/")) {
    throw new MarketplaceValidationError("The provider order key is invalid.");
  }
  let remoteId: string;
  try {
    remoteId = decodeURIComponent(value.slice(separator + 1));
  } catch {
    throw new MarketplaceValidationError("The provider order key is invalid.");
  }
  const ref = parseProviderOrderRef({
    connectionId: value.slice(0, separator),
    remoteId,
  });
  if (orderRefKey(ref) !== value) {
    throw new MarketplaceValidationError(
      "The provider order key is not canonical.",
    );
  }
  return ref;
}

export function sameOrderRef(
  left: ProviderOrderRef,
  right: ProviderOrderRef,
): boolean {
  return (
    left.connectionId === right.connectionId && left.remoteId === right.remoteId
  );
}

function isUriEncodable(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
