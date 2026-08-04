export const CONFIG_UI_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TCGPlayerAlert Settings</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="shell">
      <header class="hero">
        <div class="brand-mark" aria-hidden="true">T</div>
        <div>
          <p class="eyebrow">TCGPlayerAlert</p>
          <h1>Fulfillment settings</h1>
          <p class="subtitle">Choose what prints when a new order arrives.</p>
        </div>
        <div id="connection" class="connection">Loading settings…</div>
      </header>

      <main>
        <form id="settings-form" hidden>
          <section class="panel general-panel" aria-labelledby="general-title">
            <div>
              <p class="section-kicker">Automation</p>
              <h2 id="general-title">General</h2>
            </div>
            <label class="field compact-field">
              <span>Check for orders every</span>
              <span class="input-with-unit">
                <input id="poll-interval" type="number" min="1" max="1440" required />
                <span>minutes</span>
              </span>
            </label>
            <label class="switch-row warning-switch">
              <span>
                <strong>Dry run</strong>
                <small>Find orders and evaluate rules without printing.</small>
              </span>
              <input id="dry-run" type="checkbox" />
              <span class="switch" aria-hidden="true"></span>
            </label>
          </section>

          <div class="section-heading">
            <div>
              <p class="section-kicker">Order outputs</p>
              <h2>Print actions</h2>
            </div>
            <button id="refresh-printers" class="quiet-button" type="button">Refresh printers</button>
          </div>
          <p id="printer-note" class="printer-note" hidden></p>
          <div id="outputs" class="output-grid"></div>

          <div class="section-heading queue-heading">
            <div>
              <p class="section-kicker">Background work</p>
              <h2>Price update queue</h2>
            </div>
            <span id="queue-health" class="connection">Loading queue...</span>
          </div>
          <section class="panel queue-panel" aria-labelledby="queue-title">
            <div class="queue-settings">
              <label class="switch-row">
                <span>
                  <strong id="queue-title">Process queued prices</strong>
                  <small>Runs one at a time. Dry run pauses this worker even when it is enabled.</small>
                </span>
                <input id="price-queue-enabled" type="checkbox" />
                <span class="switch" aria-hidden="true"></span>
              </label>
              <label class="field compact-field">
                <span>Cooldown after each update</span>
                <span class="input-with-unit">
                  <input id="price-delay" type="number" min="0" max="3600" required />
                  <span>seconds</span>
                </span>
              </label>
            </div>

            <details class="queue-entry">
              <summary>Queue one listing price</summary>
              <p class="queue-help">Use the current Seller Portal listing values. Quantity and reserve quantity are preserved, never changed.</p>
              <div class="queue-form-grid">
                <label class="field wide-field"><span>Product name</span><input id="q-product-name" type="text" maxlength="1024" /></label>
                <label class="field"><span>Category</span><input id="q-category-name" type="text" maxlength="256" /></label>
                <label class="field"><span>New price</span><input id="q-price" type="number" min="0.01" max="1000000" step="0.01" /></label>
                <label class="field"><span>SKU / Product condition ID</span><input id="q-sku-id" type="number" min="1" step="1" /></label>
                <label class="field"><span>Product ID</span><input id="q-product-id" type="number" min="1" step="1" /></label>
                <label class="field"><span>Condition ID</span><input id="q-condition-id" type="number" min="1" step="1" /></label>
                <label class="field"><span>Current quantity</span><input id="q-quantity" type="number" min="0" step="1" /></label>
                <label class="field"><span>Reserve quantity</span><input id="q-reserve" type="number" min="0" step="1" value="0" /></label>
                <label class="field"><span>Channel ID</span><input id="q-channel-id" type="number" min="0" step="1" value="0" /></label>
                <label class="field"><span>Custom price ID (optional)</span><input id="q-custom-id" type="number" min="0" step="1" /></label>
              </div>
              <div class="queue-submit-row">
                <span id="queue-form-message" class="queue-message"></span>
                <button id="queue-submit" class="primary-button dark-button" type="button">Add to queue</button>
              </div>
            </details>

            <div class="queue-list-head">
              <strong>Recent jobs</strong>
              <button id="refresh-queue" class="quiet-button" type="button">Refresh</button>
            </div>
            <div id="queue-jobs" class="queue-jobs" aria-live="polite"></div>
          </section>

          <div class="save-bar">
            <div>
              <strong id="save-title">Ready to configure</strong>
              <span id="save-detail">Changes are stored only on this computer.</span>
            </div>
            <button id="save-button" class="primary-button" type="submit">Save settings</button>
          </div>
        </form>
        <section id="fatal-error" class="panel error-panel" hidden>
          <h2>Settings could not be loaded</h2>
          <p id="fatal-message"></p>
          <button id="retry" class="primary-button" type="button">Try again</button>
        </section>
      </main>
    </div>
    <script src="/app.js" defer></script>
  </body>
