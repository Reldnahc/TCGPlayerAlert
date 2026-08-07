export function money(value: number | undefined): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
}

export function compactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year:
          date.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
      });
}

export function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function normalizedTokens(value: string): readonly string[] {
  return value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
}

export function formatStatus(value: string): string {
  return value.replaceAll("-", " ");
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
