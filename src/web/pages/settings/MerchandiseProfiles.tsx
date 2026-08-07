import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../../contracts.js";
import { Button, Field } from "../../components/ui.js";
import { conditions, type MerchandiseProfile, uniqueId } from "./model.js";

export function MerchandiseProfiles({
  settings,
  onChange,
}: {
  readonly settings: Settings;
  readonly onChange: (settings: Settings) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    settings.defaultMerchandiseProfileId,
  );
  useEffect(() => {
    if (
      !settings.merchandiseProfiles.some((profile) => profile.id === selectedId)
    )
      setSelectedId(settings.defaultMerchandiseProfileId);
  }, [
    selectedId,
    settings.defaultMerchandiseProfileId,
    settings.merchandiseProfiles,
  ]);
  const profile =
    settings.merchandiseProfiles.find(
      (candidate) => candidate.id === selectedId,
    ) ?? settings.merchandiseProfiles[0];
  if (profile === undefined) return null;
  const selectedProfile: MerchandiseProfile = profile;

  function updateProfile(updated: MerchandiseProfile) {
    onChange({
      ...settings,
      merchandiseProfiles: settings.merchandiseProfiles.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    });
  }
  function addProfile() {
    if (settings.merchandiseProfiles.length >= 20) return;
    const id = uniqueId(
      "merchandise",
      settings.merchandiseProfiles.map((item) => item.id),
    );
    const created: MerchandiseProfile = {
      ...selectedProfile,
      id,
      name: "New merchandise profile",
    };
    onChange({
      ...settings,
      merchandiseProfiles: [...settings.merchandiseProfiles, created],
    });
    setSelectedId(id);
  }
  function removeProfile() {
    if (settings.merchandiseProfiles.length === 1) return;
    const profiles = settings.merchandiseProfiles.filter(
      (candidate) => candidate.id !== selectedProfile.id,
    );
    const nextId = profiles[0]?.id ?? "";
    onChange({
      ...settings,
      merchandiseProfiles: profiles,
      defaultMerchandiseProfileId:
        settings.defaultMerchandiseProfileId === selectedProfile.id
          ? nextId
          : settings.defaultMerchandiseProfileId,
    });
    setSelectedId(nextId);
  }
  return (
    <div class="settings-workbench">
      <aside class="settings-list">
        <div class="settings-list__header">
          <strong>Merchandise</strong>
          <Button tone="quiet" onClick={addProfile}>
            Add
          </Button>
        </div>
        {settings.merchandiseProfiles.map((item) => (
          <button
            key={item.id}
            type="button"
            class="settings-list__item"
            aria-current={item.id === profile.id ? "true" : undefined}
            onClick={() => setSelectedId(item.id)}
          >
            <span>{item.name}</span>
            <small>
              {item.language} · {item.defaultCondition} · {item.defaultPrinting}
            </small>
          </button>
        ))}
      </aside>
      <div class="settings-editor">
        <section class="editor-section">
          <div class="editor-section__head">
            <div>
              <h2>{profile.name}</h2>
              <p>Defaults used when adding products to seller inventory.</p>
            </div>
            <div class="row-actions">
              <label class="default-check">
                <input
                  type="radio"
                  checked={settings.defaultMerchandiseProfileId === profile.id}
                  onChange={() =>
                    onChange({
                      ...settings,
                      defaultMerchandiseProfileId: profile.id,
                    })
                  }
                />{" "}
                Default
              </label>
              <Button
                tone="danger"
                disabled={settings.merchandiseProfiles.length === 1}
                onClick={removeProfile}
              >
                Remove
              </Button>
            </div>
          </div>
          <div class="form-grid form-grid--3">
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
            <Field label="Language">
              <input
                type="text"
                maxLength={64}
                value={profile.language}
                onInput={(event) =>
                  updateProfile({
                    ...profile,
                    language: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Shipping rate">
              <input
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                value={profile.estimatedShippingPrice}
                onInput={(event) =>
                  updateProfile({
                    ...profile,
                    estimatedShippingPrice: Number(event.currentTarget.value),
                  })
                }
              />
            </Field>
            <Field label="Default condition">
              <select
                value={profile.defaultCondition}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    defaultCondition: event.currentTarget
                      .value as MerchandiseProfile["defaultCondition"],
                  })
                }
              >
                {conditions.map((condition) => (
                  <option key={condition}>{condition}</option>
                ))}
              </select>
            </Field>
            <Field label="Default printing">
              <select
                value={profile.defaultPrinting}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    defaultPrinting: event.currentTarget
                      .value as MerchandiseProfile["defaultPrinting"],
                  })
                }
              >
                <option>Normal</option>
                <option>Foil</option>
              </select>
            </Field>
            <Field label="Pricing profile">
              <select
                value={profile.pricingProfileId}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    pricingProfileId: event.currentTarget.value,
                  })
                }
              >
                {settings.repricingProfiles.map((pricing) => (
                  <option key={pricing.id} value={pricing.id}>
                    {pricing.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div class="notice notice--info">
            For items under $5, effective marketplace shipping is at least
            $1.49.
          </div>
        </section>
      </div>
    </div>
  );
}
