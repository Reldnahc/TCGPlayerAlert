import type { CatalogIdentity } from "./contracts.js";

type CatalogAttributeValue = string | readonly string[];

export type CatalogAttributes = Readonly<Record<string, CatalogAttributeValue>>;

export interface CatalogVariant {
  readonly language: string;
  readonly condition: string;
  readonly finish: string;
}

export type CatalogIdentityMatchTier =
  "provider-exact" | "product-variant" | "printing-variant" | "natural-variant";

const DERIVED_IDENTITY_NAMESPACE = {
  tcgplayer: "normalized.tcgplayer-variant.v1",
  scryfall: "normalized.scryfall-variant.v1",
  mtgjson: "normalized.mtgjson-variant.v1",
  natural: "normalized.mtg-natural-variant.v1",
} as const;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  en: "en",
  english: "en",
  ja: "ja",
  japanese: "ja",
  fr: "fr",
  french: "fr",
  de: "de",
  german: "de",
  es: "es",
  spanish: "es",
  it: "it",
  italian: "it",
  pt: "pt",
  portuguese: "pt",
  ko: "ko",
  korean: "ko",
  ru: "ru",
  russian: "ru",
  zhs: "zhs",
  zhcn: "zhs",
  simplifiedchinese: "zhs",
  zht: "zht",
  zhtw: "zht",
  traditionalchinese: "zht",
  ph: "ph",
  phyrexian: "ph",
};

const CONDITION_ALIASES: Readonly<Record<string, string>> = {
  nm: "near-mint",
  nearmint: "near-mint",
  lp: "lightly-played",
  lightlyplayed: "lightly-played",
  mp: "moderately-played",
  moderatelyplayed: "moderately-played",
  hp: "heavily-played",
  heavilyplayed: "heavily-played",
  dmg: "damaged",
  damaged: "damaged",
};

const FINISH_ALIASES: Readonly<Record<string, string>> = {
  nf: "nonfoil",
  normal: "nonfoil",
  nonfoil: "nonfoil",
  regular: "nonfoil",
  fo: "foil",
  foil: "foil",
  ef: "etched",
  etched: "etched",
  etchedfoil: "etched",
  foiletched: "etched",
};

/**
 * Returns every identity that is safe to treat as one physical sellable
 * variant. Provider exact IDs are retained first. Product/printing IDs are
 * promoted only when language, condition, and finish are all unambiguous.
 */
export function exactVariantCatalogIdentities(
  identities: readonly CatalogIdentity[],
  attributes: CatalogAttributes,
): readonly CatalogIdentity[] {
  const exact = identities.filter(
    (identity) => identity.precision === "exact-variant",
  );
  const variant = catalogVariant(attributes);
  if (variant === undefined) return exact;

  const derived: CatalogIdentity[] = [];
  for (const identity of identities) {
    if (identity.precision !== "product") continue;
    const namespace = derivedNamespace(identity.namespace);
    if (namespace === undefined) continue;
    const value = encodedIdentityValue([
      identity.value,
      variant.language,
      variant.condition,
      variant.finish,
    ]);
    if (value !== undefined) {
      derived.push({ namespace, value, precision: "exact-variant" });
    }
  }

  const natural = naturalMtgVariant(attributes, variant);
  if (natural !== undefined) derived.push(natural);
  return uniqueIdentities([...exact, ...derived]);
}

export function exactVariantCatalogIdentityKeys(
  identities: readonly CatalogIdentity[],
  attributes: CatalogAttributes,
): readonly string[] {
  return exactVariantCatalogIdentities(identities, attributes).map(
    catalogIdentityKey,
  );
}

/**
 * Compares two normalized records in priority order. A shared provider exact
 * identity always wins. If both records expose the same exact namespace with
 * different values, weaker fallbacks are not allowed to override it.
 */
