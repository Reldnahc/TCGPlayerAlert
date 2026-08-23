export interface ParsedAddressLabel {
  readonly lines: readonly string[];
}

export interface AddressListParseResult {
  readonly labels: readonly ParsedAddressLabel[];
  readonly issues: readonly string[];
}

const MAXIMUM_LABELS = 100;
const MAXIMUM_LINES = 8;
const MAXIMUM_LINE_LENGTH = 128;
const POSTAL_END =
  /(?:\b[A-Z]{2}\s+\d{5}(?:-\d{4})?|\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d)\s*(?:USA?|UNITED STATES(?: OF AMERICA)?|CANADA)?$/iu;
const POSTAL_ONLY = /^(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z][ -]?\d[A-Z]\d)$/iu;
const TERRITORY_ONLY = /^[A-Z]{2,3}$/u;
const COUNTRY = /^(?:USA?|UNITED STATES(?: OF AMERICA)?|CANADA)$/iu;

const HEADER_ALIASES = {
  name: new Set(["name", "full name", "recipient", "recipient name", "buyer"]),
  addressOne: new Set([
    "address",
    "address 1",
    "address1",
    "street",
    "street 1",
    "street1",
  ]),
  addressTwo: new Set([
    "address 2",
    "address2",
    "street 2",
    "street2",
    "unit",
    "apartment",
  ]),
  city: new Set(["city", "town"]),
  territory: new Set(["state", "province", "region", "territory"]),
  postalCode: new Set([
    "zip",
    "zip code",
    "zipcode",
    "postal",
    "postal code",
    "postcode",
  ]),
  country: new Set(["country", "country code"]),
} as const;

type AddressField = keyof typeof HEADER_ALIASES;

export function parseAddressList(value: string): AddressListParseResult {
  const normalized = value
    .replaceAll("\u00a0", " ")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (normalized === "") return { labels: [], issues: [] };

  const blocks = parseTabular(normalized) ?? parseTextBlocks(normalized);
  const labels = blocks
    .map((lines) => ({ lines: formatAddressLines(lines) }))
    .filter((label) => label.lines.length > 0);
  const issues = validateAddressLabels(labels);
  return {
    labels: labels.slice(0, MAXIMUM_LABELS),
    issues,
  };
}

export function validateAddressLabels(
  labels: readonly ParsedAddressLabel[],
): readonly string[] {
  const issues: string[] = [];
  if (labels.length === 0) issues.push("Paste at least one address.");
  if (labels.length > MAXIMUM_LABELS) {
    issues.push(
      `A batch can contain at most ${String(MAXIMUM_LABELS)} labels.`,
    );
  }
  labels.forEach((label, index) => {
    if (label.lines.length === 0 || label.lines.length > MAXIMUM_LINES) {
      issues.push(
        `Label ${String(index + 1)} must contain one to ${String(MAXIMUM_LINES)} lines.`,
      );
    }
    if (label.lines.some((line) => line.length > MAXIMUM_LINE_LENGTH)) {
      issues.push(
        `Every line on label ${String(index + 1)} must be ${String(MAXIMUM_LINE_LENGTH)} characters or fewer.`,
      );
    }
    if (label.lines.some((line) => containsControlCharacter(line))) {
      issues.push(`Label ${String(index + 1)} contains an invalid character.`);
    }
  });
  return [...new Set(issues)];
}

export function addressLines(value: string): readonly string[] {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
}

function parseTabular(value: string): readonly (readonly string[])[] | null {
  const rows = value.split("\n").filter((line) => line.trim() !== "");
  const tabular = rows.some((row) => row.includes("\t"));
  const csvHeader = !tabular && headerMap(parseCsvRow(rows[0] ?? "")) !== null;
  if (!tabular && !csvHeader) return null;

  const parsedRows = rows.map((row) =>
    tabular ? row.split("\t").map(cleanLine) : parseCsvRow(row),
  );
  const headers = headerMap(parsedRows[0] ?? []);
  const dataRows = headers === null ? parsedRows : parsedRows.slice(1);
  return dataRows
    .map((row) =>
      headers === null
        ? formatDelimitedParts(row)
        : rowFromHeaders(row, headers),
    )
    .filter((row) => row.length > 0);
}

