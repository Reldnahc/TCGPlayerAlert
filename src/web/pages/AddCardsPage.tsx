import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AdditionPreview,
  CatalogProduct,
  CatalogSearch,
  MarketplaceListingQuote,
  MarketplacePublicationPreview,
} from "../contracts.js";
import { uiApi } from "../api.js";
import {
  Button,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Spinner,
  Toolbar,
} from "../components/ui.js";
import { useSettings } from "../state/SettingsContext.js";
import { useMarketplaceConnections } from "../state/MarketplaceConnectionsContext.js";
import { useToast } from "../state/ToastContext.js";
import { errorMessage, money } from "../utils.js";

const PROFILE_KEY = "tcgplayer-alert.merchandise-profile";
const CATALOG_SOURCE_KEY = "seller-tools.add-card-catalog-source";
const LISTING_DESTINATION_KEY = "seller-tools.add-card-listing-destination";
const CONDITIONS = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
  "Unopened",
] as const;
const MATCH_LABELS = {
  exact: "Exact name",
  variant: "Name variants",
  related: "Related results",
} as const;

interface LoadedSearch extends CatalogSearch {
  readonly query: string;
  readonly productLine: string;
  readonly setName: string;
}

interface RowSelection {
  readonly condition: string;
  readonly printing: "Normal" | "Foil";
}

interface RowMessage {
  readonly tone: "success" | "warning" | "danger";
  readonly text: string;
  readonly alternateLanguage?: string;
  readonly quantity?: number;
}

interface RowPrice {
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly proposedPrice?: number;
  readonly language?: string;
  readonly reason?: string;
  readonly candidates?: readonly ListingCandidate[];
  readonly selectedConnectionId?: string;
}

interface ListingCandidate {
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly price: number;
  readonly source: "pricing-rules" | "market-low" | "market";
  readonly language?: string;
  readonly additionPreview?: AdditionPreview;
  readonly listingQuote?: MarketplaceListingQuote;
}

interface PublicationDraft {
  readonly productId: number;
  readonly localInventoryId: string;
  readonly displayName: string;
  readonly onHand: number;
}

function rank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function mergeProducts(
  current: LoadedSearch | null,
  incoming: CatalogSearch,
  append: boolean,
) {
  const products =
    append && current !== null
      ? [...current.products, ...incoming.products]
      : [...incoming.products];
  const order = { exact: 0, variant: 1, related: 2 } as const;
  return [
    ...new Map(
      products.map((product) => [product.productId, product]),
    ).values(),
  ].sort(
    (left, right) =>
      order[left.matchKind] - order[right.matchKind] ||
      rank(left.matchRank, right.matchRank) ||
      left.productName.localeCompare(right.productName) ||
      left.setName.localeCompare(right.setName) ||
      left.productId - right.productId,
  );
}

