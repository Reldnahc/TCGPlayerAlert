import { useEffect, useMemo, useState } from "preact/hooks";
import { DEFAULT_MAGIC_RARITIES } from "../../../game-pricing.js";
import type { Settings } from "../../contracts.js";
import { Button, Field, Toggle } from "../../components/ui.js";
import { money } from "../../utils.js";
import {
  addPricingRange,
  removePricingRange,
  type PricingProfile,
  type PricingRange,
  uniqueId,
} from "./model.js";

export function PricingProfiles({
  settings,
  onChange,
}: {
  readonly settings: Settings;
  readonly onChange: (settings: Settings) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    settings.defaultRepricingProfileId,
  );
  useEffect(() => {
    if (
      !settings.repricingProfiles.some((profile) => profile.id === selectedId)
    )
      setSelectedId(settings.defaultRepricingProfileId);
  }, [
    selectedId,
    settings.defaultRepricingProfileId,
    settings.repricingProfiles,
  ]);
  const profile =
    settings.repricingProfiles.find(
      (candidate) => candidate.id === selectedId,
    ) ?? settings.repricingProfiles[0];
  const references = useMemo(
    () =>
      new Set(
        settings.merchandiseProfiles.map((item) => item.pricingProfileId),
      ),
    [settings.merchandiseProfiles],
  );

  function updateProfile(updated: PricingProfile) {
    onChange({
      ...settings,
      repricingProfiles: settings.repricingProfiles.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    });
  }

  function addProfile() {
    if (settings.repricingProfiles.length >= 20 || profile === undefined)
      return;
    const id = uniqueId(
      "pricing",
      settings.repricingProfiles.map((item) => item.id),
    );
    const created = {
      ...structuredClone(profile),
      id,
      name: "New pricing profile",
    };
    onChange({
      ...settings,
      repricingProfiles: [...settings.repricingProfiles, created],
    });
    setSelectedId(id);
  }

  function removeProfile() {
    if (
      profile === undefined ||
      settings.repricingProfiles.length === 1 ||
      references.has(profile.id)
    )
      return;
    const profiles = settings.repricingProfiles.filter(
      (candidate) => candidate.id !== profile.id,
    );
    const nextId = profiles[0]?.id ?? "";
    onChange({
      ...settings,
      repricingProfiles: profiles,
      defaultRepricingProfileId:
        settings.defaultRepricingProfileId === profile.id
          ? nextId
          : settings.defaultRepricingProfileId,
    });
    setSelectedId(nextId);
  }

  if (profile === undefined) return null;
  return (
    <div class="settings-workbench">
      <aside class="settings-list">
        <div class="settings-list__header">
          <strong>Pricing profiles</strong>
          <Button tone="quiet" onClick={addProfile}>
            Add
          </Button>
        </div>
        {settings.repricingProfiles.map((item) => (
          <button
            key={item.id}
            type="button"
            class="settings-list__item"
            aria-current={item.id === profile.id ? "true" : undefined}
            onClick={() => setSelectedId(item.id)}
          >
            <span>{item.name}</span>
            <small>
              {money(item.minimumPrice)} minimum · {item.ranges.length}{" "}
              {item.ranges.length === 1 ? "range" : "ranges"}
            </small>
          </button>
        ))}
      </aside>
      <div class="settings-editor">
        <section class="editor-section">
          <div class="editor-section__head">
            <div>
              <h2>{profile.name}</h2>
              <p>Shared by inventory repricing and merchandise profiles.</p>
            </div>
            <div class="row-actions">
              <label class="default-check">
                <input
                  type="radio"
                  checked={settings.defaultRepricingProfileId === profile.id}
                  onChange={() =>
                    onChange({
                      ...settings,
                      defaultRepricingProfileId: profile.id,
                    })
                  }
                />{" "}
                Default
              </label>
              <Button
                tone="danger"
                disabled={
                  settings.repricingProfiles.length === 1 ||
                  references.has(profile.id)
                }
                title={
                  references.has(profile.id)
                    ? "This profile is used by merchandise."
                    : ""
                }
                onClick={removeProfile}
              >
                Remove
              </Button>
            </div>
          </div>
          <div class="form-grid form-grid--4">
            <Field label="Profile name">
              <input
                type="text"
                maxLength={80}
                value={profile.name}
                onInput={(event) =>
                  updateProfile({ ...profile, name: event.currentTarget.value })
                }
              />
            </Field>
            <Field label="General minimum">
              <input
                type="number"
                min="0.01"
                max="1000000"
                step="0.01"
                value={profile.minimumPrice}
                onInput={(event) =>
                  updateProfile({
                    ...profile,
                    minimumPrice: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Compare using">
              <select
                value={profile.priceBasis}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    priceBasis: event.currentTarget
                      .value as PricingProfile["priceBasis"],
                  })
                }
              >
                <option value="delivered">Item + shipping</option>
                <option value="item">Item price only</option>
              </select>
            </Field>
            <Field label="Compare condition">
              <select
                value={profile.conditionPolicy}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    conditionPolicy: event.currentTarget
                      .value as PricingProfile["conditionPolicy"],
                  })
                }
              >
                <option value="same-or-better">Same or better</option>
                <option value="same">Same only</option>
              </select>
            </Field>
            <Field label="Adjustment (cents)">
              <input
                type="number"
                min="0"
                max="100000"
                value={profile.adjustmentCents}
                onInput={(event) =>
                  updateProfile({
                    ...profile,
                    adjustmentCents: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Sparse market fallback">
              <select
                value={profile.sparseMarketFallback}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    sparseMarketFallback: event.currentTarget
                      .value as PricingProfile["sparseMarketFallback"],
                  })
                }
              >
                <option value="skip">Wait for evidence</option>
                <option value="higher-of-market-and-lowest">
                  Higher of market or lowest
                </option>
                <option value="market-then-lowest">Market, then lowest</option>
                <option value="lowest-then-market">Lowest, then market</option>
              </select>
            </Field>
            <Toggle
              label="Allow price increases"
              checked={profile.allowPriceIncreases}
              onChange={(checked) =>
                updateProfile({ ...profile, allowPriceIncreases: checked })
              }
            />
          </div>
        </section>
        <MagicRarityEditor profile={profile} onChange={updateProfile} />
        <section class="editor-section">
          <div class="editor-section__head">
            <div>
              <h2>Value ranges</h2>
              <p>
                Rules are evaluated from the lowest value upward. The final
                range is open-ended.
              </p>
            </div>
            <Button
              tone="secondary"
              onClick={() => updateProfile(addPricingRange(profile))}
              disabled={profile.ranges.length >= 20}
            >
              Add range
            </Button>
          </div>
          <div class="range-list">
            {profile.ranges.map((range, index) => (
              <RangeEditor
                key={index}
                profile={profile}
                range={range}
                index={index}
                onChange={(updated) =>
                  updateProfile({
                    ...profile,
                    ranges: profile.ranges.map((candidate, candidateIndex) =>
                      candidateIndex === index ? updated : candidate,
                    ),
                  })
                }
                onRemove={() =>
                  updateProfile(removePricingRange(profile, index))
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function MagicRarityEditor({
  profile,
  onChange,
}: {
  readonly profile: PricingProfile;
  readonly onChange: (profile: PricingProfile) => void;
}) {
  const module = profile.gamePricingModules[0] ?? {
    type: "magic-rarity-floor" as const,
    enabled: false,
    floors: [],
  };
  const extras = module.floors
    .map((floor) => floor.rarity)
    .filter(
      (rarity) =>
        !DEFAULT_MAGIC_RARITIES.some(
          (candidate) =>
            candidate.toLocaleLowerCase() === rarity.toLocaleLowerCase(),
        ),
    );
  const rarities = [...DEFAULT_MAGIC_RARITIES, ...extras];
  function replaceModule(updated: typeof module) {
    onChange({
      ...profile,
      gamePricingModules: [updated],
    });
  }
  function setFloor(rarity: string, value: string) {
    const floors = module.floors.filter(
      (floor) =>
        floor.rarity.toLocaleLowerCase() !== rarity.toLocaleLowerCase(),
    );
    replaceModule({
      ...module,
      floors:
        value === ""
          ? floors
          : [...floors, { rarity, minimumPrice: Number(value) }],
    });
  }
  function renameFloor(previous: string, rarity: string) {
    replaceModule({
      ...module,
      floors: module.floors.map((floor) =>
        floor.rarity === previous ? { ...floor, rarity } : floor,
      ),
    });
  }
  function addRarity() {
    let name = "Other rarity";
    let number = 1;
    const names = new Set(
      module.floors.map((floor) => floor.rarity.toLocaleLowerCase()),
    );
    while (names.has(name.toLocaleLowerCase())) {
      number += 1;
      name = `Other rarity ${String(number)}`;
    }
    replaceModule({
      ...module,
      enabled: true,
      floors: [
        ...module.floors,
        { rarity: name, minimumPrice: profile.minimumPrice },
      ],
    });
  }
  return (
    <section class="editor-section">
      <div class="editor-section__head">
        <div>
          <h2>Magic rarity minimums</h2>
          <p>
            Additional floors can raise, but never lower, the general minimum.
          </p>
        </div>
        <Toggle
          label="Enable"
          checked={module.enabled}
          onChange={(checked) => replaceModule({ ...module, enabled: checked })}
        />
      </div>
      <div class="rarity-grid">
        {rarities.map((rarity) => {
          const floor = module.floors.find(
            (candidate) =>
              candidate.rarity.toLocaleLowerCase() ===
              rarity.toLocaleLowerCase(),
          );
          const standard = DEFAULT_MAGIC_RARITIES.includes(
            rarity as (typeof DEFAULT_MAGIC_RARITIES)[number],
          );
          return (
            <div class="rarity-row" key={rarity}>
              <Field label="Rarity">
                <input
                  type="text"
                  maxLength={80}
                  readOnly={standard}
                  disabled={!module.enabled}
                  value={rarity}
                  onInput={(event) =>
                    renameFloor(rarity, event.currentTarget.value)
                  }
                />
              </Field>
              <Field label="Minimum">
                <input
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  disabled={!module.enabled}
                  placeholder={money(profile.minimumPrice)}
                  value={floor?.minimumPrice ?? ""}
                  onInput={(event) =>
                    setFloor(rarity, event.currentTarget.value)
                  }
                />
              </Field>
              {standard ? (
                <span />
              ) : (
                <Button
                  tone="quiet"
                  disabled={!module.enabled}
                  onClick={() => setFloor(rarity, "")}
                >
                  Remove
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <Button
        tone="secondary"
        disabled={!module.enabled || module.floors.length >= 50}
        onClick={addRarity}
      >
        Add rarity
      </Button>
    </section>
  );
}

function RangeEditor({
  profile,
  range,
  index,
  onChange,
  onRemove,
}: {
  readonly profile: PricingProfile;
  readonly range: PricingRange;
  readonly index: number;
  readonly onChange: (range: PricingRange) => void;
  readonly onRemove: () => void;
}) {
  const last = index === profile.ranges.length - 1;
  const previous =
    index === 0 ? undefined : profile.ranges[index - 1]?.maximumPrice;
  const label = last
    ? previous === undefined
      ? "All values"
      : `Above ${money(previous)}`
    : previous === undefined
      ? `Up to ${money(range.maximumPrice)}`
      : `${money(previous)}–${money(range.maximumPrice)}`;
  return (
    <div class="range-editor">
      <div class="range-editor__title">
        <strong>{label}</strong>
        <Button
          tone="quiet"
          disabled={profile.ranges.length === 1}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <div class="range-fields">
        {last ? null : (
          <Field label="Maximum">
            <input
              type="number"
              min="0.01"
              max="1000000"
              step="0.01"
              value={range.maximumPrice}
              onInput={(event) =>
                onChange({
                  ...range,
                  maximumPrice: Number(event.currentTarget.value),
                })
              }
            />
          </Field>
        )}
        <Field label="Comparables">
          <input
            type="number"
            min="0"
            max="100"
            value={range.minimumListings}
            onInput={(event) =>
              onChange({
                ...range,
                minimumListings: Number(event.currentTarget.value),
              })
            }
          />
        </Field>
        <Field label="Price from">
          <select
            value={range.priceSource}
            onChange={(event) =>
              onChange({
                ...range,
                priceSource: event.currentTarget
                  .value as PricingRange["priceSource"],
              })
            }
          >
            <option value="lowest">Lowest listing</option>
            <option value="market">Market price</option>
          </select>
        </Field>
        <Field label="Use %">
          <input
            type="number"
            min="1"
            max="500"
            step="0.1"
            value={range.percentage}
            onInput={(event) =>
              onChange({
                ...range,
                percentage: Number(event.currentTarget.value),
              })
            }
          />
        </Field>
        <Field label="Gap analysis">
          <select
            value={range.supportMode ?? "adjacent"}
            onChange={(event) =>
              onChange({
                ...range,
                supportMode: event.currentTarget.value as NonNullable<
                  PricingRange["supportMode"]
                >,
              })
            }
          >
            <option value="cluster">Seller bands</option>
            <option value="adjacent">First vs second</option>
          </select>
        </Field>
        <Field label="Sellers">
          <input
            type="number"
            min="1"
            max="100"
            disabled={
              (range.supportMode ?? "adjacent") !== "cluster" ||
              range.gapAction === "follow-lowest"
            }
            value={range.minimumSellerSupport ?? 2}
            onInput={(event) =>
              onChange({
                ...range,
                minimumSellerSupport: Number(event.currentTarget.value),
              })
            }
          />
        </Field>
        <Field label="Band width %">
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            disabled={
              (range.supportMode ?? "adjacent") !== "cluster" ||
              range.gapAction === "follow-lowest"
            }
            value={range.supportWindowPercent ?? 5}
            onInput={(event) =>
              onChange({
                ...range,
                supportWindowPercent: Number(event.currentTarget.value),
              })
            }
          />
        </Field>
        <Field label="Gap %">
          <input
            type="number"
            min="0"
            max="10000"
            step="0.1"
            disabled={range.gapAction === "follow-lowest"}
            value={range.gapThresholdPercent}
            onInput={(event) =>
              onChange({
                ...range,
                gapThresholdPercent: Number(event.currentTarget.value),
              })
            }
          />
        </Field>
        <Field label="Gap action">
          <select
            value={range.gapAction}
            onChange={(event) =>
              onChange({
                ...range,
                gapAction: event.currentTarget
                  .value as PricingRange["gapAction"],
              })
            }
          >
            <option value="follow-lowest">Ignore gap</option>
            <option value="use-next">Use supported reference</option>
            <option value="skip">Skip card</option>
          </select>
        </Field>
      </div>
    </div>
  );
}