</html>`;

export const CONFIG_UI_CSS = String.raw`:root {
  color-scheme: light;
  --ink: #17221d;
  --muted: #647168;
  --paper: #f4f5ef;
  --card: #fffef9;
  --line: #dce1d8;
  --green: #166b49;
  --green-dark: #0e5137;
  --green-soft: #e1f2e8;
  --amber: #a55218;
  --shadow: 0 20px 55px rgba(32, 51, 40, 0.09);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(circle at top right, #dceee3 0, transparent 32rem), var(--paper); color: var(--ink); }
button, input, select { font: inherit; }
button { cursor: pointer; }
.shell { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 44px 0 112px; }
.hero { display: grid; grid-template-columns: auto 1fr auto; gap: 18px; align-items: center; margin-bottom: 34px; }
.brand-mark { width: 54px; height: 54px; display: grid; place-items: center; background: var(--green); color: white; border-radius: 17px; font: 800 27px/1 Georgia, serif; box-shadow: 0 12px 26px rgba(22,107,73,.22); }
.eyebrow, .section-kicker { margin: 0 0 4px; color: var(--green); font-size: .74rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, p { margin-top: 0; }
h1 { margin-bottom: 5px; font: 700 clamp(2rem, 5vw, 3.25rem)/1.02 Georgia, serif; letter-spacing: -.035em; }
h2 { margin-bottom: 0; font: 700 1.45rem/1.15 Georgia, serif; }
.subtitle { margin-bottom: 0; color: var(--muted); }
.connection { padding: 9px 13px; border-radius: 999px; background: rgba(255,255,255,.72); border: 1px solid var(--line); color: var(--muted); font-size: .83rem; font-weight: 700; }
.connection.ready { color: var(--green-dark); background: var(--green-soft); border-color: #badcc8; }
.panel { background: var(--card); border: 1px solid rgba(202,211,201,.8); border-radius: 22px; box-shadow: var(--shadow); }
.general-panel { padding: 24px 26px; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 28px; }
.field { display: grid; gap: 8px; color: var(--muted); font-size: .86rem; font-weight: 700; }
.compact-field { min-width: 210px; }
.input-with-unit { display: flex; align-items: center; gap: 9px; color: var(--muted); font-weight: 600; }
input[type="number"], input[type="text"], select { width: 100%; min-height: 44px; border: 1px solid #cfd7ce; border-radius: 11px; background: white; color: var(--ink); padding: 9px 11px; outline: none; }
input[type="number"]:focus, input[type="text"]:focus, select:focus { border-color: var(--green); box-shadow: 0 0 0 3px rgba(22,107,73,.12); }
.input-with-unit input { width: 82px; }
.switch-row { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "text toggle"; align-items: center; gap: 18px; }
.switch-row > span:first-child { grid-area: text; display: grid; gap: 4px; }
.switch-row small { color: var(--muted); font-weight: 500; line-height: 1.35; }
.switch-row input { position: absolute; opacity: 0; pointer-events: none; }
.switch { grid-area: toggle; width: 48px; height: 28px; border-radius: 999px; background: #b8c0b9; padding: 3px; transition: .18s ease; }
.switch::after { content: ""; display: block; width: 22px; height: 22px; background: white; border-radius: 50%; box-shadow: 0 2px 5px rgba(0,0,0,.2); transition: .18s ease; }
.switch-row input:checked + .switch { background: var(--green); }
.switch-row input:checked + .switch::after { transform: translateX(20px); }
.switch-row input:focus-visible + .switch { outline: 3px solid rgba(22,107,73,.25); outline-offset: 2px; }
.section-heading { display: flex; justify-content: space-between; align-items: end; margin: 40px 2px 15px; }
.quiet-button { border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.7); color: var(--green-dark); padding: 9px 13px; font-weight: 750; }
.quiet-button:hover { background: white; }
.printer-note { background: #fff4dc; color: #774416; border: 1px solid #eed4a1; border-radius: 12px; padding: 11px 14px; font-size: .9rem; }
.output-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.output-card { overflow: hidden; transition: opacity .2s ease; }
.output-card.disabled .output-body { opacity: .5; }
.output-head { padding: 22px 23px 19px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 14px; }
.output-icon { width: 42px; height: 42px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 13px; background: var(--green-soft); color: var(--green-dark); font-size: 1.15rem; }
.output-title { flex: 1; }
.output-title h3 { margin: 0 0 3px; font-size: 1rem; }
.output-title p { margin: 0; color: var(--muted); font-size: .8rem; }
.output-body { padding: 21px 23px 24px; display: grid; gap: 18px; transition: opacity .2s ease; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.adapter-note { margin: -5px 0 0; color: var(--muted); font-size: .78rem; }
.queue-heading { margin-top: 40px; }
.queue-panel { overflow: hidden; margin-bottom: 22px; }
.queue-settings { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 36px; padding: 23px 25px; border-bottom: 1px solid var(--line); }
.queue-entry { padding: 0 25px; border-bottom: 1px solid var(--line); }
.queue-entry summary { padding: 19px 0; color: var(--green-dark); font-weight: 800; cursor: pointer; }
.queue-entry[open] summary { padding-bottom: 10px; }
.queue-help { margin: 0 0 18px; color: var(--muted); font-size: .86rem; }
.queue-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.queue-form-grid .wide-field { grid-column: span 2; }
.queue-submit-row { display: flex; align-items: center; justify-content: flex-end; gap: 16px; padding: 19px 0 22px; }
.queue-message { flex: 1; color: var(--muted); font-size: .86rem; }
.dark-button { background: var(--green); color: white; }
.dark-button:hover { background: var(--green-dark); }
.queue-list-head { display: flex; justify-content: space-between; align-items: center; padding: 18px 25px 12px; }
.queue-jobs { padding: 0 25px 24px; display: grid; gap: 8px; }
.queue-empty { color: var(--muted); background: var(--paper); border-radius: 12px; padding: 18px; text-align: center; }
.queue-job { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 14px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.queue-job-copy { min-width: 0; display: grid; gap: 3px; }
.queue-job-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9rem; }
.queue-job-copy small { color: var(--muted); }
.status-pill { border-radius: 999px; padding: 5px 9px; background: #edf0eb; color: var(--muted); font-size: .73rem; font-weight: 800; text-transform: capitalize; }
.status-pill.applied { background: var(--green-soft); color: var(--green-dark); }
.status-pill.review-required, .status-pill.failed { background: #fde8df; color: #93401c; }
.status-pill.applying { background: #fff2d7; color: #845311; }
.cancel-job { border: 0; background: transparent; color: #8c4630; padding: 5px; font-size: .8rem; font-weight: 750; }
.save-bar { position: fixed; z-index: 5; bottom: 20px; left: 50%; transform: translateX(-50%); width: min(1048px, calc(100% - 32px)); display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 16px 14px 20px; background: rgba(23,34,29,.94); color: white; border: 1px solid rgba(255,255,255,.14); border-radius: 17px; box-shadow: 0 18px 45px rgba(12,26,18,.25); backdrop-filter: blur(12px); }
.save-bar div { display: grid; gap: 2px; }
.save-bar span { color: #c3cec6; font-size: .82rem; }
.primary-button { border: 0; border-radius: 11px; background: #ecf7ef; color: var(--green-dark); padding: 11px 18px; font-weight: 800; }
.primary-button:hover { background: white; }
.primary-button:disabled { cursor: wait; opacity: .6; }
.error-panel { padding: 32px; }
.error-panel p { color: var(--muted); }
[hidden] { display: none !important; }

@media (max-width: 780px) {
  .shell { width: min(100% - 22px, 600px); padding-top: 24px; }
  .hero { grid-template-columns: auto 1fr; }
  .connection { grid-column: 1 / -1; justify-self: start; }
  .general-panel { grid-template-columns: 1fr; gap: 22px; }
  .output-grid { grid-template-columns: 1fr; }
  .queue-settings { grid-template-columns: 1fr; gap: 20px; }
  .queue-form-grid { grid-template-columns: 1fr 1fr; }
  .queue-form-grid .wide-field { grid-column: span 2; }
  .queue-job { grid-template-columns: minmax(0, 1fr) auto; }
  .queue-job .cancel-job { grid-column: 1 / -1; justify-self: end; }
  .save-bar { bottom: 10px; width: calc(100% - 20px); }
  .save-bar span { display: none; }
}
`;

export const CONFIG_UI_JS = String.raw`(() => {
  "use strict";
  const state = { settings: null };
  const form = document.querySelector("#settings-form");
  const outputs = document.querySelector("#outputs");
  const connection = document.querySelector("#connection");
  const fatal = document.querySelector("#fatal-error");
  const fatalMessage = document.querySelector("#fatal-message");
  const printerNote = document.querySelector("#printer-note");
  const saveButton = document.querySelector("#save-button");
  const saveTitle = document.querySelector("#save-title");
  const saveDetail = document.querySelector("#save-detail");

  const el = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  };

  function field(label, control) {
    return el("label", { className: "field" }, [
      el("span", { text: label }),
      control,
    ]);
  }

  function numberInput(name, value, min, max, step = "1") {
    const input = el("input", {
      type: "number",
      name,
      min: String(min),
      max: String(max),
      step,
      required: "",
    });
    input.value = String(value);
    return input;
  }

  function printerSelect(output) {
    const select = el("select", { name: "printerName", required: "" });
    const names = state.settings.installedPrinters.map((printer) => printer.name);
    if (!names.includes(output.printerName)) names.push(output.printerName);
    for (const name of names) {
      const printer = state.settings.installedPrinters.find((item) => item.name === name);
      const option = el("option", {
        value: name,
        text: printer && printer.isDefault ? name + " (Windows default)" : name,
      });
      if (name === output.printerName) option.selected = true;
      select.append(option);
    }
    return select;
  }

  function renderOutput(output) {
    const card = el("section", { className: "panel output-card", "data-action-id": output.actionId });
    const isAddress = output.type === "print-address-label";
    const enabled = el("input", {
      type: "checkbox",
      name: "enabled",
      "aria-label": isAddress ? "Print address labels" : "Print packing slips",
    });
    enabled.checked = output.enabled;
    const switchVisual = el("span", { className: "switch", "aria-hidden": "true" });
    const toggle = el("label", { className: "switch-row", title: "Enable or disable this output" }, [enabled, switchVisual]);
    card.append(el("div", { className: "output-head" }, [
      el("div", { className: "output-icon", text: isAddress ? "✉" : "▤" }),
      el("div", { className: "output-title" }, [
        el("h3", { text: isAddress ? "Address label" : "Packing slip" }),
        el("p", { text: isAddress ? "Recipient address only" : "Full order document" }),
      ]),
      toggle,
    ]));
    const body = el("div", { className: "output-body" });
    body.append(field("Printer", printerSelect(output)));
    body.append(el("p", { className: "adapter-note", text: "Print method: " + output.adapterLabel }));
    if (isAddress) {
      body.append(el("div", { className: "two-column" }, [
        field("Label width (mm)", numberInput("widthMm", output.widthMm, 20, 300, "0.1")),
        field("Label height (mm)", numberInput("heightMm", output.heightMm, 20, 300, "0.1")),
      ]));
      body.append(el("div", { className: "two-column" }, [
        field("Font size", numberInput("fontSize", output.fontSize, 6, 72, "0.5")),
        field("Margin (mm)", numberInput("marginMm", output.marginMm, 0, 50, "0.1")),
      ]));
    } else if (output.adapter === "windows-pdf") {
      const scale = el("select", { name: "scale" });
      for (const [value, label] of [["shrink", "Shrink oversized pages"], ["fit", "Fit to printable area"], ["actual-size", "Actual size"]]) {
        const option = el("option", { value, text: label });
        if (value === output.scale) option.selected = true;
        scale.append(option);
      }
      body.append(el("div", { className: "two-column" }, [
        field("Page scaling", scale),
        field("Print quality (DPI)", numberInput("dpi", output.dpi, 72, 600)),
      ]));
    }
    card.append(body);
    const updateDisabled = () => card.classList.toggle("disabled", !enabled.checked);
    enabled.addEventListener("change", updateDisabled);
    updateDisabled();
    return card;
  }

  function render() {
    document.querySelector("#poll-interval").value = String(state.settings.pollIntervalMinutes);
    document.querySelector("#dry-run").checked = state.settings.dryRun;
    document.querySelector("#price-queue-enabled").checked = state.settings.priceUpdateQueue.enabled;
    document.querySelector("#price-delay").value = String(state.settings.priceUpdateQueue.delaySeconds);
    outputs.replaceChildren(...state.settings.outputs.map(renderOutput));
    printerNote.hidden = !state.settings.discoveryIssue;
    printerNote.textContent = state.settings.discoveryIssue || "";
    connection.textContent = "Local connection";
    connection.classList.add("ready");
    fatal.hidden = true;
    form.hidden = false;
    void loadQueue();
  }

  function queueJob(job) {
    const copy = el("div", { className: "queue-job-copy" }, [
      el("strong", { text: job.update.productName }),
      el("small", { text: "SKU " + job.update.productConditionId + " · $" + Number(job.update.price).toFixed(2) + " · attempt " + job.attempts }),
    ]);
    const status = el("span", {
      className: "status-pill " + job.status,
      text: job.status.replace("-", " "),
    });
    const children = [copy, status];
    if (job.status === "pending") {
      const cancel = el("button", { className: "cancel-job", type: "button", text: "Cancel" });
      cancel.addEventListener("click", () => cancelJob(job.id));
      children.push(cancel);
    }
    return el("div", { className: "queue-job" }, children);
  }

  async function loadQueue() {
    const health = document.querySelector("#queue-health");
    try {
      const response = await fetch("/api/price-updates", { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Queue unavailable.");
      const active = data.counts.pending + data.counts.applying;
      health.textContent = active + (active === 1 ? " active job" : " active jobs");
      health.classList.add("ready");
      const jobs = data.jobs.slice(0, 50);
      document.querySelector("#queue-jobs").replaceChildren(
        ...(jobs.length === 0
          ? [el("div", { className: "queue-empty", text: data.workerRunning ? "No price updates queued." : "No jobs yet. Start the service to process new jobs." })]
          : jobs.map(queueJob)),
      );
    } catch (error) {
      health.textContent = "Queue unavailable";
      health.classList.remove("ready");
      document.querySelector("#queue-jobs").replaceChildren(
        el("div", { className: "queue-empty", text: error instanceof Error ? error.message : "Queue unavailable." }),
      );
    }
  }

  async function cancelJob(jobId) {
    const response = await fetch("/api/price-updates/" + encodeURIComponent(jobId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) {
      document.querySelector("#queue-form-message").textContent = data.message || "The job could not be canceled.";
    }
    await loadQueue();
  }

  async function load() {
    connection.textContent = "Loading settings…";
    try {
      const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "The settings file could not be read.");
      state.settings = data;
      render();
    } catch (error) {
      form.hidden = true;
      fatal.hidden = false;
      fatalMessage.textContent = error instanceof Error ? error.message : "The settings file could not be read.";
      connection.textContent = "Configuration unavailable";
      connection.classList.remove("ready");
    }
  }

  function collectOutput(card, current) {
    const value = {
      actionId: current.actionId,
      enabled: card.querySelector('[name="enabled"]').checked,
      printerName: card.querySelector('[name="printerName"]').value,
    };
    if (current.type === "print-address-label") {
      value.widthMm = Number(card.querySelector('[name="widthMm"]').value);
      value.heightMm = Number(card.querySelector('[name="heightMm"]').value);
      value.fontSize = Number(card.querySelector('[name="fontSize"]').value);
      value.marginMm = Number(card.querySelector('[name="marginMm"]').value);
    } else if (current.adapter === "windows-pdf") {
      value.scale = card.querySelector('[name="scale"]').value;
      value.dpi = Number(card.querySelector('[name="dpi"]').value);
    }
    return value;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    saveTitle.textContent = "Validating settings";
    const payload = {
      revision: state.settings.revision,
      pollIntervalMinutes: Number(document.querySelector("#poll-interval").value),
      dryRun: document.querySelector("#dry-run").checked,
      priceUpdateQueue: {
        enabled: document.querySelector("#price-queue-enabled").checked,
        delaySeconds: Number(document.querySelector("#price-delay").value),
      },
      outputs: state.settings.outputs.map((output) => {
        const card = form.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"]');
        return collectOutput(card, output);
      }),
    };
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "Settings were not saved.");
      state.settings = data;
      render();
      saveTitle.textContent = "Settings saved";
      saveDetail.textContent = "The scheduler will use them on its next sync.";
    } catch (error) {
      saveTitle.textContent = "Settings were not saved";
      saveDetail.textContent = error instanceof Error ? error.message : "Review the values and try again.";
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save settings";
    }
  });

  document.querySelector("#refresh-printers").addEventListener("click", load);
  document.querySelector("#refresh-queue").addEventListener("click", loadQueue);
  document.querySelector("#queue-submit").addEventListener("click", async () => {
    const message = document.querySelector("#queue-form-message");
    const button = document.querySelector("#queue-submit");
    const number = (selector) => Number(document.querySelector(selector).value);
    const optional = document.querySelector("#q-custom-id").value.trim();
    const update = {
      productId: number("#q-product-id"),
      productName: document.querySelector("#q-product-name").value,
      productConditionId: number("#q-sku-id"),
      conditionId: number("#q-condition-id"),
      channelId: number("#q-channel-id"),
      categoryName: document.querySelector("#q-category-name").value,
      quantity: number("#q-quantity"),
      price: number("#q-price"),
      storePriceCustomId: optional === "" ? null : Number(optional),
      reserveQuantity: number("#q-reserve"),
    };
    button.disabled = true;
    message.textContent = "Adding update...";
    try {
      const response = await fetch("/api/price-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(update),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The update was not queued.");
      message.textContent = "Queued. You can leave this page; the worker will continue in the background.";
      document.querySelector("#q-price").value = "";
      await loadQueue();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "The update was not queued.";
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#retry").addEventListener("click", load);
  load();
  setInterval(loadQueue, 5000);
})();`;