export function catalogIdentityMatchTier(
  left: {
    readonly catalogIdentities: readonly CatalogIdentity[];
    readonly attributes: CatalogAttributes;
  },
  right: {
    readonly catalogIdentities: readonly CatalogIdentity[];
    readonly attributes: CatalogAttributes;
  },
): CatalogIdentityMatchTier | undefined {
  const leftDirect = directExactIdentities(left.catalogIdentities);
  const rightDirect = directExactIdentities(right.catalogIdentities);
  const rightDirectKeys = new Set(rightDirect.map(catalogIdentityKey));
  if (
    leftDirect.some((identity) =>
      rightDirectKeys.has(catalogIdentityKey(identity)),
    )
  ) {
    return "provider-exact";
  }
  if (hasConflictingExactNamespace(leftDirect, rightDirect)) return undefined;

  const leftDerived = exactVariantCatalogIdentities(
    left.catalogIdentities,
    left.attributes,
  ).filter(isDerivedIdentity);
  const rightDerivedKeys = new Set(
    exactVariantCatalogIdentities(right.catalogIdentities, right.attributes)
      .filter(isDerivedIdentity)
      .map(catalogIdentityKey),
  );
  const sharedNamespaces = new Set(
    leftDerived
      .filter((identity) => rightDerivedKeys.has(catalogIdentityKey(identity)))
      .map((identity) => identity.namespace),
  );
  if (sharedNamespaces.has(DERIVED_IDENTITY_NAMESPACE.tcgplayer)) {
    return "product-variant";
  }
  if (
    sharedNamespaces.has(DERIVED_IDENTITY_NAMESPACE.scryfall) ||
    sharedNamespaces.has(DERIVED_IDENTITY_NAMESPACE.mtgjson)
  ) {
    return "printing-variant";
  }
  return sharedNamespaces.has(DERIVED_IDENTITY_NAMESPACE.natural)
    ? "natural-variant"
    : undefined;
}

export function catalogIdentityMatchTierRank(
  tier: CatalogIdentityMatchTier,
): number {
  if (tier === "provider-exact") return 1;
  if (tier === "product-variant") return 2;
  if (tier === "printing-variant") return 3;
  return 4;
}

/**
 * Detects incompatible provider-exact values inside a proposed group. Multiple
 * values in one namespace are allowed only when at least one record explicitly
 * carries them together as aliases.
 */
export function catalogRecordsHaveConflictingProviderExactIdentities(
  records: readonly {
    readonly catalogIdentities: readonly CatalogIdentity[];
  }[],
): boolean {
  const valuesByNamespace = new Map<string, Set<string>>();
  const aliasesByNamespace = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    const recordValues = new Map<string, string[]>();
    for (const identity of directExactIdentities(record.catalogIdentities)) {
      const namespaceValues =
        valuesByNamespace.get(identity.namespace) ?? new Set<string>();
      namespaceValues.add(identity.value);
      valuesByNamespace.set(identity.namespace, namespaceValues);
      const current = recordValues.get(identity.namespace) ?? [];
      current.push(identity.value);
      recordValues.set(identity.namespace, current);
    }
    for (const [namespace, values] of recordValues) {
      const aliases =
        aliasesByNamespace.get(namespace) ?? new Map<string, Set<string>>();
      for (const value of values) {
        const connected = aliases.get(value) ?? new Set<string>();
        for (const alias of values) connected.add(alias);
        aliases.set(value, connected);
      }
      aliasesByNamespace.set(namespace, aliases);
    }
  }
  for (const [namespace, values] of valuesByNamespace) {
    const first = values.values().next().value;
    if (first === undefined) continue;
    const visited = new Set<string>();
    const pending = [first];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === undefined || visited.has(value)) continue;
      visited.add(value);
      pending.push(...(aliasesByNamespace.get(namespace)?.get(value) ?? []));
    }
    if (visited.size !== values.size) return true;
  }
  return false;
}

export function catalogIdentityKey(identity: CatalogIdentity): string {
  return JSON.stringify([
    identity.namespace,
    identity.value,
    identity.precision,
  ]);
}

export function catalogVariant(
  attributes: CatalogAttributes,
): CatalogVariant | undefined {
  const language = oneCanonicalAttribute(
    attributes,
    new Set(["lang", "language", "languageid"]),
    (value) => mappedToken(value, LANGUAGE_ALIASES),
  );
  const condition = oneCanonicalAttribute(
    attributes,
    new Set(["condition", "conditionid"]),
    (value) => mappedToken(value, CONDITION_ALIASES),
  );
  const finish = oneCanonicalAttribute(
    attributes,
    new Set(["finish", "finishid", "printing"]),
    (value) => mappedToken(value, FINISH_ALIASES),
  );
  if (
    language === undefined ||
    condition === undefined ||
    finish === undefined
  ) {
    return undefined;
  }
  return { language, condition, finish };
}

export function canonicalVariantAttribute(
  field: "language" | "condition" | "finish",
  value: string,
): string {
  if (field === "language") return mappedToken(value, LANGUAGE_ALIASES);
  if (field === "condition") return mappedToken(value, CONDITION_ALIASES);
  return mappedToken(value, FINISH_ALIASES);
}

