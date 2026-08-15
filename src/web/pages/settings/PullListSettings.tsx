import { useEffect, useState } from "preact/hooks";
import { PULL_LIST_BIN_FIELD_OPTIONS } from "../../../pull-list-binning.js";
import { Button, Field, Toggle } from "../../components/ui.js";
import type { Settings } from "../../contracts.js";
import { uniqueId } from "./model.js";

type BinRule = Settings["masterPullList"]["binning"]["rules"][number];
type BinDimension = BinRule["dimensions"][number];

function moved<T>(
  items: readonly T[],
  index: number,
  offset: -1 | 1,
): readonly T[] {
  const destination = index + offset;
  if (destination < 0 || destination >= items.length) return items;
  const next = [...items];
  const item = next[index];
  if (item === undefined) return items;
  next.splice(index, 1);
  next.splice(destination, 0, item);
  return next;
}

export function PullListSettings({
  settings,
  onChange,
}: {
  readonly settings: Settings;
  readonly onChange: (settings: Settings) => void;
}) {
  const rules = settings.masterPullList.binning.rules;
  const [selectedId, setSelectedId] = useState(rules[0]?.id ?? "");
  useEffect(() => {
    if (!rules.some((rule) => rule.id === selectedId)) {
      setSelectedId(rules[0]?.id ?? "");
    }
  }, [rules, selectedId]);
  const selectedRule = rules.find((rule) => rule.id === selectedId);

  function updatePullList(update: Partial<Settings["masterPullList"]>): void {
    onChange({
      ...settings,
      masterPullList: { ...settings.masterPullList, ...update },
    });
  }

  function updateBinning(
    update: Partial<Settings["masterPullList"]["binning"]>,
  ): void {
    updatePullList({
      binning: { ...settings.masterPullList.binning, ...update },
    });
  }

  function updateRule(rule: BinRule): void {
    updateBinning({
      rules: rules.map((candidate) =>
        candidate.id === rule.id ? rule : candidate,
      ),
    });
  }

  function addRule(): void {
    if (rules.length >= 20) return;
    const id = uniqueId(
      "bin",
      rules.map((rule) => rule.id),
    );
    const rule: BinRule = {
      id,
      name: "New bin rule",
      enabled: true,
      productLine: "*",
      prefix: "",
      dimensions: [{ field: "productLine", fallback: "Unknown product line" }],
    };
    updateBinning({ rules: [...rules, rule] });
    setSelectedId(id);
  }

  function removeRule(): void {
    if (selectedRule === undefined) return;
    const remaining = rules.filter((rule) => rule.id !== selectedRule.id);
    updateBinning({ rules: remaining });
    setSelectedId(remaining[0]?.id ?? "");
  }

  function moveRule(offset: -1 | 1): void {
    if (selectedRule === undefined) return;
    const index = rules.findIndex((rule) => rule.id === selectedRule.id);
    updateBinning({ rules: moved(rules, index, offset) });
  }

  function updateDimension(index: number, dimension: BinDimension): void {
    if (selectedRule === undefined) return;
    updateRule({
      ...selectedRule,
      dimensions: selectedRule.dimensions.map((candidate, candidateIndex) =>
        candidateIndex === index ? dimension : candidate,
      ),
    });
  }

  return (
    <div class="settings-editor settings-editor--single">
      <section class="editor-section">
        <div class="editor-section__head">
          <div>
            <h2>Master pull list</h2>
            <p>Control displayed color groups and physical bin assignments.</p>
          </div>
        </div>
        <div class="form-grid form-grid--2">
          <Toggle
            label="Group lands as Land"
            description="Use Land instead of Colorless for provider-identified lands"
            checked={settings.masterPullList.groupLands}
            onChange={(groupLands) => updatePullList({ groupLands })}
          />
          <Toggle
            label="Group color pairs as Multicolored"
            description="Combine every card with two or more colors"
            checked={settings.masterPullList.groupMulticolored}
            onChange={(groupMulticolored) =>
              updatePullList({ groupMulticolored })
            }
          />
          <Toggle
            label="Assign cards to bins"
            description="Calculate and sort a physical Bin path for every pull-list row"
            checked={settings.masterPullList.binning.enabled}
            onChange={(enabled) => updateBinning({ enabled })}
          />
          <Field label="Unmatched bin" hint="Used when no enabled rule matches">
            <input
              type="text"
              maxLength={128}
              value={settings.masterPullList.binning.fallback}
              onInput={(event) =>
                updateBinning({ fallback: event.currentTarget.value })
              }
            />
          </Field>
        </div>
      </section>

      <div class="settings-workbench">
        <aside class="settings-list">
          <div class="settings-list__header">
            <strong>Bin rules</strong>
            <Button
              tone="quiet"
              disabled={rules.length >= 20}
              onClick={addRule}
            >
              Add
            </Button>
          </div>
          {rules.map((rule, index) => (
            <button
              key={rule.id}
              type="button"
              class="settings-list__item"
              aria-current={rule.id === selectedId ? "true" : undefined}
              onClick={() => setSelectedId(rule.id)}
            >
              <span>
                {String(index + 1)}. {rule.name}
              </span>
              <small>
                {rule.productLine} · {String(rule.dimensions.length)} levels
              </small>
            </button>
          ))}
        </aside>

        {selectedRule === undefined ? (
          <section class="editor-section">
            <h2>No bin rules</h2>
            <p>
              Add a rule to assign matching product lines to a bin hierarchy.
            </p>
          </section>
        ) : (
          <section class="editor-section">
            <div class="editor-section__head">
              <div>
                <h2>{selectedRule.name}</h2>
                <p>The first enabled rule whose product line matches wins.</p>
              </div>
              <div class="row-actions">
                <Button
                  tone="quiet"
                  disabled={rules[0]?.id === selectedRule.id}
                  onClick={() => moveRule(-1)}
                >
                  Move up
                </Button>
                <Button
                  tone="quiet"
                  disabled={rules.at(-1)?.id === selectedRule.id}
                  onClick={() => moveRule(1)}
                >
                  Move down
                </Button>
                <Button tone="danger" onClick={removeRule}>
                  Remove
                </Button>
              </div>
            </div>
            <div class="form-grid form-grid--2">
              <Field label="Rule name">
                <input
                  type="text"
                  maxLength={128}
                  value={selectedRule.name}
                  onInput={(event) =>
                    updateRule({
                      ...selectedRule,
                      name: event.currentTarget.value,
                    })
                  }
                />
              </Field>
              <Field
                label="Product line"
                hint="Exact TCGplayer name, or * for all"
              >
                <input
                  type="text"
                  maxLength={128}
                  value={selectedRule.productLine}
                  onInput={(event) =>
                    updateRule({
                      ...selectedRule,
                      productLine: event.currentTarget.value,
                    })
                  }
                />
              </Field>
              <Field
                label="Bin prefix"
                hint="Optional first path segment, such as MTG"
              >
                <input
                  type="text"
                  maxLength={128}
                  value={selectedRule.prefix}
                  onInput={(event) =>
                    updateRule({
                      ...selectedRule,
                      prefix: event.currentTarget.value,
                    })
                  }
                />
              </Field>
              <Toggle
                label="Rule enabled"
                description="Disabled rules remain saved but do not assign bins"
                checked={selectedRule.enabled}
                onChange={(enabled) => updateRule({ ...selectedRule, enabled })}
              />
            </div>

            <div class="bin-dimensions">
              <div class="settings-list__header">
                <strong>Bin hierarchy</strong>
                <Button
                  tone="quiet"
                  disabled={selectedRule.dimensions.length >= 8}
                  onClick={() =>
                    updateRule({
                      ...selectedRule,
                      dimensions: [
                        ...selectedRule.dimensions,
                        { field: "cardType", fallback: "Other" },
                      ],
                    })
                  }
                >
                  Add level
                </Button>
              </div>
              <datalist id="pull-list-bin-fields">
                {PULL_LIST_BIN_FIELD_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </datalist>
              {selectedRule.dimensions.map((dimension, index) => (
                <div class="bin-dimension" key={String(index)}>
                  <strong class="bin-dimension__number">
                    {String(index + 1)}
                  </strong>
                  <Field label="Metadata field">
                    <input
                      type="text"
                      list="pull-list-bin-fields"
                      maxLength={64}
                      value={dimension.field}
                      onInput={(event) =>
                        updateDimension(index, {
                          ...dimension,
                          field: event.currentTarget.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="Missing value">
                    <input
                      type="text"
                      maxLength={128}
                      value={dimension.fallback}
                      onInput={(event) =>
                        updateDimension(index, {
                          ...dimension,
                          fallback: event.currentTarget.value,
                        })
                      }
                    />
                  </Field>
                  <div class="row-actions bin-dimension__actions">
                    <Button
                      tone="quiet"
                      disabled={index === 0}
                      onClick={() =>
                        updateRule({
                          ...selectedRule,
                          dimensions: moved(selectedRule.dimensions, index, -1),
                        })
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      tone="quiet"
                      disabled={index === selectedRule.dimensions.length - 1}
                      onClick={() =>
                        updateRule({
                          ...selectedRule,
                          dimensions: moved(selectedRule.dimensions, index, 1),
                        })
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      tone="danger"
                      disabled={selectedRule.dimensions.length === 1}
                      onClick={() =>
                        updateRule({
                          ...selectedRule,
                          dimensions: selectedRule.dimensions.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