export function AddCardsPage() {
  const { settings } = useSettings();
  const { snapshot: marketplaceConnections } = useMarketplaceConnections();
  const toast = useToast();
  const [profileId, setProfileId] = useState(
    () => window.localStorage.getItem(PROFILE_KEY) ?? "",
  );
  const catalogConnections =
    marketplaceConnections?.connections.filter(
      (connection) =>
        connection.enabled &&
        connection.supportedFacets.includes("catalog-search"),
    ) ?? [];
  const listingConnections =
    marketplaceConnections?.connections.filter(
      (connection) =>
        connection.enabled &&
        (connection.supportedFacets.includes("inventory-additions") ||
          connection.supportedFacets.includes("inventory-publisher")),
    ) ?? [];
  const automaticListingAvailable =
    listingConnections.some((connection) =>
      connection.supportedFacets.includes("inventory-additions"),
    ) &&
    listingConnections.some(
      (connection) =>
        connection.supportedFacets.includes("inventory-publisher") &&
        connection.supportedFacets.includes("listing-quotes"),
    );
  const [catalogSourceId, setCatalogSourceId] = useState(
    () => window.localStorage.getItem(CATALOG_SOURCE_KEY) ?? "",
  );
  const [listingDestinationId, setListingDestinationId] = useState(
    () => window.localStorage.getItem(LISTING_DESTINATION_KEY) ?? "",
  );
  const automaticListing =
    automaticListingAvailable &&
    (listingDestinationId === "auto" || listingDestinationId === "");
  const listingDestination =
    listingDestinationId === "local" || automaticListing
      ? undefined
      : (listingConnections.find(
          (connection) =>
            connection.descriptor.connectionId === listingDestinationId,
        ) ??
        listingConnections.find((connection) =>
          connection.supportedFacets.includes("inventory-additions"),
        ) ??
        listingConnections[0]);
  const catalogSource =
    catalogConnections.find(
      (connection) => connection.descriptor.connectionId === catalogSourceId,
    ) ??
    catalogConnections.find(
      (connection) =>
        connection.health.state === "connected" ||
        connection.health.state === "degraded",
    ) ??
    catalogConnections[0];

  function selectListingDestination(destination: string) {
    setListingDestinationId(destination);
    setRowPrices({});
    window.localStorage.setItem(LISTING_DESTINATION_KEY, destination);
  }
  const [query, setQuery] = useState("");
  const [productLine, setProductLine] = useState("");
  const [setName, setSetName] = useState("");
  const [search, setSearch] = useState<LoadedSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [selections, setSelections] = useState<
    Readonly<Record<number, RowSelection>>
  >({});
  const [rowMessages, setRowMessages] = useState<
    Readonly<Record<number, RowMessage>>
  >({});
  const [rowPrices, setRowPrices] = useState<
    Readonly<Record<number, RowPrice>>
  >({});
  const [adding, setAdding] = useState<ReadonlySet<number>>(new Set());
  const [details, setDetails] = useState<
    Readonly<Record<number, CatalogProduct>>
  >({});
  const [customProductId, setCustomProductId] = useState<number | null>(null);
  const [customQuantity, setCustomQuantity] = useState("5");
  const [publicationDraft, setPublicationDraft] =
    useState<PublicationDraft | null>(null);
  const [publicationConnectionId, setPublicationConnectionId] = useState("");
  const [publicationQuantity, setPublicationQuantity] = useState("1");
  const [publicationPrice, setPublicationPrice] = useState("");
  const [publicationPreview, setPublicationPreview] =
    useState<MarketplacePublicationPreview | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publicationError, setPublicationError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const detailPromises = useRef(new Map<number, Promise<CatalogProduct>>());
  const priceRequestSerial = useRef(0);
  const activePriceRequests = useRef(new Map<number, number>());

  const profiles = settings?.merchandiseProfiles ?? [];
  const activeProfile =
    profiles.find((profile) => profile.id === profileId) ??
    profiles.find(
      (profile) => profile.id === settings?.defaultMerchandiseProfileId,
    ) ??
    profiles[0];
  const activePricingProfile = settings?.repricingProfiles.find(
    (profile) => profile.id === activeProfile?.pricingProfileId,
  );

  async function listingCandidates(
    productId: number,
    productConditionId: number,
    quantity: number,
  ): Promise<readonly ListingCandidate[]> {
    const destinations = automaticListing
      ? listingConnections
      : listingDestination === undefined
        ? []
        : [listingDestination];
    const requests = destinations.flatMap((destination) => {
      if (destination.supportedFacets.includes("inventory-additions")) {
        if (activeProfile === undefined || activePricingProfile === undefined)
          return [];
        return [
          uiApi
            .previewAddition(destination.descriptor.connectionId, {
              productId,
              productConditionId,
              addQuantity: quantity,
              rules: {
                ...activePricingProfile,
                estimatedShippingPrice: activeProfile.estimatedShippingPrice,
              },
            })
            .then((preview): ListingCandidate | undefined =>
              preview.queueable && preview.proposedPrice !== undefined
                ? {
                    connectionId: destination.descriptor.connectionId,
                    connectionLabel: destination.descriptor.connectionLabel,
                    price: preview.proposedPrice,
                    source: "pricing-rules",
                    language: preview.sku.language,
                    additionPreview: preview,
                  }
                : undefined,
            )
            .catch(() => undefined),
        ];
      }
      if (
        destination.supportedFacets.includes("inventory-publisher") &&
        destination.supportedFacets.includes("listing-quotes")
      ) {
        return [
          uiApi
            .quoteMarketplaceListing({
              connectionId: destination.descriptor.connectionId,
              exactIdentity: {
                namespace: "tcgplayer.sku",
                value: String(productConditionId),
                precision: "exact-variant",
              },
            })
            .then((response): ListingCandidate | undefined => {
              const quote = response.quote;
              return quote === undefined
                ? undefined
                : {
                    connectionId: quote.connectionId,
                    connectionLabel: quote.connectionLabel,
                    price: quote.price.minorUnits / 100,
                    source: quote.source,
                    listingQuote: quote,
                  };
            })
            .catch(() => undefined),
        ];
      }
      return [];
    });
    return (await Promise.all(requests)).filter(
      (candidate): candidate is ListingCandidate => candidate !== undefined,
    );
  }

  function bestCandidate(
    candidates: readonly ListingCandidate[],
  ): ListingCandidate | undefined {
    return [...candidates].sort(
      (left, right) =>
        right.price - left.price ||
        left.connectionLabel.localeCompare(right.connectionLabel),
    )[0];
  }

  function selectedCatalogSourceId(): string {
    if (catalogSource === undefined) {
      throw new Error("Choose a catalog source before adding local stock.");
    }
    return catalogSource.descriptor.connectionId;
  }

  function getDetails(productId: number): Promise<CatalogProduct> {
    const cached = details[productId];
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = detailPromises.current.get(productId);
    if (existing !== undefined) return existing;
    const request = uiApi
      .catalogProduct(selectedCatalogSourceId(), productId)
      .then((result) => {
        setDetails((current) => ({ ...current, [productId]: result }));
        return result;
      })
      .finally(() => detailPromises.current.delete(productId));
    detailPromises.current.set(productId, request);
    return request;
  }

  function selectProfile(next: string) {
    setProfileId(next);
    window.localStorage.setItem(PROFILE_KEY, next);
    setSelections({});
    setRowMessages({});
  }

  async function runSearch(append = false) {
    const normalizedQuery =
      append && search !== null ? search.query : query.trim();
    const normalizedProductLine =
      append && search !== null ? search.productLine : productLine;
    const normalizedSet = append && search !== null ? search.setName : setName;
    if (normalizedQuery.length < 2 && !/^\d+$/u.test(normalizedQuery)) {
      setMessage(
        "Enter a product number or at least two characters of the card name.",
      );
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setMessage("");
    try {
      const result = await uiApi.catalogSearch(
        selectedCatalogSourceId(),
        normalizedQuery,
        normalizedProductLine,
        normalizedSet,
        append ? (search?.nextOffset ?? 0) : 0,
        controller.signal,
      );
      setSearch((current) => ({
        ...result,
        query: normalizedQuery,
        productLine: normalizedProductLine,
        setName: normalizedSet,
        products: mergeProducts(current, result, append),
        productLines:
          append && current !== null
            ? [
                ...new Map(
                  [...current.productLines, ...result.productLines].map(
                    (item) => [item.name, item],
                  ),
                ).values(),
              ]
            : result.productLines,
        sets:
          append && current !== null
            ? [
                ...new Map(
                  [...current.sets, ...result.sets].map((item) => [
                    item.name,
                    item,
                  ]),
                ).values(),
              ]
            : result.sets,
      }));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setMessage(errorMessage(cause, "Catalog search failed."));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSearching(false);
    }
  }

  function selectionFor(
    productId: number,
    productDetails?: CatalogProduct,
  ): RowSelection {
    const printings = new Set(productDetails?.skus.map((sku) => sku.printing));
    const locked =
      printings.has("Foil") && !printings.has("Normal")
        ? "Foil"
        : printings.has("Normal") && !printings.has("Foil")
          ? "Normal"
          : undefined;
    return (
      selections[productId] ?? {
        condition: activeProfile?.defaultCondition ?? "Near Mint",
        printing: locked ?? activeProfile?.defaultPrinting ?? "Normal",
      }
    );
  }

  function updateSelection(productId: number, patch: Partial<RowSelection>) {
    const nextSelection = {
      ...selectionFor(productId, details[productId]),
      ...patch,
    };
    setSelections((current) => ({
      ...current,
      [productId]: nextSelection,
    }));
    setRowMessages((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => Number(key) !== productId),
      ),
    );
    if (rowPrices[productId] !== undefined) {
      void previewPrice(productId, nextSelection);
    }
  }

  async function previewPrice(
    productId: number,
    requestedSelection?: RowSelection,
  ) {
    if (!automaticListing && listingDestination === undefined) return;
    const requestId = (priceRequestSerial.current += 1);
    activePriceRequests.current.set(productId, requestId);
    setRowPrices((current) => ({
      ...current,
      [productId]: { status: "loading" },
    }));
    try {
      const product = await getDetails(productId);
      if (activePriceRequests.current.get(productId) !== requestId) return;
      const selection = requestedSelection ?? selectionFor(productId, product);
      const matching = product.skus.filter(
        (sku) =>
          sku.condition === selection.condition &&
          sku.printing === selection.printing,
      );
      const preferredLanguage = activeProfile?.language ?? "English";
      const preferred = matching.find(
        (candidate) => candidate.language === preferredLanguage,
      );
      const languages = [
        ...new Set(matching.map((candidate) => candidate.language)),
      ].sort();
      const sku =
        preferred ??
        (languages.length === 1
          ? matching.find((candidate) => candidate.language === languages[0])
          : undefined);
      if (sku === undefined) {
        const reason =
          languages.length === 0
            ? `No ${selection.condition} ${selection.printing.toLocaleLowerCase()} SKU exists.`
            : `No ${preferredLanguage} SKU exists. Available languages: ${languages.join(", ")}.`;
        setRowPrices((current) => ({
          ...current,
          [productId]: { status: "unavailable", reason },
        }));
        return;
      }
      const candidates = await listingCandidates(
        productId,
        sku.productConditionId,
        1,
      );
      if (activePriceRequests.current.get(productId) !== requestId) return;
      const selected = bestCandidate(candidates);
      setRowPrices((current) => ({
        ...current,
        [productId]:
          selected !== undefined
            ? {
                status: "ready",
                proposedPrice: selected.price,
                ...(selected.language === undefined
                  ? {}
                  : { language: selected.language }),
                candidates,
                selectedConnectionId: selected.connectionId,
              }
            : {
                status: "unavailable",
                reason: "No destination returned a comparable exact-SKU price.",
              },
      }));
    } catch (cause) {
      if (activePriceRequests.current.get(productId) !== requestId) return;
      setRowPrices((current) => ({
        ...current,
        [productId]: {
          status: "error",
          reason: errorMessage(cause, "Listing price could not be loaded."),
        },
      }));
    }
  }

  async function addProduct(
    productId: number,
    quantity: number,
    approvedLanguage?: string,
  ) {
    if (adding.has(productId)) return;
    let addedLocally = false;
    setAdding((current) => new Set(current).add(productId));
    setRowMessages((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => Number(key) !== productId),
      ),
    );
    try {
      const product = await getDetails(productId);
      const selection = selectionFor(productId, product);
      const matching = product.skus.filter(
        (sku) =>
          sku.condition === selection.condition &&
          sku.printing === selection.printing,
      );
      const preferredLanguage = activeProfile?.language ?? "English";
      let sku = matching.find(
        (candidate) => candidate.language === preferredLanguage,
      );
      if (sku === undefined) {
        const languages = [
          ...new Set(matching.map((candidate) => candidate.language)),
        ].sort();
        if (languages.length === 0) {
          throw new Error(
            `No ${selection.condition} ${selection.printing.toLocaleLowerCase()} SKU exists.`,
          );
        }
        if (languages.length > 1) {
          throw new Error(
            `No ${preferredLanguage} SKU exists. Available languages: ${languages.join(", ")}.`,
          );
        }
        const alternateLanguage = languages[0];
        if (alternateLanguage === undefined) {
          throw new Error("The matching SKU has no language.");
        }
        if (approvedLanguage !== alternateLanguage) {
          setRowMessages((current) => ({
            ...current,
            [productId]: {
              tone: "warning",
              text: `No ${preferredLanguage} SKU exists for this selection. The only matching language is ${alternateLanguage}.`,
              alternateLanguage,
              quantity,
            },
          }));
          return;
        }
        sku = matching.find(
          (candidate) => candidate.language === alternateLanguage,
        );
      }
      if (sku === undefined) {
        throw new Error("The matching exact SKU could not be selected.");
      }
      const result = await uiApi.addLocalInventory(selectedCatalogSourceId(), {
        productId,
        productConditionId: sku.productConditionId,
        quantity,
      });
      addedLocally = true;
      let text = `Added ${String(quantity)} to local stock. On hand: ${String(result.item.onHand)}.`;
      const candidates =
        automaticListing || listingDestination !== undefined
          ? await listingCandidates(productId, sku.productConditionId, quantity)
          : [];
      const selectedCandidate = bestCandidate(candidates);
      const destination = automaticListing
        ? listingConnections.find(
            (connection) =>
              connection.descriptor.connectionId ===
              selectedCandidate?.connectionId,
          )
        : listingDestination;
      if (
        (automaticListing || destination !== undefined) &&
        selectedCandidate === undefined
      ) {
        const unavailableDestination = automaticListing
          ? "neither marketplace"
          : (destination?.descriptor.connectionLabel ?? "the marketplace");
        text = `Added locally, but ${unavailableDestination} returned a comparable exact-SKU price.`;
        setRowMessages((current) => ({
          ...current,
          [productId]: { tone: "warning", text },
        }));
        toast.show(text, "warning");
        return;
      }
      if (destination?.supportedFacets.includes("inventory-additions")) {
        const preview = selectedCandidate?.additionPreview;
        if (preview === undefined) {
          throw new Error("The TCGplayer listing preview is unavailable.");
        }
        if (!preview.queueable) {
          text = `Added locally, but ${destination.descriptor.connectionLabel} was not queued: ${preview.reason}`;
          setRowMessages((current) => ({
            ...current,
            [productId]: { tone: "warning", text },
          }));
          toast.show(text, "warning");
          return;
        }
        await uiApi.queueAddition(
          destination.descriptor.connectionId,
          preview.id,
        );
        text = `Added locally and queued +${String(quantity)} on ${destination.descriptor.connectionLabel}${preview.proposedPrice === undefined ? "" : ` at ${money(preview.proposedPrice)}`}.`;
      } else if (destination?.supportedFacets.includes("inventory-publisher")) {
        text = automaticListing
          ? `Added ${String(quantity)} to local stock. Auto selected ${destination.descriptor.connectionLabel} at ${money(selectedCandidate?.price ?? 0)}. Preparing the listing review.`
          : `Added ${String(quantity)} to local stock. Preparing the ${destination.descriptor.connectionLabel} listing.`;
      }
      setRowMessages((current) => ({
        ...current,
        [productId]: { tone: "success", text },
      }));
      toast.show(text, "success");
      if (destination?.supportedFacets.includes("inventory-publisher")) {
        const draft: PublicationDraft = {
          productId,
          localInventoryId: result.item.localInventoryId,
          displayName: product.productName,
          onHand: result.item.onHand,
        };
        const connectionId = destination.descriptor.connectionId;
        const price = selectedCandidate?.price.toFixed(2) ?? "";
        setPublicationDraft(draft);
        setPublicationConnectionId(connectionId);
        setPublicationQuantity(String(result.item.onHand));
        setPublicationPrice(price);
        setPublicationPreview(null);
        setPublicationError("");
        await preparePublication(
          draft,
          connectionId,
          result.item.onHand,
          price,
        );
      }
    } catch (cause) {
      setRowMessages((current) => ({
        ...current,
        [productId]: {
          tone: "danger",
          text: errorMessage(
            cause,
            addedLocally
              ? "The card was added locally, but the marketplace listing failed."
              : "The card was not added to local stock.",
          ),
        },
      }));
    } finally {
      setAdding((current) => {
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
    }
  }

  async function preparePublication(
    draft: PublicationDraft,
    connectionId: string,
    quantity: number,
    price: string,
  ) {
    const minorUnits = Math.round(Number(price) * 100);
    if (
      connectionId === "" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > draft.onHand ||
      !Number.isSafeInteger(minorUnits) ||
      minorUnits < 1
    ) {
      setPublicationError("Choose a destination, valid quantity, and price.");
      return;
    }
    setPublishing(true);
    setPublicationError("");
    try {
      const result = await uiApi.previewMarketplacePublication({
        connectionId,
        localInventoryId: draft.localInventoryId,
        quantity,
        price: { currency: "USD", minorUnits },
      });
      setPublicationPreview(result.preview);
    } catch (cause) {
      setPublicationError(
        errorMessage(cause, "The ManaPool listing could not be reviewed."),
      );
    } finally {
      setPublishing(false);
    }
  }

  function reviewPublication() {
    if (publicationDraft === null) return Promise.resolve();
    return preparePublication(
      publicationDraft,
      publicationConnectionId,
      Number(publicationQuantity),
      publicationPrice,
    );
  }

  async function confirmPublication() {
    if (publicationPreview === null) return;
    setPublishing(true);
    setPublicationError("");
    try {
      const result = await uiApi.publishMarketplacePublication(
        publicationPreview.id,
      );
      if (result.job.status !== "submitted") {
        throw new Error(
          "ManaPool returned an uncertain result. Refresh inventory before trying again.",
        );
      }
      const text = `Published ${String(result.job.quantity)} on ${publicationPreview.connectionLabel} at ${money(result.job.price.minorUnits / 100)}.`;
      toast.show(text, "success");
      setRowMessages((current) => ({
        ...current,
        [publicationDraft?.productId ?? 0]: { tone: "success", text },
      }));
      setPublicationDraft(null);
      setPublicationPreview(null);
    } catch (cause) {
      setPublicationError(
        errorMessage(cause, "The ManaPool listing was not published."),
      );
    } finally {
      setPublishing(false);
    }
  }

  const groups = useMemo(
    () =>
      Object.entries(MATCH_LABELS)
        .map(([kind, label]) => ({
          kind,
          label,
          products:
            search?.products.filter((product) => product.matchKind === kind) ??
            [],
        }))
        .filter((group) => group.products.length > 0),
    [search],
  );

  return (
    <main class="page page--fixed">
      <PageHeader
        title="Add cards"
        description="Add physical stock and optionally list it for sale"
      />
      <div class="page-body add-cards-layout">
        <Toolbar>
          <Field label="Catalog source" class="profile-field">
            <select
              value={catalogSource?.descriptor.connectionId ?? ""}
              disabled={catalogConnections.length <= 1}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setCatalogSourceId(next);
                window.localStorage.setItem(CATALOG_SOURCE_KEY, next);
                setSearch(null);
                setRowMessages({});
              }}
            >
              {catalogConnections.map((connection) => (
                <option
                  key={connection.descriptor.connectionId}
                  value={connection.descriptor.connectionId}
                >
                  {connection.descriptor.connectionLabel}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Card defaults" class="profile-field">
            <select
              value={activeProfile?.id ?? ""}
              onChange={(event) => selectProfile(event.currentTarget.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <span class="profile-summary">
            {activeProfile === undefined
              ? "English · Near Mint · Normal"
              : `${activeProfile.language} · ${activeProfile.defaultCondition} · ${activeProfile.defaultPrinting}`}
          </span>
          <div class="field listing-destination-field">
            <span class="field__label">List on</span>
            <div
              class="segmented listing-destination-options"
              role="group"
              aria-label="List on"
            >
              {automaticListingAvailable ? (
                <button
                  type="button"
                  aria-pressed={automaticListing}
                  onClick={() => selectListingDestination("auto")}
                >
                  Auto · best price
                </button>
              ) : null}
              {listingConnections.map((connection) => (
                <button
                  key={connection.descriptor.connectionId}
                  type="button"
                  aria-pressed={
                    !automaticListing &&
                    listingDestination?.descriptor.connectionId ===
                      connection.descriptor.connectionId
                  }
                  onClick={() =>
                    selectListingDestination(connection.descriptor.connectionId)
                  }
                >
                  {connection.descriptor.connectionLabel}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={
                  !automaticListing && listingDestinationId === "local"
                }
                onClick={() => selectListingDestination("local")}
              >
                Local only
              </button>
            </div>
          </div>
        </Toolbar>
        <Notice tone="info">
          {automaticListing
            ? "Auto compares the exact SKU on TCGplayer and ManaPool, then lists on the marketplace with the higher price. "
            : "Choose where the card should be listed, then click a quantity. "}
          Local inventory is updated automatically as the physical stock ledger.
        </Notice>
        <form
          class="catalog-searchbar"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <Field label="Card name or product #" class="catalog-query">
            <input
              type="search"
              value={query}
              placeholder="Search catalog"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </Field>
          <Field label="Product line">
            <select
              value={productLine}
              onChange={(event) => {
                setProductLine(event.currentTarget.value);
                setSetName("");
              }}
            >
              <option value="">All product lines</option>
              {[...(search?.productLines ?? [])]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} ({item.count})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Set">
            <select
              value={setName}
              disabled={(search?.sets.length ?? 0) === 0}
              onChange={(event) => setSetName(event.currentTarget.value)}
            >
              <option value="">All sets</option>
              {[...(search?.sets ?? [])]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} ({item.count})
                  </option>
                ))}
            </select>
          </Field>
          <Button tone="primary" icon="search" busy={searching} type="submit">
            Search
          </Button>
        </form>
        {message === "" ? null : <Notice tone="danger">{message}</Notice>}
        <div class="catalog-results" id="catalog-results">
          {search === null ? (
            <EmptyState
              title="Search the catalog"
              detail="Choose an exact condition and printing, then add physical stock locally."
            />
          ) : groups.length === 0 ? (
            <EmptyState
              title="No catalog matches"
              detail="Try a broader name, product line, or set."
            />
          ) : (
            groups.map((group) => (
              <section class="catalog-group" key={group.kind}>
                <header>
                  <strong>{group.label}</strong>
                  <span>{group.products.length} loaded</span>
                </header>
                <div class="catalog-list">
                  {group.products.map((product) => (
                    <CatalogRow
                      key={product.productId}
                      product={product}
                      details={details[product.productId]}
                      selection={selectionFor(
                        product.productId,
                        details[product.productId],
                      )}
                      message={rowMessages[product.productId]}
                      price={rowPrices[product.productId]}
                      busy={adding.has(product.productId)}
                      onVisible={(productId) => {
                        void getDetails(productId).catch(() => undefined);
                      }}
                      onSelection={(patch) =>
                        updateSelection(product.productId, patch)
                      }
                      onPreviewPrice={() =>
                        void previewPrice(product.productId)
                      }
                      canPreviewPrice={
                        automaticListing ||
                        listingDestination?.supportedFacets.includes(
                          "inventory-additions",
                        ) === true ||
                        listingDestination?.supportedFacets.includes(
                          "listing-quotes",
                        ) === true
                      }
                      onAdd={(quantity, language) =>
                        void addProduct(product.productId, quantity, language)
                      }
                      onCustom={() => {
                        setCustomProductId(product.productId);
                        setCustomQuantity("5");
                      }}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
          {search?.hasMore ? (
            <div class="load-more">
              <span>
                {search.products.length} of {search.totalProducts} loaded
              </span>
              <Button busy={searching} onClick={() => void runSearch(true)}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {customProductId === null ? null : (
        <div
          class="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCustomProductId(null);
          }}
        >
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quantity-title"
          >
            <div class="dialog__header">
              <h2 id="quantity-title">Add local quantity</h2>
            </div>
            <div class="dialog__body">
              <Field label="Quantity">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={customQuantity}
                  autoFocus
                  onInput={(event) =>
                    setCustomQuantity(event.currentTarget.value)
                  }
                />
              </Field>
            </div>
            <div class="dialog__footer">
              <Button tone="quiet" onClick={() => setCustomProductId(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => {
                  const quantity = Number(customQuantity);
                  if (Number.isInteger(quantity) && quantity > 0) {
                    void addProduct(customProductId, quantity);
                    setCustomProductId(null);
                  }
                }}
              >
                Add locally
              </Button>
            </div>
          </div>
        </div>
      )}
      {publicationDraft === null ? null : (
        <div class="dialog-backdrop" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publication-title"
          >
            <div class="dialog__header">
              <h2 id="publication-title">List on ManaPool</h2>
            </div>
            <div class="dialog__body">
              <p>{publicationDraft.displayName}</p>
              {publicationPreview === null ? (
                <>
                  {publishing ? (
                    <Spinner label="Preparing ManaPool listing" />
                  ) : null}
                  <Field
                    label={`Live quantity (local on hand: ${String(publicationDraft.onHand)})`}
                  >
                    <input
                      type="number"
                      min="1"
                      max={publicationDraft.onHand}
                      value={publicationQuantity}
                      onInput={(event) =>
                        setPublicationQuantity(event.currentTarget.value)
                      }
                    />
                  </Field>
                  <Field label="Price (USD)">
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={publicationPrice}
                      onInput={(event) =>
                        setPublicationPrice(event.currentTarget.value)
                      }
                    />
                  </Field>
                </>
              ) : (
                <Notice tone="warning">
                  Publish {publicationPreview.quantity} at{" "}
                  {money(publicationPreview.price.minorUnits / 100)} on{" "}
                  {publicationPreview.connectionLabel}.{" "}
                  {publicationPreview.currentListing === undefined
                    ? "This creates a new live listing."
                    : `This replaces the current live quantity ${String(publicationPreview.currentListing.quantity)} and price ${money((publicationPreview.currentListing.price?.minorUnits ?? 0) / 100)}.`}
                </Notice>
              )}
              {publicationError === "" ? null : (
                <Notice tone="danger">{publicationError}</Notice>
              )}
            </div>
            <div class="dialog__footer">
              <Button
                tone="quiet"
                disabled={publishing}
                onClick={() => {
                  setPublicationDraft(null);
                  setPublicationPreview(null);
                }}
              >
                Cancel
              </Button>
              {publicationPreview === null ? (
                <Button
                  tone="primary"
                  busy={publishing}
                  onClick={() => void reviewPublication()}
                >
                  Review listing
                </Button>
              ) : (
                <Button
                  tone="primary"
                  busy={publishing}
                  onClick={() => void confirmPublication()}
                >
                  Publish now
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function CatalogRow({
  product,
  details,
  selection,
  message,
  price,
  busy,
  onVisible,
  onSelection,
  onPreviewPrice,
  canPreviewPrice,
  onAdd,
  onCustom,
}: {
  readonly product: CatalogSearch["products"][number];
  readonly details: CatalogProduct | undefined;
  readonly selection: RowSelection;
  readonly message: RowMessage | undefined;
  readonly price: RowPrice | undefined;
  readonly busy: boolean;
  readonly onVisible: (productId: number) => void;
  readonly onSelection: (patch: Partial<RowSelection>) => void;
  readonly onPreviewPrice: () => void;
  readonly canPreviewPrice: boolean;
  readonly onAdd: (quantity: number, language?: string) => void;
  readonly onCustom: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = element.current;
    if (target === null || details !== undefined) return;
    if (!("IntersectionObserver" in window)) {
      onVisible(product.productId);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisible(product.productId);
          observer.disconnect();
        }
      },
      {
        root: document.querySelector("#catalog-results"),
        rootMargin: "180px 0px",
      },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [details, onVisible, product.productId]);
  const printings = new Set(details?.skus.map((sku) => sku.printing));
  const foilOnly = printings.has("Foil") && !printings.has("Normal");
  const normalOnly = printings.has("Normal") && !printings.has("Foil");
  const printingPending = details === undefined;
  return (
    <div
      ref={element}
      class={`catalog-row${selection.printing === "Foil" ? " is-foil" : ""}`}
    >
      <div class="catalog-art">
        <img
          src={product.imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>
      <div class="catalog-copy">
        <strong>{product.productName}</strong>
        <span>
          {product.productLineName} · {product.setName} · #{product.productId}
        </span>
        <small>
          {product.cardNumber === "" ? "" : `Card ${product.cardNumber} · `}
          {product.rarityName || "No rarity"} · market{" "}
          {money(product.marketPrice)}
        </small>
      </div>
      <div class="catalog-controls">
        {canPreviewPrice ? (
          <button
            type="button"
            class={`catalog-price${price?.status === "ready" ? " is-ready" : ""}`}
            disabled={busy || price?.status === "loading"}
            aria-label={`${price === undefined ? "Show" : "Refresh"} listing price for ${product.productName}`}
            title={price?.reason ?? "Price the currently selected SKU"}
            onClick={onPreviewPrice}
          >
            <span>Listing price</span>
            {price === undefined ? (
              <strong>Show price</strong>
            ) : price.status === "loading" ? (
              <strong>Pricing...</strong>
            ) : price.status === "ready" &&
              price.proposedPrice !== undefined ? (
              <>
                <strong>{money(price.proposedPrice)}</strong>
                {price.candidates !== undefined &&
                price.candidates.length > 1 ? (
                  <small>
                    {price.candidates.map((candidate, index) => (
                      <span key={candidate.connectionId}>
                        {index === 0 ? "" : " · "}
                        {candidate.connectionLabel} {money(candidate.price)}
                        {candidate.connectionId === price.selectedConnectionId
                          ? " ✓"
                          : ""}
                      </span>
                    ))}
                  </small>
                ) : (
                  <small>
                    {price.candidates?.[0]?.connectionLabel ?? price.language}
                  </small>
                )}
              </>
            ) : price.status === "unavailable" ? (
              <strong>Unavailable</strong>
            ) : (
              <strong>Retry</strong>
            )}
          </button>
        ) : null}
        <select
          aria-label={`Condition for ${product.productName}`}
          value={selection.condition}
          disabled={busy}
          onChange={(event) =>
            onSelection({ condition: event.currentTarget.value })
          }
        >
          {CONDITIONS.map((condition) => (
            <option key={condition}>{condition}</option>
          ))}
        </select>
        <Button
          class="foil-button"
          tone={selection.printing === "Foil" ? "primary" : "secondary"}
          disabled={busy || printingPending || foilOnly || normalOnly}
          title={
            foilOnly
              ? "This product is foil only"
              : normalOnly
                ? "This product has no foil SKU"
                : printingPending
                  ? "Checking printings"
                  : "Toggle foil"
          }
          onClick={() =>
            onSelection({
              printing: selection.printing === "Foil" ? "Normal" : "Foil",
            })
          }
        >
          Foil
        </Button>
        <div class="quantity-buttons">
          {[1, 2, 3, 4].map((quantity) => (
            <button
              key={quantity}
              type="button"
              disabled={busy}
              onClick={() => onAdd(quantity)}
            >
              +{quantity}
            </button>
          ))}
          <button type="button" disabled={busy} onClick={onCustom}>
            +X
          </button>
        </div>
      </div>
      {busy ? (
        <div class="catalog-row__message">
          <Spinner label="Adding to local stock" />
        </div>
      ) : message === undefined ? null : (
        <div class={`catalog-row__message notice notice--${message.tone}`}>
          {message.text}
          {message.alternateLanguage === undefined ||
          message.quantity === undefined ? null : (
            <span class="inline-actions">
              <Button
                tone="primary"
                onClick={() =>
                  onAdd(message.quantity ?? 1, message.alternateLanguage)
                }
              >
                Add {message.alternateLanguage} locally
              </Button>
              <Button tone="quiet" onClick={() => onSelection({})}>
                Cancel
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