function derivedNamespace(namespace: string): string | undefined {
  if (namespace === "tcgplayer.product") {
    return DERIVED_IDENTITY_NAMESPACE.tcgplayer;
  }
  if (namespace === "scryfall.printing") {
    return DERIVED_IDENTITY_NAMESPACE.scryfall;
  }
  if (namespace === "mtgjson.uuid") {
    return DERIVED_IDENTITY_NAMESPACE.mtgjson;
  }
  return undefined;
}

function directExactIdentities(
  identities: readonly CatalogIdentity[],
): readonly CatalogIdentity[] {
  return identities.filter(
    (identity) =>
      identity.precision === "exact-variant" && !isDerivedIdentity(identity),
  );
}

function isDerivedIdentity(identity: CatalogIdentity): boolean {
  return Object.values(DERIVED_IDENTITY_NAMESPACE).includes(
    identity.namespace as (typeof DERIVED_IDENTITY_NAMESPACE)[keyof typeof DERIVED_IDENTITY_NAMESPACE],
  );
}

function hasConflictingExactNamespace(
  left: readonly CatalogIdentity[],
  right: readonly CatalogIdentity[],
): boolean {
  const leftByNamespace = valuesByNamespace(left);
  const rightByNamespace = valuesByNamespace(right);
  for (const [namespace, leftValues] of leftByNamespace) {
    const rightValues = rightByNamespace.get(namespace);
    if (
      rightValues !== undefined &&
      ![...leftValues].some((value) => rightValues.has(value))
    ) {
      return true;
    }
  }
  return false;
}

function valuesByNamespace(
  identities: readonly CatalogIdentity[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const values = new Map<string, Set<string>>();
  for (const identity of identities) {
    const namespaceValues = values.get(identity.namespace) ?? new Set<string>();
    namespaceValues.add(identity.value);
    values.set(identity.namespace, namespaceValues);
  }
  return values;
}

function naturalMtgVariant(
  attributes: CatalogAttributes,
  variant: CatalogVariant,
): CatalogIdentity | undefined {
  const game = oneCanonicalAttribute(
    attributes,
    new Set(["game", "productline", "producttype"]),
    canonicalGame,
  );
  const setCode = oneCanonicalAttribute(
    attributes,
    new Set(["setcode"]),
    compactToken,
  );
  const collectorNumber = oneCanonicalAttribute(
    attributes,
    new Set(["collectornumber", "number"]),
    collectorToken,
  );
  const listStatus =
    setCode === "plst"
      ? "list"
      : oneCanonicalAttribute(
          attributes,
          new Set(["fromlist", "islist", "list", "listicon"]),
          canonicalListStatus,
        );
  if (
    game !== "mtg" ||
    setCode === undefined ||
    collectorNumber === undefined ||
    listStatus === undefined
  ) {
    return undefined;
  }
  const value = encodedIdentityValue([
    setCode,
    collectorNumber,
    listStatus,
    variant.language,
    variant.condition,
    variant.finish,
  ]);
  return value === undefined
    ? undefined
    : {
        namespace: DERIVED_IDENTITY_NAMESPACE.natural,
        value,
        precision: "exact-variant",
      };
}

function oneCanonicalAttribute(
  attributes: CatalogAttributes,
  names: ReadonlySet<string>,
  normalize: (value: string) => string,
): string | undefined {
  const values = new Set<string>();
  for (const [name, raw] of Object.entries(attributes)) {
    if (!names.has(compactToken(name))) continue;
    for (const value of typeof raw === "string" ? [raw] : raw) {
      const normalized = normalize(value);
      if (normalized.length > 0) values.add(normalized);
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
}

function mappedToken(
  value: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const token = compactToken(value);
  return aliases[token] ?? token;
}

function compactToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function collectorToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, "");
}

function canonicalGame(value: string): string {
  const token = compactToken(value);
  return new Set(["magic", "magicthegathering", "mtg", "mtgsingle"]).has(token)
    ? "mtg"
    : token;
}

function canonicalListStatus(value: string): string {
  const token = compactToken(value);
  if (
    new Set(["1", "list", "planeswalker", "thelist", "true", "yes"]).has(token)
  ) {
    return "list";
  }
  if (new Set(["0", "false", "no", "standard"]).has(token)) {
    return "standard";
  }
  return token;
}

function encodedIdentityValue(parts: readonly string[]): string | undefined {
  const value = JSON.stringify(parts);
  return Array.from(value).length <= 256 ? value : undefined;
}

function uniqueIdentities(
  identities: readonly CatalogIdentity[],
): readonly CatalogIdentity[] {
  return [
    ...new Map(
      identities.map((identity) => [catalogIdentityKey(identity), identity]),
    ).values(),
  ];
}