function parseTextBlocks(value: string): readonly (readonly string[])[] {
  const blankSeparated = value
    .split(/\n\s*\n+/u)
    .map((block) => block.split("\n").map(cleanLine).filter(Boolean))
    .filter((block) => block.length > 0);
  if (blankSeparated.length > 1) return blankSeparated;

  const lines = value.split("\n").map(cleanLine).filter(Boolean);
  if (lines.length <= 1) return [lines];
  if (lines.every(isInlineAddress)) {
    return lines.map((line) => [line]);
  }

  const terminalCount = lines.filter((line) => POSTAL_END.test(line)).length;
  if (terminalCount < 2) return [lines];
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    current.push(line);
    if (POSTAL_END.test(line)) {
      result.push(current);
      current = [];
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function isInlineAddress(value: string): boolean {
  if (!value.includes(",")) return false;
  if (POSTAL_END.test(value)) return true;
  const parts = value.split(",").map(cleanLine).filter(Boolean);
  return parts.length >= 4 && POSTAL_ONLY.test(parts.at(-1) ?? "");
}

function formatAddressLines(source: readonly string[]): readonly string[] {
  const lines = source.map(cleanLine).filter(Boolean);
  if (lines.length === 1) return splitInlineAddress(lines[0] ?? "");
  return mergePostalLines(lines);
}

function splitInlineAddress(value: string): readonly string[] {
  const delimiter = value.includes("|") ? /\s*\|\s*/u : /\s*,\s*/u;
  const parts = value.split(delimiter).map(cleanLine).filter(Boolean);
  return parts.length <= 1 ? parts : formatDelimitedParts(parts);
}

function formatDelimitedParts(source: readonly string[]): readonly string[] {
  const parts = source.map(cleanLine).filter(Boolean);
  if (parts.length === 0) return [];
  return mergePostalLines(parts);
}

function mergePostalLines(source: readonly string[]): readonly string[] {
  const result = [...source];
  const country = COUNTRY.test(result.at(-1) ?? "") ? result.pop() : undefined;
  const last = result.at(-1) ?? "";
  const previous = result.at(-2) ?? "";
  const beforePrevious = result.at(-3) ?? "";

  if (
    POSTAL_ONLY.test(last) &&
    TERRITORY_ONLY.test(previous) &&
    beforePrevious
  ) {
    result.splice(-3, 3, `${beforePrevious}, ${previous} ${last}`);
  } else if (POSTAL_END.test(last) && previous && !last.includes(",")) {
    result.splice(-2, 2, `${previous}, ${last}`);
  }
  if (country !== undefined) result.push(country);
  return result;
}

function headerMap(
  row: readonly string[],
): ReadonlyMap<AddressField, number> | null {
  const result = new Map<AddressField, number>();
  row.forEach((rawHeader, index) => {
    const header = rawHeader.trim().toLocaleLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
      AddressField,
      ReadonlySet<string>,
    ][]) {
      if (aliases.has(header)) result.set(field, index);
    }
  });
  return result.has("addressOne") && result.has("city") ? result : null;
}

function rowFromHeaders(
  row: readonly string[],
  headers: ReadonlyMap<AddressField, number>,
): readonly string[] {
  const value = (field: AddressField) =>
    cleanLine(row[headers.get(field) ?? -1] ?? "");
  const city = value("city");
  const territory = value("territory");
  const postalCode = value("postalCode");
  const locality =
    city && territory
      ? `${city}, ${territory}${postalCode ? ` ${postalCode}` : ""}`
      : [city, territory, postalCode].filter(Boolean).join(" ");
  return [
    value("name"),
    value("addressOne"),
    value("addressTwo"),
    locality,
    value("country"),
  ].filter(Boolean);
}

function parseCsvRow(value: string): readonly string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      result.push(cleanLine(current));
      current = "";
    } else {
      current += character;
    }
  }
  result.push(cleanLine(current));
  return result;
}

function cleanLine(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s+/u, "")
    .replace(/\s+/gu, " ");
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}
