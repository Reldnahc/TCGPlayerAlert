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
      <main>
        <form id="settings-form" hidden>
          <nav class="tab-list" role="tablist" aria-label="Workspace sections">
            <button id="tab-automation" class="tab-button" type="button" role="tab" aria-controls="panel-automation" aria-selected="true" tabindex="0" data-tab="automation">Automation</button>
            <button id="tab-add-cards" class="tab-button" type="button" role="tab" aria-controls="panel-add-cards" aria-selected="false" tabindex="-1" data-tab="add-cards">Add cards</button>
            <button id="tab-repricing" class="tab-button" type="button" role="tab" aria-controls="panel-repricing" aria-selected="false" tabindex="-1" data-tab="repricing">Repricing</button>
            <button id="tab-jobs" class="tab-button" type="button" role="tab" aria-controls="panel-jobs" aria-selected="false" tabindex="-1" data-tab="jobs">Jobs</button>
          </nav>

          <div id="panel-automation" class="tab-panel" role="tabpanel" aria-labelledby="tab-automation" tabindex="0" data-panel="automation">
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
          </div>

          <div id="panel-add-cards" class="tab-panel" role="tabpanel" aria-labelledby="tab-add-cards" tabindex="0" data-panel="add-cards" hidden>
          <div class="section-heading inventory-heading">
            <div>
              <p class="section-kicker">Catalog inventory</p>
              <h2>Add cards</h2>
            </div>
          </div>
          <section class="panel inventory-panel" aria-labelledby="inventory-title">
            <div class="inventory-copy">
              <h3 id="inventory-title">Find the exact printing, choose its condition, and price it automatically</h3>
              <p>Every addition is previewed first. Quantity and the calculated price are submitted together by a separate durable queue.</p>
            </div>
            <div class="catalog-search-row">
              <label class="field"><span>Card name</span><input id="catalog-query" type="text" maxlength="200" placeholder="Search card name" /></label>
              <label class="field"><span>Product line (optional)</span><input id="catalog-product-line" type="text" list="catalog-product-lines" maxlength="100" placeholder="All product lines" /><datalist id="catalog-product-lines"></datalist><small class="field-note">Suggestions appear from loaded catalog results.</small></label>
              <button id="catalog-search" class="primary-button dark-button" type="button">Search catalog</button>
            </div>
            <p id="inventory-message" class="repricing-message">Search for a card to begin. Nothing is listed until you preview and queue it.</p>
            <div id="catalog-results" class="catalog-results" hidden></div>
            <div id="inventory-editor" class="inventory-editor" hidden>
              <div id="selected-product" class="selected-product"></div>
              <div class="inventory-fields">
                <label class="field"><span>Condition</span><select id="inventory-card-condition"></select></label>
                <label class="field"><span>Printing</span><select id="inventory-printing"></select></label>
                <label class="field"><span>Language</span><select id="inventory-language"></select></label>
                <label class="field"><span>Quantity to add</span><input id="inventory-quantity" type="number" min="1" max="10000000" step="1" value="1" /></label>
                <label class="field"><span>Minimum item price</span><span class="money-input"><span>$</span><input id="inventory-minimum" type="number" min="0.01" max="1000000" step="0.01" value="0.35" /></span></label>
                <label class="field"><span>Compare against</span><select id="inventory-condition"><option value="same-or-better">Same or better condition</option><option value="same">Same condition only</option></select></label>
                <label class="field"><span>Compare using</span><select id="inventory-basis"><option value="delivered">Item + shipping</option><option value="item">Item price only</option></select></label>
                <label class="field"><span>Your Seller Portal shipping rate</span><span class="money-input"><span>$</span><input id="inventory-shipping" type="number" min="0" max="1000000" step="0.01" value="0" /></span><small class="field-note">Used for pricing only; this does not change Seller Portal. TCGplayer applies at least $1.49 to orders under $5.</small></label>
                <label class="field"><span>Undercut by</span><span class="input-with-unit"><input id="inventory-adjustment" type="number" min="0" max="100000" step="1" value="0" /><span>cents</span></span></label>
                <label class="field"><span>If no listing matches</span><select id="inventory-fallback"><option value="market">Use market price</option><option value="stop">Stop for review</option><option value="manual">Use manual price</option></select></label>
                <label id="inventory-manual-field" class="field" hidden><span>Manual fallback price</span><span class="money-input"><span>$</span><input id="inventory-manual-price" type="number" min="0.01" max="1000000" step="0.01" value="0.35" /></span></label>
              </div>
              <div class="inventory-preview-actions">
                <button id="inventory-preview" class="primary-button dark-button" type="button">Preview addition</button>
              </div>
              <div id="inventory-preview-result" class="inventory-preview-result" hidden></div>
            </div>
          </section>
          </div>

          <div id="panel-repricing" class="tab-panel" role="tabpanel" aria-labelledby="tab-repricing" tabindex="0" data-panel="repricing" hidden>
          <div class="section-heading repricing-heading">
            <div>
              <p class="section-kicker">Listed inventory</p>
              <h2>Smart repricing</h2>
            </div>
          </div>
          <section class="panel repricing-panel" aria-labelledby="repricing-title">
            <div class="repricing-copy">
              <h3 id="repricing-title">Match qualifying lowest listings</h3>
              <p>Loads cards you already have listed, compares the same printing and language, and previews every price before anything is queued.</p>
            </div>
            <div class="repricing-rules">
              <label class="field"><span>Minimum item price</span><span class="money-input"><span>$</span><input id="repricing-minimum" type="number" min="0.01" max="1000000" step="0.01" value="0.35" /></span></label>
              <label class="field"><span>Condition comparison</span><select id="repricing-condition"><option value="same-or-better">Same or better condition</option><option value="same">Same condition only</option></select></label>
              <label class="field"><span>Compare using</span><select id="repricing-basis"><option value="delivered">Item + shipping</option><option value="item">Item price only</option></select></label>
              <label class="field"><span>Undercut by</span><span class="input-with-unit"><input id="repricing-adjustment" type="number" min="0" max="100000" step="1" value="0" /><span>cents</span></span></label>
            </div>
            <div class="repricing-options">
              <label class="switch-row">
                <span><strong>Allow price increases</strong><small>Off by default: cards already below the target stay where they are.</small></span>
                <input id="repricing-allow-increases" type="checkbox" />
                <span class="switch" aria-hidden="true"></span>
              </label>
              <button id="repricing-preview" class="primary-button dark-button" type="button">Refresh inventory &amp; preview</button>
            </div>
            <p id="repricing-message" class="repricing-message">Nothing changes until you preview and queue selected prices.</p>
            <div id="repricing-results" hidden>
              <div class="repricing-summary">
                <div id="repricing-counts"></div>
                <div class="repricing-actions">
                  <button id="repricing-select-all" class="quiet-button" type="button">Select all changes</button>
                  <button id="repricing-queue" class="primary-button dark-button" type="button">Queue selected</button>
                </div>
              </div>
              <div class="repricing-table-wrap">
                <table class="repricing-table">
                  <thead><tr><th><span class="sr-only">Select</span></th><th>Card</th><th>Condition</th><th>Current</th><th>Lowest match</th><th>Proposed</th><th>Result</th></tr></thead>
                  <tbody id="repricing-rows"></tbody>
                </table>
              </div>
            </div>
          </section>
          </div>

          <div id="panel-jobs" class="tab-panel" role="tabpanel" aria-labelledby="tab-jobs" tabindex="0" data-panel="jobs" hidden>
          <div class="section-heading queue-heading first-heading">
            <div>
              <p class="section-kicker">Background work</p>
              <h2>Inventory addition queue</h2>
            </div>
          </div>
          <section class="panel queue-panel" aria-labelledby="inventory-queue-title">
            <div class="inventory-queue-settings">
              <label class="switch-row">
                <span><strong id="inventory-queue-title">Process added cards</strong><small>Runs one at a time. Dry run pauses inventory submissions.</small></span>
                <input id="inventory-queue-enabled" type="checkbox" />
                <span class="switch" aria-hidden="true"></span>
              </label>
              <label class="field compact-field"><span>Cooldown after each addition</span><span class="input-with-unit"><input id="inventory-delay" type="number" min="0" max="3600" required /><span>seconds</span></span></label>
            </div>
            <div class="queue-list-head">
              <strong>Recent card additions</strong>
              <button id="refresh-inventory-queue" class="quiet-button" type="button">Refresh</button>
            </div>
            <div id="inventory-queue-jobs" class="queue-jobs" aria-live="polite"></div>
          </section>

          <div class="section-heading queue-heading">
            <div>
              <p class="section-kicker">Background work</p>
              <h2>Price update queue</h2>
            </div>
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

            <div class="queue-list-head">
              <strong>Recent jobs</strong>
              <button id="refresh-queue" class="quiet-button" type="button">Refresh</button>
            </div>
            <div id="queue-jobs" class="queue-jobs" aria-live="polite"></div>
          </section>
          </div>

          <div id="save-bar" class="save-bar" hidden>
            <div>
              <strong id="save-title">Ready to configure</strong>
              <span id="save-detail">Automation and worker changes are stored only on this computer.</span>
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
.shell { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 20px 0 112px; }
.section-kicker { margin: 0 0 4px; color: var(--green); font-size: .74rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h2, p { margin-top: 0; }
h2 { margin-bottom: 0; font: 700 1.45rem/1.15 Georgia, serif; }
.tab-list { position: sticky; z-index: 4; top: 10px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin-bottom: 24px; padding: 6px; border: 1px solid rgba(202,211,201,.9); border-radius: 16px; background: rgba(244,245,239,.9); box-shadow: 0 10px 28px rgba(32,51,40,.08); backdrop-filter: blur(12px); }
.tab-button { min-height: 46px; border: 0; border-radius: 11px; background: transparent; color: var(--muted); padding: 10px 16px; font-weight: 800; }
.tab-button:hover { color: var(--green-dark); background: rgba(255,255,255,.72); }
.tab-button[aria-selected="true"] { color: white; background: var(--green); box-shadow: 0 7px 16px rgba(22,107,73,.2); }
.tab-button:focus-visible { outline: 3px solid rgba(22,107,73,.25); outline-offset: 2px; }
.tab-panel { min-height: 390px; }
.tab-panel > .section-heading:first-child { margin-top: 0; }
.panel { background: var(--card); border: 1px solid rgba(202,211,201,.8); border-radius: 22px; box-shadow: var(--shadow); }
.general-panel { padding: 24px 26px; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 28px; }
.field { display: grid; gap: 8px; color: var(--muted); font-size: .86rem; font-weight: 700; }
.field-note { font-size: .72rem; font-weight: 500; line-height: 1.35; }
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
.output-card.disabled .output-body > :not(.print-test-row) { opacity: .5; }
.output-head { padding: 22px 23px 19px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 14px; }
.output-icon { width: 42px; height: 42px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 13px; background: var(--green-soft); color: var(--green-dark); font-size: 1.15rem; }
.output-title { flex: 1; }
.output-title h3 { margin: 0 0 3px; font-size: 1rem; }
.output-title p { margin: 0; color: var(--muted); font-size: .8rem; }
.output-body { padding: 21px 23px 24px; display: grid; gap: 18px; transition: opacity .2s ease; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.adapter-note { margin: -5px 0 0; color: var(--muted); font-size: .78rem; }
.print-test-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 17px; border-top: 1px solid var(--line); }
.print-test-message { margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.35; }
.print-test-message.success { color: var(--green-dark); }
.print-test-message.error { color: #93401c; }
.print-test-button { flex: 0 0 auto; }
.repricing-heading { margin-top: 40px; }
.repricing-panel { overflow: hidden; margin-bottom: 22px; }
.repricing-copy { padding: 23px 25px 10px; }
.repricing-copy h3 { margin: 0 0 6px; }
.repricing-copy p { margin: 0; color: var(--muted); font-size: .88rem; line-height: 1.5; }
.repricing-rules { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; padding: 15px 25px 21px; }
.money-input { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 7px; }
.money-input > span { font-size: 1rem; color: var(--ink); }
.repricing-options { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 28px; padding: 20px 25px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fbfcf7; }
.repricing-message { margin: 0; padding: 15px 25px; color: var(--muted); font-size: .86rem; }
.repricing-message.error { color: #93401c; background: #fff5f1; }
.repricing-message.success { color: var(--green-dark); background: var(--green-soft); }
.repricing-summary { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 25px; border-top: 1px solid var(--line); }
#repricing-counts { color: var(--muted); font-size: .86rem; font-weight: 700; }
.repricing-actions { display: flex; gap: 9px; }
.repricing-table-wrap { overflow: auto; border-top: 1px solid var(--line); }
.repricing-table { width: 100%; min-width: 920px; border-collapse: collapse; font-size: .83rem; }
.repricing-table th { padding: 11px 12px; background: #f1f3ed; color: var(--muted); text-align: left; font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; }
.repricing-table td { padding: 12px; border-top: 1px solid var(--line); vertical-align: top; }
.repricing-table td:first-child, .repricing-table th:first-child { width: 42px; text-align: center; }
.repricing-table input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--green); }
.card-cell { display: grid; gap: 3px; min-width: 220px; }
.card-cell small, .result-copy { color: var(--muted); line-height: 1.35; }
.price-old { color: var(--muted); }
.price-new { color: var(--green-dark); font-weight: 850; }
.minimum-note { display: block; color: var(--amber); font-size: .72rem; font-weight: 700; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.inventory-heading { margin-top: 40px; }
.inventory-panel { overflow: hidden; margin-bottom: 22px; }
.inventory-copy { padding: 23px 25px 10px; }
.inventory-copy h3 { margin: 0 0 6px; }
.inventory-copy p { margin: 0; color: var(--muted); font-size: .88rem; line-height: 1.5; }
.catalog-search-row { display: grid; grid-template-columns: 1.35fr 1fr auto; align-items: end; gap: 14px; padding: 16px 25px 20px; }
.catalog-results { display: grid; gap: 16px; max-height: 560px; overflow: auto; padding: 0 25px 22px; }
.catalog-section { display: grid; gap: 8px; }
.catalog-section-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding: 2px 2px 0; }
.catalog-section-head h4 { margin: 0; font-size: .9rem; }
.catalog-section-head span { color: var(--muted); font-size: .75rem; }
.catalog-section-list { display: grid; gap: 8px; }
.catalog-result { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 10px 15px 10px 10px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.product-image { display: grid; place-items: center; width: 64px; aspect-ratio: 200 / 279; overflow: hidden; border-radius: 7px; background: #eef0e8; color: var(--muted); font-size: .62rem; text-align: center; }
.product-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
.product-image.missing { padding: 5px; }
.catalog-result-copy { min-width: 0; display: grid; gap: 3px; }
.catalog-result-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-result-copy small, .selected-product small { color: var(--muted); }
.catalog-load-more { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 2px 0; color: var(--muted); font-size: .78rem; }
.inventory-editor { border-top: 1px solid var(--line); }
.selected-product { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 14px; padding: 18px 25px 4px; }
.selected-product-copy { display: grid; gap: 4px; min-width: 0; }
.inventory-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding: 16px 25px 20px; }
.inventory-fields .wide-field { grid-column: span 2; }
.inventory-preview-actions { display: flex; justify-content: flex-end; padding: 0 25px 20px; }
.inventory-preview-result { margin: 0 25px 22px; padding: 16px; border: 1px solid #badcc8; border-radius: 13px; background: var(--green-soft); }
.inventory-preview-result.error { border-color: #efc7b6; background: #fff5f1; }
.preview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 12px; margin-bottom: 12px; }
.preview-stat { display: grid; gap: 3px; }
.preview-stat small { color: var(--muted); }
.preview-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.preview-footer p { margin: 0; color: var(--muted); font-size: .82rem; }
.inventory-queue-settings { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 36px; padding: 20px 25px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fbfcf7; }
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
.status-pill.submitted { background: var(--green-soft); color: var(--green-dark); }
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
  .shell { width: min(100% - 22px, 600px); padding-top: 10px; }
  .tab-list { display: flex; overflow-x: auto; top: 6px; }
  .tab-button { flex: 1 0 auto; min-width: 112px; }
  .general-panel { grid-template-columns: 1fr; gap: 22px; }
  .output-grid { grid-template-columns: 1fr; }
  .queue-settings { grid-template-columns: 1fr; gap: 20px; }
  .repricing-rules { grid-template-columns: 1fr 1fr; }
  .catalog-search-row { grid-template-columns: 1fr 1fr; }
  .catalog-search-row button { grid-column: 1 / -1; }
  .inventory-fields { grid-template-columns: 1fr 1fr; }
  .preview-grid { grid-template-columns: 1fr 1fr; }
  .inventory-queue-settings { grid-template-columns: 1fr; gap: 20px; }
  .repricing-options { grid-template-columns: 1fr; }
  .repricing-summary { align-items: stretch; flex-direction: column; }
  .repricing-actions { justify-content: flex-end; }
  .queue-form-grid { grid-template-columns: 1fr 1fr; }
  .queue-form-grid .wide-field { grid-column: span 2; }
  .queue-job { grid-template-columns: minmax(0, 1fr) auto; }
  .queue-job .cancel-job { grid-column: 1 / -1; justify-self: end; }
  .inventory-fields .wide-field { grid-column: span 1; }
  .preview-footer { align-items: stretch; flex-direction: column; }
  .save-bar { bottom: 10px; width: calc(100% - 20px); }
  .save-bar span { display: none; }
}
`;

export const CONFIG_UI_JS = String.raw`(() => {
  "use strict";
  const state = {
    settings: null,
    savedSettingsFingerprint: null,
    repricingPreview: null,
    inventoryProduct: null,
    inventoryPreview: null,
    catalogSearch: null,
    catalogSearchToken: 0,
    catalogSearchController: null,
  };
  const inventoryShippingStorageKey = "tcgplayer-alert.inventory-shipping";
  const activeTabStorageKey = "tcgplayer-alert.active-tab";
  const tabIds = ["automation", "add-cards", "repricing", "jobs"];
  const form = document.querySelector("#settings-form");
  const outputs = document.querySelector("#outputs");
  const fatal = document.querySelector("#fatal-error");
  const fatalMessage = document.querySelector("#fatal-message");
  const printerNote = document.querySelector("#printer-note");
  const saveButton = document.querySelector("#save-button");
  const saveBar = document.querySelector("#save-bar");
  const saveTitle = document.querySelector("#save-title");
  const saveDetail = document.querySelector("#save-detail");

  function isTabId(value) {
    return tabIds.includes(value);
  }

  function activateTab(tabId, updateHistory = false, focusTab = false) {
    const selectedTab = isTabId(tabId) ? tabId : "automation";
    for (const button of document.querySelectorAll('[role="tab"][data-tab]')) {
      const selected = button.dataset.tab === selectedTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) button.focus();
    }
    for (const panel of document.querySelectorAll('[role="tabpanel"][data-panel]')) {
      panel.hidden = panel.dataset.panel !== selectedTab;
    }
    try {
      window.localStorage.setItem(activeTabStorageKey, selectedTab);
    } catch {
      // Tab navigation remains usable when browser storage is unavailable.
    }
    const nextHash = "#" + selectedTab;
    if (window.location.hash !== nextHash) {
      const url = window.location.pathname + window.location.search + nextHash;
      if (updateHistory) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    }
  }

  function initialTab() {
    const hashTab = window.location.hash.slice(1);
    if (isTabId(hashTab)) return hashTab;
    try {
      const stored = window.localStorage.getItem(activeTabStorageKey);
      if (isTabId(stored)) return stored;
    } catch {
      // Automation remains the default when browser storage is unavailable.
    }
    return "automation";
  }

  function selectLocationTab() {
    const hashTab = window.location.hash.slice(1);
    activateTab(isTabId(hashTab) ? hashTab : "automation");
  }

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
    const testMessage = el("p", {
      className: "print-test-message",
      text: "Synthetic data only. This sends a real print job.",
      "aria-live": "polite",
    });
    const testButton = el("button", {
      className: "quiet-button print-test-button",
      type: "button",
      text: isAddress ? "Print test label" : "Print test sheet",
    });
    testButton.addEventListener("click", () => runPrintTest(output, testButton, testMessage));
    body.append(el("div", { className: "print-test-row" }, [testMessage, testButton]));
    card.append(body);
    const updateDisabled = () => card.classList.toggle("disabled", !enabled.checked);
    enabled.addEventListener("change", updateDisabled);
    updateDisabled();
    return card;
  }

  async function runPrintTest(output, button, message) {
    if (!form.reportValidity()) return;
    const idleText = output.type === "print-address-label" ? "Print test label" : "Print test sheet";
    const outputName = output.type === "print-address-label" ? "label" : "sheet";
    const card = form.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"]');
    const printerName = card.querySelector('[name="printerName"]').value;
    button.disabled = true;
    button.textContent = "Sendingâ€¦";
    message.className = "print-test-message";
    message.textContent = "Sending synthetic " + outputName + " to the printerâ€¦";
    try {
      const response = await fetch("/api/print-tests/" + encodeURIComponent(output.actionId), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(collectSettingsUpdate()),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error((data.issues || []).join(" ") || data.message || "The test job could not be printed.");
      }
      message.className = "print-test-message success";
      message.textContent = "Synthetic test " + outputName + " sent to " + printerName + ".";
    } catch (error) {
      message.className = "print-test-message error";
      message.textContent = error instanceof Error ? error.message : "The test job could not be printed.";
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

  function render() {
    document.querySelector("#poll-interval").value = String(state.settings.pollIntervalMinutes);
    document.querySelector("#dry-run").checked = state.settings.dryRun;
    document.querySelector("#price-queue-enabled").checked = state.settings.priceUpdateQueue.enabled;
    document.querySelector("#price-delay").value = String(state.settings.priceUpdateQueue.delaySeconds);
    document.querySelector("#inventory-queue-enabled").checked = state.settings.inventoryAdditionQueue.enabled;
    document.querySelector("#inventory-delay").value = String(state.settings.inventoryAdditionQueue.delaySeconds);
    outputs.replaceChildren(...state.settings.outputs.map(renderOutput));
    state.savedSettingsFingerprint = settingsFingerprint();
    updateSaveBarVisibility();
    printerNote.hidden = !state.settings.discoveryIssue;
    printerNote.textContent = state.settings.discoveryIssue || "";
    fatal.hidden = true;
    form.hidden = false;
    void loadQueue();
    void loadInventoryQueue();
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

  const money = (value) => "$" + Number(value).toFixed(2);

  function productImage(product) {
    const image = el("img", {
      src: product.imageUrl,
      alt: "",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    });
    const frame = el("div", { className: "product-image" }, [image]);
    image.addEventListener("error", () => {
      frame.classList.add("missing");
      frame.replaceChildren(el("span", { text: "No image" }));
    }, { once: true });
    return frame;
  }

  function catalogResult(product) {
    const choose = el("button", { className: "quiet-button", type: "button", text: "Choose" });
    choose.addEventListener("click", () => selectCatalogProduct(product.productId));
    return el("div", { className: "catalog-result" }, [
      productImage(product),
      el("div", { className: "catalog-result-copy" }, [
        el("strong", { text: product.productName }),
        el("small", { text: product.productLineName + " / " + product.setName }),
        el("small", { text: (product.cardNumber ? "#" + product.cardNumber + " / " : "") + (product.rarityName || "No rarity") + " / market " + money(product.marketPrice) }),
      ]),
      choose,
    ]);
  }

  const catalogMatchOrder = { exact: 0, variant: 1, related: 2 };

  function sortLoadedCatalogProducts(products) {
    return [...new Map(products.map((product) => [product.productId, product])).values()].sort((left, right) => {
      const categoryDifference = catalogMatchOrder[left.matchKind] - catalogMatchOrder[right.matchKind];
      if (categoryDifference !== 0) return categoryDifference;
      if (left.matchKind === "related" && right.matchKind === "related") {
        return left.loadedOrder - right.loadedOrder;
      }
      return left.productName.localeCompare(right.productName)
        || left.productLineName.localeCompare(right.productLineName)
        || left.setName.localeCompare(right.setName)
        || left.cardNumber.localeCompare(right.cardNumber)
        || left.productId - right.productId;
    });
  }

  function catalogSection(title, description, products) {
    if (products.length === 0) return null;
    return el("section", { className: "catalog-section", "aria-label": title }, [
      el("div", { className: "catalog-section-head" }, [
        el("div", {}, [el("h4", { text: title }), el("span", { text: description })]),
        el("span", { text: String(products.length) + " loaded" }),
      ]),
      el("div", { className: "catalog-section-list" }, products.map(catalogResult)),
    ]);
  }

  function updateCatalogProductLineSuggestions(products, selectedProductLine) {
    const names = distinct(products.map((product) => product.productLineName)).sort((left, right) => left.localeCompare(right));
    if (selectedProductLine && !names.includes(selectedProductLine)) names.unshift(selectedProductLine);
    document.querySelector("#catalog-product-lines").replaceChildren(
      ...names.map((name) => el("option", { value: name })),
    );
  }

  function renderCatalogSearch() {
    const search = state.catalogSearch;
    const message = document.querySelector("#inventory-message");
    const results = document.querySelector("#catalog-results");
    const exact = search.products.filter((product) => product.matchKind === "exact");
    const variants = search.products.filter((product) => product.matchKind === "variant");
    const related = search.products.filter((product) => product.matchKind === "related");
    const sections = [
      catalogSection("Exact name", "Every loaded set and printing with the same normalized name.", exact),
      catalogSection("Name variants", "Qualified or extended versions of the searched name.", variants),
      catalogSection("Related results", "Broader fuzzy matches returned by TCGplayer.", related),
    ].filter(Boolean);
    if (sections.length === 0) {
      sections.push(el("div", { className: "queue-empty", text: "No products matched this search and product line." }));
    }
    if (search.hasMore) {
      const loadMore = el("button", { id: "catalog-load-more", className: "quiet-button", type: "button", text: "Load more" });
      loadMore.addEventListener("click", () => void searchCatalog(true, loadMore));
      sections.push(el("div", { className: "catalog-load-more" }, [
        el("span", { text: "Scanned " + search.nextOffset + " of " + search.totalProducts + " TCGplayer matches." }),
        loadMore,
      ]));
    }
    results.replaceChildren(...sections);
    results.hidden = false;
    updateCatalogProductLineSuggestions(search.products, search.productLine);
    message.className = "repricing-message success";
    const exactSummary = exact.length === 0
      ? "No exact-name printing is loaded yet."
      : String(exact.length) + (exact.length === 1 ? " exact-name printing loaded." : " exact-name printings loaded.");
    message.textContent = "Showing " + search.products.length + " unique products after scanning " + search.nextOffset + " of " + search.totalProducts + " TCGplayer matches. " + exactSummary;
  }

  async function searchCatalog(append = false, triggerButton) {
    const current = state.catalogSearch;
    const query = append && current ? current.query : document.querySelector("#catalog-query").value.trim();
    const productLine = append && current ? current.productLine : document.querySelector("#catalog-product-line").value.trim();
    const offset = append && current ? current.nextOffset : 0;
    const message = document.querySelector("#inventory-message");
    const results = document.querySelector("#catalog-results");
    const requestToken = state.catalogSearchToken + 1;
    state.catalogSearchToken = requestToken;
    state.catalogSearchController?.abort();
    state.catalogSearchController = null;
    if (query.length < 2) {
      message.className = "repricing-message error";
      message.textContent = "Enter at least two characters of the card name.";
      return;
    }
    const button = triggerButton || document.querySelector("#catalog-search");
    const idleText = append ? "Load more" : "Search catalog";
    const requestController = new AbortController();
    state.catalogSearchController = requestController;
    button.disabled = true;
    button.textContent = append ? "Loading..." : "Searching...";
    message.className = "repricing-message";
    message.textContent = append ? "Loading the next catalog page..." : "Searching TCGplayer and expanding only when exact results are scarce...";
    if (!append) {
      state.catalogSearch = null;
      state.inventoryProduct = null;
      state.inventoryPreview = null;
      results.hidden = true;
      document.querySelector("#inventory-editor").hidden = true;
      document.querySelector("#inventory-preview-result").hidden = true;
    }
    try {
      const parameters = new URLSearchParams({ q: query, offset: String(offset) });
      if (productLine) parameters.set("productLine", productLine);
      const response = await fetch("/api/catalog/search?" + parameters.toString(), {
        headers: { Accept: "application/json" },
        signal: requestController.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Catalog search failed.");
      if (requestToken !== state.catalogSearchToken) return;
      const existing = append && current ? current.products : [];
      const loadedOrderStart = existing.reduce((maximum, product) => Math.max(maximum, product.loadedOrder), -1) + 1;
      const received = data.products.map((product, index) => ({ ...product, loadedOrder: loadedOrderStart + index }));
      state.catalogSearch = {
        query,
        productLine,
        totalProducts: data.totalProducts,
        nextOffset: data.nextOffset,
        hasMore: data.hasMore,
        products: sortLoadedCatalogProducts([...existing, ...received]),
      };
      renderCatalogSearch();
    } catch (error) {
      if (requestToken !== state.catalogSearchToken) return;
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "Catalog search failed.";
    } finally {
      if (state.catalogSearchController === requestController) {
        state.catalogSearchController = null;
      }
      if (requestToken === state.catalogSearchToken) {
        button.disabled = false;
        button.textContent = idleText;
      }
    }
  }

  const inventoryConditionOrder = [
    "Near Mint",
    "Lightly Played",
    "Moderately Played",
    "Heavily Played",
    "Damaged",
    "Unopened",
  ];

  const distinct = (values) => [...new Set(values)];

  function sortedInventoryValues(values, preferred, orderedValues = []) {
    return distinct(values).sort((left, right) => {
      if (left === preferred) return -1;
      if (right === preferred) return 1;
      const leftOrder = orderedValues.indexOf(left);
      const rightOrder = orderedValues.indexOf(right);
      if (leftOrder >= 0 || rightOrder >= 0) {
        if (leftOrder < 0) return 1;
        if (rightOrder < 0) return -1;
        return leftOrder - rightOrder;
      }
      return left.localeCompare(right);
    });
  }

  function replaceInventoryOptions(select, values, preferred) {
    const previous = select.value;
    select.replaceChildren(...values.map((value) => el("option", { value, text: value })));
    if (values.includes(preferred)) select.value = preferred;
    else if (values.includes(previous)) select.value = previous;
  }

  function refreshInventoryLanguages(preferred = "English") {
    const product = state.inventoryProduct;
    if (!product) return;
    const condition = document.querySelector("#inventory-card-condition").value;
    const printing = document.querySelector("#inventory-printing").value;
    const languages = sortedInventoryValues(
      product.skus
        .filter((sku) => sku.condition === condition && sku.printing === printing)
        .map((sku) => sku.language),
      preferred,
    );
    replaceInventoryOptions(document.querySelector("#inventory-language"), languages, preferred);
  }

  function refreshInventoryPrintings(preferred = "Normal") {
    const product = state.inventoryProduct;
    if (!product) return;
    const condition = document.querySelector("#inventory-card-condition").value;
    const printings = sortedInventoryValues(
      product.skus.filter((sku) => sku.condition === condition).map((sku) => sku.printing),
      preferred,
    );
    replaceInventoryOptions(document.querySelector("#inventory-printing"), printings, preferred);
    refreshInventoryLanguages("English");
  }

  function initializeInventorySkuSelectors() {
    const product = state.inventoryProduct;
    if (!product) return;
    const conditions = sortedInventoryValues(
      product.skus.map((sku) => sku.condition),
      "Near Mint",
      inventoryConditionOrder,
    );
    replaceInventoryOptions(document.querySelector("#inventory-card-condition"), conditions, "Near Mint");
    refreshInventoryPrintings("Normal");
  }

  function selectedInventorySku() {
    const product = state.inventoryProduct;
    if (!product) return undefined;
    const condition = document.querySelector("#inventory-card-condition").value;
    const printing = document.querySelector("#inventory-printing").value;
    const language = document.querySelector("#inventory-language").value;
    return product.skus.find(
      (sku) => sku.condition === condition && sku.printing === printing && sku.language === language,
    );
  }

  function invalidateInventoryPreview() {
    state.inventoryPreview = null;
    document.querySelector("#inventory-preview-result").hidden = true;
  }

  function restoreInventoryShippingPreference() {
    const input = document.querySelector("#inventory-shipping");
    try {
      const stored = window.localStorage.getItem(inventoryShippingStorageKey);
      if (stored === null || stored === "") return;
      const value = Number(stored);
      if (!Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) return;
      input.value = stored;
    } catch {
      // Browser storage can be unavailable; the field remains usable for this session.
    }
  }

  function persistInventoryShippingPreference() {
    const input = document.querySelector("#inventory-shipping");
    if (input.value === "" || !input.checkValidity()) return;
    try {
      window.localStorage.setItem(inventoryShippingStorageKey, input.value);
    } catch {
      // Browser storage can be unavailable; pricing still uses the current field value.
    }
  }

  async function selectCatalogProduct(productId) {
    const message = document.querySelector("#inventory-message");
    message.className = "repricing-message";
    message.textContent = "Loading the available condition, printing, and language combinations...";
    try {
      const response = await fetch("/api/catalog/products/" + encodeURIComponent(productId), { headers: { Accept: "application/json" } });
      const product = await response.json();
      if (!response.ok) throw new Error(product.message || "Product details could not be loaded.");
      state.inventoryProduct = product;
      state.inventoryPreview = null;
      initializeInventorySkuSelectors();
      document.querySelector("#selected-product").replaceChildren(
        productImage(product),
        el("div", { className: "selected-product-copy" }, [
          el("strong", { text: product.productName }),
          el("small", { text: product.productLineName + " / " + product.setName + (product.cardNumber ? " / #" + product.cardNumber : "") }),
        ]),
      );
      document.querySelector("#inventory-editor").hidden = false;
      document.querySelector("#inventory-preview-result").hidden = true;
      message.className = "repricing-message success";
      message.textContent = "Exact product selected. Choose its condition, printing, language, and pricing rules, then preview.";
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "Product details could not be loaded.";
    }
  }

  function inventoryPricingRules() {
    const fallback = document.querySelector("#inventory-fallback").value;
    return {
      minimumPrice: Number(document.querySelector("#inventory-minimum").value),
      conditionPolicy: document.querySelector("#inventory-condition").value,
      priceBasis: document.querySelector("#inventory-basis").value,
      adjustmentCents: Number(document.querySelector("#inventory-adjustment").value),
      estimatedShippingPrice: Number(document.querySelector("#inventory-shipping").value),
      noComparisonFallback: fallback,
      ...(fallback === "manual" ? { manualPrice: Number(document.querySelector("#inventory-manual-price").value) } : {}),
    };
  }

  function renderInventoryPreview(preview) {
    state.inventoryPreview = preview;
    const container = document.querySelector("#inventory-preview-result");
    const competitor = preview.competitorPrice === undefined
      ? "Fallback"
      : money(preview.competitorPrice) + (preview.competitorShipping > 0 ? " + " + money(preview.competitorShipping) + " competitor shipping" : "") + " / " + preview.competitorCondition;
    const effectiveShipping = preview.effectiveShippingPrice === undefined
      ? "-"
      : money(preview.effectiveShippingPrice) + (preview.effectiveShippingPrice !== preview.rules.estimatedShippingPrice ? " (from " + money(preview.rules.estimatedShippingPrice) + " setting)" : "");
    const queue = el("button", {
      id: "queue-inventory-addition",
      className: "primary-button dark-button",
      type: "button",
      text: "Queue card addition",
    });
    queue.disabled = !preview.queueable;
    queue.addEventListener("click", queueInventoryAddition);
    container.className = "inventory-preview-result" + (preview.queueable ? "" : " error");
    container.replaceChildren(
      el("div", { className: "preview-grid" }, [
        el("div", { className: "preview-stat" }, [el("small", { text: "Add quantity" }), el("strong", { text: String(preview.addQuantity) })]),
        el("div", { className: "preview-stat" }, [el("small", { text: "Current quantity" }), el("strong", { text: String(preview.currentQuantity) })]),
        el("div", { className: "preview-stat" }, [el("small", { text: "Qualifying match" }), el("strong", { text: competitor })]),
        el("div", { className: "preview-stat" }, [el("small", { text: "Initial item price" }), el("strong", { text: preview.proposedPrice === undefined ? "-" : money(preview.proposedPrice) })]),
        el("div", { className: "preview-stat" }, [el("small", { text: "Your effective shipping" }), el("strong", { text: effectiveShipping })]),
        el("div", { className: "preview-stat" }, [el("small", { text: "Your delivered price" }), el("strong", { text: preview.proposedDeliveredPrice === undefined ? "-" : money(preview.proposedDeliveredPrice) })]),
      ]),
      el("div", { className: "preview-footer" }, [el("p", { text: preview.reason }), queue]),
    );
    container.hidden = false;
  }

  async function previewInventoryAddition() {
    if (!state.inventoryProduct) return;
    const message = document.querySelector("#inventory-message");
    const sku = selectedInventorySku();
    if (!sku) {
      message.className = "repricing-message error";
      message.textContent = "Choose a valid condition, printing, and language combination.";
      return;
    }
    const button = document.querySelector("#inventory-preview");
    button.disabled = true;
    button.textContent = "Calculating...";
    message.className = "repricing-message";
    message.textContent = "Reading current inventory and qualifying marketplace prices...";
    try {
      const response = await fetch("/api/inventory-additions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          productId: state.inventoryProduct.productId,
          productConditionId: sku.productConditionId,
          addQuantity: Number(document.querySelector("#inventory-quantity").value),
          rules: inventoryPricingRules(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The inventory preview failed.");
      renderInventoryPreview(data);
      message.className = data.queueable ? "repricing-message success" : "repricing-message error";
      message.textContent = data.queueable ? "Preview ready. Verify the exact SKU, quantity, and initial price before queueing." : data.reason;
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "The inventory preview failed.";
    } finally {
      button.disabled = false;
      button.textContent = "Preview addition";
    }
  }

  async function queueInventoryAddition() {
    const preview = state.inventoryPreview;
    if (!preview) return;
    const message = document.querySelector("#inventory-message");
    try {
      const response = await fetch("/api/inventory-additions/previews/" + encodeURIComponent(preview.id) + "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The card was not queued.");
      state.inventoryPreview = null;
      document.querySelector("#inventory-preview-result").hidden = true;
      message.className = "repricing-message success";
      message.textContent = "Card addition queued. The worker will recheck live quantity before submitting quantity and price together.";
      await loadInventoryQueue();
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "The card was not queued.";
    }
  }

  function inventoryQueueJob(job) {
    const copy = el("div", { className: "queue-job-copy" }, [
      el("strong", { text: job.addition.productName }),
      el("small", { text: "Add " + job.addition.addQuantity + " / SKU " + job.addition.productConditionId + " / " + money(job.addition.price) + " / attempt " + job.attempts }),
    ]);
    const status = el("span", { className: "status-pill " + job.status, text: job.status.replace("-", " ") });
    const children = [copy, status];
    if (job.status === "pending") {
      const cancel = el("button", { className: "cancel-job", type: "button", text: "Cancel" });
      cancel.addEventListener("click", () => cancelInventoryJob(job.id));
      children.push(cancel);
    }
    return el("div", { className: "queue-job" }, children);
  }

  async function loadInventoryQueue() {
    try {
      const response = await fetch("/api/inventory-additions", { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Inventory queue unavailable.");
      const jobs = data.jobs.slice(0, 50);
      document.querySelector("#inventory-queue-jobs").replaceChildren(
        ...(jobs.length === 0
          ? [el("div", { className: "queue-empty", text: data.workerRunning ? "No card additions queued." : "No additions yet. Start the service to process queued cards." })]
          : jobs.map(inventoryQueueJob)),
      );
    } catch (error) {
      document.querySelector("#inventory-queue-jobs").replaceChildren(
        el("div", { className: "queue-empty", text: error instanceof Error ? error.message : "Inventory queue unavailable." }),
      );
    }
  }

  async function cancelInventoryJob(jobId) {
    const response = await fetch("/api/inventory-additions/" + encodeURIComponent(jobId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) {
      const message = document.querySelector("#inventory-message");
      message.className = "repricing-message error";
      message.textContent = data.message || "The addition could not be canceled.";
    }
    await loadInventoryQueue();
  }

  function renderRepricingRow(row) {
    const checkbox = el("input", {
      type: "checkbox",
      "data-row-id": row.id,
      "aria-label": "Select " + row.productName,
    });
    checkbox.checked = row.queueable;
    checkbox.disabled = !row.queueable;
    const competitor = row.competitorPrice === undefined
      ? "—"
      : money(row.competitorPrice) + (row.competitorShipping > 0 ? " + " + money(row.competitorShipping) + " shipping" : "") + " · " + row.competitorCondition;
    const proposed = el("td", {}, [
      el("span", { className: row.queueable ? "price-new" : "price-old", text: money(row.proposedPrice) }),
    ]);
    if (row.minimumApplied) proposed.append(el("span", { className: "minimum-note", text: "minimum applied" }));
    return el("tr", {}, [
      el("td", {}, [checkbox]),
      el("td", {}, [el("div", { className: "card-cell" }, [
        el("strong", { text: row.productName }),
        el("small", { text: row.productLineName + " · " + row.setName }),
        el("small", { text: row.printing + " · " + row.language + " · qty " + row.quantity }),
      ])]),
      el("td", { text: row.condition }),
      el("td", { className: "price-old", text: money(row.currentPrice) }),
      el("td", { text: competitor }),
      proposed,
      el("td", {}, [
        el("span", { className: "status-pill " + row.status, text: row.status }),
        el("div", { className: "result-copy", text: row.reason }),
      ]),
    ]);
  }

  function renderRepricingPreview(preview) {
    state.repricingPreview = preview;
    document.querySelector("#repricing-counts").textContent =
      preview.counts.ready + " changes · " + preview.counts.unchanged + " unchanged · " + preview.counts.skipped + " skipped";
    document.querySelector("#repricing-rows").replaceChildren(...preview.rows.map(renderRepricingRow));
    document.querySelector("#repricing-results").hidden = false;
    document.querySelector("#repricing-queue").disabled = preview.counts.ready === 0;
  }

  function repricingRules() {
    return {
      minimumPrice: Number(document.querySelector("#repricing-minimum").value),
      conditionPolicy: document.querySelector("#repricing-condition").value,
      priceBasis: document.querySelector("#repricing-basis").value,
      adjustmentCents: Number(document.querySelector("#repricing-adjustment").value),
      allowPriceIncreases: document.querySelector("#repricing-allow-increases").checked,
    };
  }

  async function previewRepricing() {
    const button = document.querySelector("#repricing-preview");
    const message = document.querySelector("#repricing-message");
    button.disabled = true;
    button.textContent = "Loading inventory…";
    message.className = "repricing-message";
    message.textContent = "Reading your live listings and qualifying marketplace prices. This can take a moment.";
    try {
      const response = await fetch("/api/repricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(repricingRules()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The preview could not be created.");
      renderRepricingPreview(data);
      message.className = "repricing-message success";
      message.textContent = "Preview ready. Review the proposed prices, then queue only the rows you want.";
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "The preview could not be created.";
    } finally {
      button.disabled = false;
      button.textContent = "Refresh inventory & preview";
    }
  }

  async function queueRepricingSelection() {
    const preview = state.repricingPreview;
    if (!preview) return;
    const button = document.querySelector("#repricing-queue");
    const message = document.querySelector("#repricing-message");
    const rowIds = [...document.querySelectorAll('#repricing-rows input[type="checkbox"]:checked')].map((checkbox) => checkbox.dataset.rowId);
    if (rowIds.length === 0) {
      message.className = "repricing-message error";
      message.textContent = "Select at least one proposed change.";
      return;
    }
    button.disabled = true;
    message.className = "repricing-message";
    message.textContent = "Adding " + rowIds.length + " price " + (rowIds.length === 1 ? "change" : "changes") + " to the queue…";
    try {
      const response = await fetch("/api/repricing/previews/" + encodeURIComponent(preview.id) + "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ rowIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The changes were not queued.");
      message.className = "repricing-message success";
      message.textContent = data.jobs.length + " price " + (data.jobs.length === 1 ? "change is" : "changes are") + " queued. The worker processes the next one as soon as the previous request finishes.";
      state.repricingPreview = null;
      document.querySelector("#repricing-results").hidden = true;
      await loadQueue();
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "The changes were not queued.";
      button.disabled = false;
    }
  }

  async function loadQueue() {
    try {
      const response = await fetch("/api/price-updates", { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Queue unavailable.");
      const jobs = data.jobs.slice(0, 50);
      document.querySelector("#queue-jobs").replaceChildren(
        ...(jobs.length === 0
          ? [el("div", { className: "queue-empty", text: data.workerRunning ? "No price updates queued." : "No jobs yet. Start the service to process new jobs." })]
          : jobs.map(queueJob)),
      );
    } catch (error) {
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
      const message = document.querySelector("#repricing-message");
      message.className = "repricing-message error";
      message.textContent = data.message || "The job could not be canceled.";
    }
    await loadQueue();
  }

  async function load() {
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

  function collectSettingsUpdate() {
    return {
      revision: state.settings.revision,
      pollIntervalMinutes: Number(document.querySelector("#poll-interval").value),
      dryRun: document.querySelector("#dry-run").checked,
      priceUpdateQueue: {
        enabled: document.querySelector("#price-queue-enabled").checked,
        delaySeconds: Number(document.querySelector("#price-delay").value),
      },
      inventoryAdditionQueue: {
        enabled: document.querySelector("#inventory-queue-enabled").checked,
        delaySeconds: Number(document.querySelector("#inventory-delay").value),
      },
      outputs: state.settings.outputs.map((output) => {
        const card = form.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"]');
        return collectOutput(card, output);
      }),
    };
  }

  function settingsFingerprint() {
    return JSON.stringify(collectSettingsUpdate());
  }

  function updateSaveBarVisibility() {
    if (state.settings === null || state.savedSettingsFingerprint === null) {
      saveBar.hidden = true;
      return;
    }
    const hasUnsavedChanges = settingsFingerprint() !== state.savedSettingsFingerprint;
    saveBar.hidden = !hasUnsavedChanges;
    if (hasUnsavedChanges) {
      saveTitle.textContent = "Unsaved changes";
      saveDetail.textContent = "Save to update automation and worker settings.";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    saveTitle.textContent = "Validating settings";
    const payload = collectSettingsUpdate();
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

  form.addEventListener("input", updateSaveBarVisibility);
  form.addEventListener("change", updateSaveBarVisibility);

  document.querySelector("#refresh-printers").addEventListener("click", load);
  document.querySelector("#refresh-queue").addEventListener("click", loadQueue);
  document.querySelector("#refresh-inventory-queue").addEventListener("click", loadInventoryQueue);
  document.querySelector("#catalog-search").addEventListener("click", () => void searchCatalog());
  for (const selector of ["#catalog-query", "#catalog-product-line"]) {
    document.querySelector(selector).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void searchCatalog();
      }
    });
  }
  document.querySelector("#inventory-preview").addEventListener("click", previewInventoryAddition);
  document.querySelector("#inventory-card-condition").addEventListener("change", () => {
    invalidateInventoryPreview();
    refreshInventoryPrintings("Normal");
  });
  document.querySelector("#inventory-printing").addEventListener("change", () => {
    invalidateInventoryPreview();
    refreshInventoryLanguages("English");
  });
  document.querySelector("#inventory-language").addEventListener("change", invalidateInventoryPreview);
  for (const selector of ["#inventory-quantity", "#inventory-minimum", "#inventory-condition", "#inventory-basis", "#inventory-adjustment", "#inventory-fallback", "#inventory-manual-price"]) {
    document.querySelector(selector).addEventListener("input", invalidateInventoryPreview);
  }
  document.querySelector("#inventory-shipping").addEventListener("input", () => {
    persistInventoryShippingPreference();
    invalidateInventoryPreview();
  });
  document.querySelector("#inventory-fallback").addEventListener("change", (event) => {
    document.querySelector("#inventory-manual-field").hidden = event.target.value !== "manual";
  });
  document.querySelector("#repricing-preview").addEventListener("click", previewRepricing);
  document.querySelector("#repricing-queue").addEventListener("click", queueRepricingSelection);
  document.querySelector("#repricing-select-all").addEventListener("click", () => {
    for (const checkbox of document.querySelectorAll('#repricing-rows input[type="checkbox"]:not(:disabled)')) checkbox.checked = true;
  });
  const tabList = document.querySelector('[role="tablist"]');
  for (const button of tabList.querySelectorAll('[role="tab"][data-tab]')) {
    button.addEventListener("click", () => activateTab(button.dataset.tab, true));
  }
  tabList.addEventListener("keydown", (event) => {
    const current = event.target.closest('[role="tab"][data-tab]');
    if (!current) return;
    const currentIndex = tabIds.indexOf(current.dataset.tab);
    let nextIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabIds.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabIds.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabIds[nextIndex], true, true);
  });
  window.addEventListener("popstate", selectLocationTab);
  window.addEventListener("hashchange", selectLocationTab);
  document.querySelector("#retry").addEventListener("click", load);
  restoreInventoryShippingPreference();
  activateTab(initialTab());
  load();
  setInterval(loadQueue, 5000);
  setInterval(loadInventoryQueue, 5000);
})();`;
