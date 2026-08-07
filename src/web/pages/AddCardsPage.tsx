import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { CatalogProduct, CatalogSearch } from "../contracts.js";
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
import { useToast } from "../state/ToastContext.js";
import { errorMessage, money } from "../utils.js";

const PROFILE_KEY = "tcgplayer-alert.merchandise-profile";
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
  const toast = useToast();
  const [profileId, setProfileId] = useState(
    () => window.localStorage.getItem(PROFILE_KEY) ?? "",
  );
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
  const [adding, setAdding] = useState<ReadonlySet<number>>(new Set());
  const [details, setDetails] = useState<
    Readonly<Record<number, CatalogProduct>>
  >({});
  const [customProductId, setCustomProductId] = useState<number | null>(null);
  const [customQuantity, setCustomQuantity] = useState("5");
  const abortRef = useRef<AbortController | null>(null);
  const detailPromises = useRef(new Map<number, Promise<CatalogProduct>>());
  const detailQueue = useRef<number[]>([]);
  const detailQueued = useRef(new Set<number>());
  const detailFailed = useRef(new Set<number>());
  const detailActive = useRef(0);

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

  useEffect(() => {
    if (activeProfile === undefined || activeProfile.id === profileId) return;
    setProfileId(activeProfile.id);
  }, [activeProfile, profileId]);

  const getDetails = useCallback(
    (productId: number): Promise<CatalogProduct> => {
      const cached = details[productId];
      if (cached !== undefined) return Promise.resolve(cached);
      const existing = detailPromises.current.get(productId);
      if (existing !== undefined) return existing;
      const request = uiApi
        .catalogProduct(productId)
        .then((result) => {
          setDetails((current) => ({ ...current, [productId]: result }));
          detailFailed.current.delete(productId);
          return result;
        })
        .finally(() => detailPromises.current.delete(productId));
      detailPromises.current.set(productId, request);
      return request;
    },
    [details],
  );

  const drainDetailQueue = useCallback(() => {
    while (detailActive.current < 2 && detailQueue.current.length > 0) {
      const productId = detailQueue.current.shift();
      if (productId === undefined) break;
      detailQueued.current.delete(productId);
      if (
        details[productId] !== undefined ||
        detailPromises.current.has(productId)
      )
        continue;
      detailActive.current += 1;
      void getDetails(productId)
        .catch(() => detailFailed.current.add(productId))
        .finally(() => {
          detailActive.current -= 1;
          drainDetailQueue();
        });
    }
  }, [details, getDetails]);

  const queueDetails = useCallback(
    (productId: number) => {
      if (
        details[productId] !== undefined ||
        detailPromises.current.has(productId) ||
        detailFailed.current.has(productId) ||
        detailQueued.current.has(productId)
      )
        return;
      detailQueued.current.add(productId);
      detailQueue.current.push(productId);
      drainDetailQueue();
    },
    [details, drainDetailQueue],
  );

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
        "Enter a TCGplayer product number or at least two characters of the card name.",
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
    const saved = selections[productId];
    const printings = new Set(productDetails?.skus.map((sku) => sku.printing));
    const locked =
      printings.has("Foil") && !printings.has("Normal")
        ? "Foil"
        : printings.has("Normal") && !printings.has("Foil")
          ? "Normal"
          : undefined;
    return (
      saved ?? {
        condition: activeProfile?.defaultCondition ?? "Near Mint",
        printing: locked ?? activeProfile?.defaultPrinting ?? "Normal",
      }
    );
  }

  function updateSelection(productId: number, patch: Partial<RowSelection>) {
    setSelections((current) => ({
      ...current,
      [productId]: { ...selectionFor(productId, details[productId]), ...patch },
    }));
    setRowMessages((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => Number(key) !== productId),
      ),
    );
  }

  async function addProduct(
    productId: number,
    quantity: number,
    approvedLanguage?: string,
  ) {
    if (
      adding.has(productId) ||
      activeProfile === undefined ||
      activePricingProfile === undefined
    )
      return;
    setAdding((current) => new Set(current).add(productId));
    setRowMessages((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => Number(key) !== productId),
      ),
    );
    try {
      const productDetails = await getDetails(productId);
      const selection = selectionFor(productId, productDetails);
      const matching = productDetails.skus.filter(
        (sku) =>
          sku.condition === selection.condition &&
          sku.printing === selection.printing,
      );
      let sku = matching.find(
        (candidate) => candidate.language === activeProfile.language,
      );
      if (sku === undefined) {
        const languages = [
          ...new Set(matching.map((candidate) => candidate.language)),
        ].sort();
        if (languages.length !== 1) {
          throw new Error(
            `No ${activeProfile.language} ${selection.condition} ${selection.printing.toLocaleLowerCase()} SKU exists.${languages.length === 0 ? "" : ` Available languages: ${languages.join(", ")}.`}`,
          );
        }
        const alternateLanguage = languages[0];
        if (alternateLanguage === undefined)
          throw new Error("The matching SKU has no language.");
        if (approvedLanguage !== alternateLanguage) {
          setRowMessages((current) => ({
            ...current,
            [productId]: {
              tone: "warning",
              text: `No ${activeProfile.language} SKU exists for this selection. The only matching language is ${alternateLanguage}.`,
              alternateLanguage,
              quantity,
            },
          }));
          return;
        }
        sku = matching.find(
          (candidate) => candidate.language === approvedLanguage,
        );
      }
      if (sku === undefined)
        throw new Error("The matching SKU could not be selected.");
      const preview = await uiApi.previewAddition({
        productId,
        productConditionId: sku.productConditionId,
        addQuantity: quantity,
        rules: {
          ...activePricingProfile,
          estimatedShippingPrice: activeProfile.estimatedShippingPrice,
        },
      });
      if (!preview.queueable) {
        setRowMessages((current) => ({
          ...current,
          [productId]: { tone: "warning", text: preview.reason },
        }));
        return;
      }
      await uiApi.queueAddition(preview.id);
      const text = `Queued +${String(quantity)}${sku.language === activeProfile.language ? "" : ` as ${sku.language}`} at ${money(preview.proposedPrice)}.`;
      setRowMessages((current) => ({
        ...current,
        [productId]: { tone: "success", text },
      }));
      toast.show(text, "success");
    } catch (cause) {
      setRowMessages((current) => ({
        ...current,
        [productId]: {
          tone: "danger",
          text: errorMessage(cause, "The card was not queued."),
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
        description="Find an exact printing and queue inventory without leaving the results."
      />
      <div class="page-body add-cards-layout">
        <Toolbar>
          <Field label="Merchandise profile" class="profile-field">
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
              ? "No profile configured"
              : `${activeProfile.language} · ${activeProfile.defaultCondition} · ${activeProfile.defaultPrinting} · ${money(activeProfile.estimatedShippingPrice)} shipping · ${activePricingProfile?.name ?? "Missing pricing profile"}`}
          </span>
        </Toolbar>
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
              placeholder="Search TCGplayer catalog"
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
              {<option value="">All product lines</option>}
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
              detail="Use a card name or TCGplayer product number. Set and product-line filters appear after the first result."
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
                      busy={adding.has(product.productId)}
                      onVisible={queueDetails}
                      onSelection={(patch) =>
                        updateSelection(product.productId, patch)
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
              <h2 id="quantity-title">Add custom quantity</h2>
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
                Add cards
              </Button>
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
  busy,
  onVisible,
  onSelection,
  onAdd,
  onCustom,
}: {
  readonly product: CatalogSearch["products"][number];
  readonly details: CatalogProduct | undefined;
  readonly selection: RowSelection;
  readonly message: RowMessage | undefined;
  readonly busy: boolean;
  readonly onVisible: (productId: number) => void;
  readonly onSelection: (patch: Partial<RowSelection>) => void;
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
          {money(product.marketPrice)} · foil{" "}
          {product.foilMarketPrice === undefined
            ? "—"
            : money(product.foilMarketPrice)}
        </small>
      </div>
      <div class="catalog-controls">
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
          <Spinner label="Pricing and queueing" />
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
                List {message.alternateLanguage}
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
