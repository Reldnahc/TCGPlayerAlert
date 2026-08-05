export const CONFIG_UI_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TCGPlayerAlert</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="shell">
      <main>
        <form id="settings-form" hidden>
          <nav class="tab-list" role="tablist" aria-label="Workspace sections">
            <button id="tab-dashboard" class="tab-button" type="button" role="tab" aria-controls="panel-dashboard" aria-selected="true" tabindex="0" data-tab="dashboard">Dashboard</button>
            <button id="tab-orders" class="tab-button" type="button" role="tab" aria-controls="panel-orders" aria-selected="false" tabindex="-1" data-tab="orders">Orders</button>
            <button id="tab-add-cards" class="tab-button" type="button" role="tab" aria-controls="panel-add-cards" aria-selected="false" tabindex="-1" data-tab="add-cards">Add cards</button>
            <button id="tab-inventory" class="tab-button" type="button" role="tab" aria-controls="panel-inventory" aria-selected="false" tabindex="-1" data-tab="inventory">Inventory</button>
            <button id="tab-settings" class="tab-button" type="button" role="tab" aria-controls="panel-settings" aria-selected="false" tabindex="-1" data-tab="settings">Settings</button>
            <button id="tab-jobs" class="tab-button" type="button" role="tab" aria-controls="panel-jobs" aria-selected="false" tabindex="-1" data-tab="jobs">Jobs</button>
          </nav>

          <div id="panel-dashboard" class="tab-panel" role="tabpanel" aria-labelledby="tab-dashboard" tabindex="0" data-panel="dashboard">
          <div class="section-heading first-heading">
            <div><h2 id="dashboard-automation-title">Automation</h2></div>
          </div>
          <section id="dashboard-automation-controls" class="panel dashboard-automation" aria-labelledby="dashboard-automation-title"></section>

          <div class="section-heading">
            <div><h2 id="dashboard-orders-title">Ready to ship</h2></div>
            <button id="refresh-dashboard-orders" class="quiet-button" type="button">Refresh</button>
          </div>
          <section class="panel order-panel" aria-labelledby="dashboard-orders-title">
            <p id="dashboard-orders-message" class="order-message" aria-live="polite"></p>
            <div class="order-table-wrap">
              <table class="order-table dashboard-order-table">
                <thead><tr><th>Buyer</th><th>Order date</th><th>Shipping type</th><th>Total</th><th>Pirate Ship</th><th>Add tracking</th><th>Mark shipped</th></tr></thead>
                <tbody id="dashboard-order-rows"></tbody>
              </table>
            </div>
          </section>
          </div>

          <div id="panel-orders" class="tab-panel" role="tabpanel" aria-labelledby="tab-orders" tabindex="0" data-panel="orders" hidden>
          <div class="section-heading first-heading">
            <div><h2 id="orders-title">Orders</h2></div>
            <button id="refresh-orders" class="quiet-button" type="button">Refresh</button>
          </div>
          <section class="panel order-panel" aria-labelledby="orders-title">
            <p id="orders-message" class="order-message" aria-live="polite"></p>
            <div class="order-table-wrap">
              <table class="order-table full-order-table">
                <thead><tr><th>Order #</th><th>Buyer</th><th>Order date</th><th>Status</th><th>Shipping type</th><th>Products</th><th>Shipping</th><th>Total</th><th>Actions</th></tr></thead>
                <tbody id="order-rows"></tbody>
              </table>
            </div>
          </section>
          </div>

          <div id="panel-settings" class="tab-panel" role="tabpanel" aria-labelledby="tab-settings" tabindex="0" data-panel="settings" hidden>
          <section class="panel general-panel" aria-labelledby="general-title">
            <div>
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
                <small>Prevents printing and remote changes.</small>
              </span>
              <input id="dry-run" type="checkbox" />
              <span class="switch" aria-hidden="true"></span>
            </label>
          </section>

          <div class="section-heading">
            <div>
              <h2 id="repricing-profiles-title">Repricing profiles</h2>
            </div>
            <button id="add-repricing-profile" class="quiet-button" type="button">Add profile</button>
          </div>
          <section class="panel profile-settings-panel" aria-labelledby="repricing-profiles-title">
            <p class="profile-help">Value ranges can price from the lowest listing or market, and decide whether to wait out a separated low listing.</p>
            <div id="repricing-profile-list" class="profile-list"></div>
          </section>

          <div class="section-heading">
            <div>
              <h2 id="merchandise-profiles-title">Merchandise profiles</h2>
            </div>
            <button id="add-merchandise-profile" class="quiet-button" type="button">Add profile</button>
          </div>
          <section class="panel profile-settings-panel" aria-labelledby="merchandise-profiles-title">
            <p class="profile-help">For items under $5, effective shipping is at least $1.49.</p>
            <div id="merchandise-profile-list" class="profile-list"></div>
          </section>

          <div class="section-heading">
            <div>
              <h2>Printing</h2>
            </div>
            <button id="refresh-printers" class="quiet-button" type="button">Refresh printers</button>
          </div>
          <p id="printer-note" class="printer-note" hidden></p>
          <div id="outputs" class="output-grid"></div>

          <div class="section-heading">
            <div>
              <h2 id="worker-settings-title">Processing</h2>
            </div>
          </div>
          <section class="panel worker-settings-panel" aria-labelledby="worker-settings-title">
            <div class="inventory-queue-settings">
              <label class="switch-row">
                <span><strong>Process added cards</strong></span>
                <input id="inventory-queue-enabled" type="checkbox" />
                <span class="switch" aria-hidden="true"></span>
              </label>
              <label class="field compact-field"><span>Cooldown after each addition</span><span class="input-with-unit"><input id="inventory-delay" type="number" min="0" max="3600" required /><span>seconds</span></span></label>
            </div>
            <div class="queue-settings">
              <label class="switch-row">
                <span>
                  <strong>Process queued prices</strong>
                </span>
                <input id="price-queue-enabled" type="checkbox" />
                <span class="switch" aria-hidden="true"></span>
              </label>
              <label class="field compact-field">
                <span>Cooldown after each accepted update</span>
                <span class="input-with-unit">
                  <input id="price-delay" type="number" min="0" max="3600" required />
                  <span>seconds</span>
                </span>
              </label>
            </div>
          </section>
          </div>

          <div id="panel-add-cards" class="tab-panel" role="tabpanel" aria-labelledby="tab-add-cards" tabindex="0" data-panel="add-cards" hidden>
          <div class="section-heading inventory-heading">
            <div>
              <h2 id="add-cards-title">Add cards</h2>
            </div>
          </div>
          <section class="panel inventory-panel" aria-labelledby="add-cards-title">
            <div class="inventory-profile-bar">
              <label class="field profile-picker"><span>Merchandise profile</span><select id="inventory-profile-select"></select></label>
              <p id="inventory-profile-summary" class="inventory-profile-summary"></p>
              <button id="edit-merchandise-profiles" class="quiet-button" type="button">Edit profiles</button>
            </div>
            <div class="catalog-search-row">
              <label class="field"><span>Card name</span><input id="catalog-query" type="text" maxlength="200" placeholder="Search card name" /></label>
              <label class="field"><span>Product line (optional)</span><input id="catalog-product-line" type="text" list="catalog-product-lines" maxlength="100" placeholder="All product lines" /><datalist id="catalog-product-lines"></datalist></label>
              <button id="catalog-search" class="primary-button dark-button" type="button">Search catalog</button>
            </div>
            <p id="inventory-message" class="repricing-message"></p>
            <div id="catalog-results" class="catalog-results" hidden></div>
          </section>
          <dialog id="inventory-quantity-dialog" class="quantity-dialog">
            <div class="quantity-dialog-content">
              <h3>Custom quantity</h3>
              <label class="field"><span>Quantity to add</span><input id="inventory-custom-quantity" type="number" min="1" max="10000000" step="1" value="5" /></label>
              <div class="quantity-dialog-actions">
                <button id="inventory-quantity-cancel" class="quiet-button" type="button">Cancel</button>
                <button id="inventory-quantity-apply" class="primary-button dark-button" type="button">Add quantity</button>
              </div>
            </div>
          </dialog>
          </div>

          <div id="panel-inventory" class="tab-panel" role="tabpanel" aria-labelledby="tab-inventory" tabindex="0" data-panel="inventory" hidden>
          <div class="section-heading repricing-heading">
            <div>
              <h2 id="repricing-title">Smart repricing</h2>
            </div>
          </div>
          <section class="panel repricing-panel" aria-labelledby="repricing-title">
            <div class="repricing-profile-bar">
              <label class="field profile-picker"><span>Repricing profile</span><select id="repricing-profile-select"></select></label>
              <p id="repricing-profile-summary" class="inventory-profile-summary"></p>
              <button id="edit-repricing-profiles" class="quiet-button" type="button">Edit profiles</button>
            </div>
            <div class="repricing-options">
              <span></span>
              <button id="repricing-preview" class="primary-button dark-button" type="button">Refresh inventory &amp; preview</button>
            </div>
            <p id="repricing-message" class="repricing-message"></p>
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
                  <thead><tr><th><span class="sr-only">Select</span></th><th>Card</th><th>Condition</th><th>Current</th><th>Market</th><th>Lowest match</th><th>Proposed</th><th>Result</th></tr></thead>
                  <tbody id="repricing-rows"></tbody>
                </table>
              </div>
            </div>
          </section>
          </div>

          <div id="panel-jobs" class="tab-panel" role="tabpanel" aria-labelledby="tab-jobs" tabindex="0" data-panel="jobs" hidden>
          <div class="section-heading queue-heading first-heading">
            <div>
              <h2 id="inventory-queue-title">Card additions</h2>
            </div>
          </div>
          <section class="panel queue-panel" aria-labelledby="inventory-queue-title">
            <div class="queue-list-head">
              <button id="refresh-inventory-queue" class="quiet-button" type="button">Refresh</button>
            </div>
            <div id="inventory-queue-jobs" class="queue-jobs" aria-live="polite"></div>
          </section>

          <div class="section-heading queue-heading">
            <div>
              <h2 id="queue-title">Price updates</h2>
            </div>
          </div>
          <section class="panel queue-panel" aria-labelledby="queue-title">
            <div class="queue-list-head">
              <button id="refresh-queue" class="quiet-button" type="button">Refresh</button>
            </div>
            <div id="queue-jobs" class="queue-jobs" aria-live="polite"></div>
          </section>
          </div>

          <div id="save-bar" class="save-bar" hidden>
            <div>
              <strong id="save-title">Unsaved changes</strong>
              <span id="save-detail" hidden></span>
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
.shell { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 20px 0 112px; }
h2, p { margin-top: 0; }
h2 { margin-bottom: 0; font: 700 1.45rem/1.15 Georgia, serif; }
.tab-list { position: sticky; z-index: 4; top: 10px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; margin-bottom: 24px; padding: 6px; border: 1px solid rgba(202,211,201,.9); border-radius: 16px; background: rgba(244,245,239,.9); box-shadow: 0 10px 28px rgba(32,51,40,.08); backdrop-filter: blur(12px); }
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
.dashboard-automation { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
.dashboard-toggle { padding: 20px 22px; }
.dashboard-toggle + .dashboard-toggle { border-left: 1px solid var(--line); }
.dashboard-toggle strong { font-size: .9rem; }
.order-panel { overflow: hidden; margin-bottom: 22px; }
.order-message { margin: 0; padding: 14px 18px; color: var(--muted); font-size: .84rem; }
.order-message:empty { display: none; }
.order-message.error { color: #93401c; background: #fff5f1; }
.order-message.success { color: var(--green-dark); background: var(--green-soft); }
.order-table-wrap { overflow: auto; }
.order-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.dashboard-order-table { min-width: 900px; }
.full-order-table { min-width: 1320px; }
.order-table th { padding: 11px 12px; background: #f1f3ed; color: var(--muted); text-align: left; font-size: .69rem; letter-spacing: .035em; text-transform: uppercase; white-space: nowrap; }
.order-table td { padding: 12px; border-top: 1px solid var(--line); vertical-align: middle; }
.order-table .money-cell { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.order-table .date-cell { white-space: nowrap; }
.order-table .empty-cell { padding: 28px 18px; color: var(--muted); text-align: center; }
.order-actions { display: flex; flex-wrap: wrap; gap: 6px; min-width: 360px; }
.order-action { border: 1px solid var(--line); border-radius: 8px; background: white; color: var(--green-dark); padding: 7px 9px; font-size: .73rem; font-weight: 750; text-decoration: none; white-space: nowrap; }
.order-action:hover { background: var(--green-soft); }
.order-action:disabled { cursor: wait; opacity: .6; }
.order-action.ship-action { border-color: #c9d8cf; background: var(--green-soft); }
.tracking-row td { padding: 10px 12px; background: #f7f8f3; }
.tracking-form { display: flex; align-items: end; justify-content: flex-end; gap: 8px; }
.tracking-form .field { width: min(360px, 100%); }
.tracking-form input { min-height: 38px; }
.tracking-form .order-action { min-height: 38px; }
.quiet-button { border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.7); color: var(--green-dark); padding: 9px 13px; font-weight: 750; }
.quiet-button:hover { background: white; }
.printer-note { background: #fff4dc; color: #774416; border: 1px solid #eed4a1; border-radius: 12px; padding: 11px 14px; font-size: .9rem; }
.output-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.output-card { overflow: hidden; transition: opacity .2s ease; }
.output-card.disabled .output-body > :not(.print-test-row) { opacity: .5; }
.output-head { padding: 22px 23px 19px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 14px; }
.output-icon { width: 42px; height: 42px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 13px; background: var(--green-soft); color: var(--green-dark); font-size: 1.15rem; }
.output-title { flex: 1; }
.output-title h3 { margin: 0; font-size: 1rem; }
.output-body { padding: 21px 23px 24px; display: grid; gap: 18px; transition: opacity .2s ease; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.print-test-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 17px; border-top: 1px solid var(--line); }
.print-test-message { margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.35; }
.print-test-message.success { color: var(--green-dark); }
.print-test-message.error { color: #93401c; }
.print-test-button { flex: 0 0 auto; }
.repricing-heading { margin-top: 40px; }
.repricing-panel { overflow: hidden; margin-bottom: 22px; }
.repricing-profile-bar { display: grid; grid-template-columns: minmax(210px, .7fr) minmax(0, 1.7fr) auto; align-items: end; gap: 18px; padding: 16px 25px; border-bottom: 1px solid var(--line); background: #fbfcf7; }
.repricing-options { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 28px; padding: 20px 25px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fbfcf7; }
.repricing-message { margin: 0; padding: 15px 25px; color: var(--muted); font-size: .86rem; }
.repricing-message:empty { display: none; }
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
.profile-settings-panel { overflow: hidden; margin-bottom: 22px; }
.profile-help { margin: 0; padding: 16px 25px 0; color: var(--muted); font-size: .8rem; }
.profile-list { display: grid; gap: 12px; padding: 18px 25px 22px; }
.profile-card { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--line); border-radius: 14px; background: #fbfcf7; }
.profile-card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.profile-default { display: flex; align-items: center; gap: 8px; color: var(--green-dark); font-size: .8rem; font-weight: 800; }
.profile-default input { width: 17px; height: 17px; accent-color: var(--green); }
.profile-remove { border: 0; background: transparent; color: #8c4630; font-weight: 750; }
.profile-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 13px; }
.repricing-range-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; border-top: 1px solid var(--line); }
.repricing-range-head strong { font-size: .84rem; }
.repricing-ranges { display: grid; gap: 9px; }
.repricing-range { display: grid; grid-template-columns: minmax(95px, .65fr) repeat(5, minmax(120px, 1fr)) auto; align-items: end; gap: 10px; padding: 11px; border: 1px solid var(--line); border-radius: 11px; background: white; }
.repricing-range-label { align-self: center; color: var(--green-dark); font-size: .78rem; font-weight: 800; }
.repricing-range-remove { align-self: center; border: 0; background: transparent; color: #8c4630; font-weight: 800; }
.inventory-profile-bar { display: grid; grid-template-columns: minmax(210px, .7fr) minmax(0, 1.7fr) auto; align-items: end; gap: 18px; padding: 16px 25px; border-bottom: 1px solid var(--line); background: #fbfcf7; }
.inventory-profile-summary { align-self: center; margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.45; }
.catalog-search-row { display: grid; grid-template-columns: 1.35fr 1fr auto; align-items: end; gap: 14px; padding: 16px 25px 20px; }
.catalog-results { display: grid; gap: 16px; max-height: 560px; overflow: auto; padding: 0 25px 22px; }
.catalog-section { display: grid; gap: 8px; }
.catalog-section-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding: 2px 2px 0; }
.catalog-section-head h4 { margin: 0; font-size: .9rem; }
.catalog-section-head span { color: var(--muted); font-size: .75rem; }
.catalog-section-list { display: grid; gap: 8px; }
.catalog-result { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 10px 15px 10px 10px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.catalog-result.active { border-color: #9bcaae; box-shadow: 0 0 0 2px rgba(47, 125, 82, .08); }
.catalog-result.foil { border: 2px solid transparent; padding: 9px 14px 9px 9px; background: linear-gradient(#fff, #fff) padding-box, linear-gradient(125deg, #4dc8c0, #8a79df, #f29bc1, #e8c65a, #69c58a) border-box; }
.catalog-result-actions { display: flex; align-items: center; gap: 6px; }
.catalog-result-actions button { min-width: 38px; padding: 8px 9px; }
.catalog-condition-select { width: 154px; padding: 8px 30px 8px 10px; font-size: .78rem; }
.foil-toggle[aria-pressed="true"] { background: linear-gradient(125deg, #dff8f3, #e9e3ff, #ffe3ef, #fff2bd); color: #4c356f; }
.quantity-choice.selected { background: var(--green); color: white; }
.product-image { display: grid; place-items: center; width: 64px; aspect-ratio: 200 / 279; overflow: hidden; border-radius: 7px; background: #eef0e8; color: var(--muted); font-size: .62rem; text-align: center; }
.product-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
.product-image.missing { padding: 5px; }
.catalog-result-copy { min-width: 0; display: grid; gap: 3px; }
.catalog-result-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-result-copy small { color: var(--muted); }
.catalog-load-more { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 2px 0; color: var(--muted); font-size: .78rem; }
.catalog-inline-status { grid-column: 1 / -1; border-top: 1px solid var(--line); margin: 2px 5px 0; padding: 10px 4px 2px; color: var(--muted); font-size: .82rem; font-weight: 700; }
.catalog-inline-status.success { color: #22613d; }
.catalog-inline-status.error { color: var(--danger); }
.quantity-dialog { width: min(420px, calc(100% - 32px)); border: 0; border-radius: 17px; padding: 0; box-shadow: 0 24px 70px rgba(12,26,18,.28); }
.quantity-dialog::backdrop { background: rgba(12, 26, 18, .45); }
.quantity-dialog-content { display: grid; gap: 18px; padding: 24px; }
.quantity-dialog-content h3 { margin: 0; }
.quantity-dialog-actions { display: flex; justify-content: flex-end; gap: 9px; }
.inventory-queue-settings { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 36px; padding: 20px 25px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: #fbfcf7; }
.worker-settings-panel { overflow: hidden; margin-bottom: 22px; }
.worker-settings-panel .inventory-queue-settings { border-top: 0; }
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
.queue-list-head { display: flex; justify-content: flex-end; align-items: center; padding: 18px 25px 12px; }
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
.save-bar { position: fixed; z-index: 5; bottom: 20px; left: 50%; transform: translateX(-50%); width: min(1408px, calc(100% - 32px)); display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 16px 14px 20px; background: rgba(23,34,29,.94); color: white; border: 1px solid rgba(255,255,255,.14); border-radius: 17px; box-shadow: 0 18px 45px rgba(12,26,18,.25); backdrop-filter: blur(12px); }
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
  .dashboard-automation { grid-template-columns: 1fr; }
  .dashboard-toggle + .dashboard-toggle { border-left: 0; border-top: 1px solid var(--line); }
  .output-grid { grid-template-columns: 1fr; }
  .queue-settings { grid-template-columns: 1fr; gap: 20px; }
  .profile-fields { grid-template-columns: 1fr 1fr; }
  .repricing-range { grid-template-columns: 1fr 1fr; }
  .repricing-range-label, .repricing-range-remove { grid-column: span 2; }
  .inventory-profile-bar, .repricing-profile-bar { grid-template-columns: 1fr auto; }
  .inventory-profile-summary { grid-column: 1 / -1; grid-row: 2; }
  .catalog-search-row { grid-template-columns: 1fr 1fr; }
  .catalog-search-row button { grid-column: 1 / -1; }
  .inventory-queue-settings { grid-template-columns: 1fr; gap: 20px; }
  .repricing-options { grid-template-columns: 1fr; }
  .repricing-summary { align-items: stretch; flex-direction: column; }
  .repricing-actions { justify-content: flex-end; }
  .queue-form-grid { grid-template-columns: 1fr 1fr; }
  .queue-form-grid .wide-field { grid-column: span 2; }
  .queue-job { grid-template-columns: minmax(0, 1fr) auto; }
  .queue-job .cancel-job { grid-column: 1 / -1; justify-self: end; }
  .catalog-result { grid-template-columns: 56px minmax(0, 1fr); }
  .catalog-result-actions { grid-column: 1 / -1; flex-wrap: wrap; }
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
    inventoryAddingProductIds: new Set(),
    inventoryProductDetailsById: new Map(),
    inventoryResultByProductId: new Map(),
    selectedMerchandiseProfileId: null,
    selectedRepricingProfileId: null,
    inventoryQuantityProductId: null,
    inventoryFoilProductIds: new Set(),
    inventoryConditionByProductId: new Map(),
    catalogSearch: null,
    catalogSearchToken: 0,
    catalogSearchController: null,
    orderLists: { all: null, "ready-to-ship": null },
    orderLoading: { all: false, "ready-to-ship": false },
    pirateShipPreparations: new Map(),
  };
  const merchandiseProfileStorageKey = "tcgplayer-alert.merchandise-profile";
  const repricingProfileStorageKey = "tcgplayer-alert.repricing-profile";
  const activeTabStorageKey = "tcgplayer-alert.active-tab";
  const tabIds = ["dashboard", "orders", "add-cards", "inventory", "settings", "jobs"];
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

  function normalizeTabId(value) {
    if (value === "automation") return "settings";
    if (value === "repricing") return "inventory";
    return isTabId(value) ? value : null;
  }

  function activateTab(tabId, updateHistory = false, focusTab = false) {
    const selectedTab = normalizeTabId(tabId) || "dashboard";
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
    if (state.settings !== null) {
      if (selectedTab === "dashboard") void loadOrders("ready-to-ship");
      if (selectedTab === "orders") void loadOrders("all");
    }
  }

  function initialTab() {
    const hashTab = window.location.hash.slice(1);
    const normalizedHashTab = normalizeTabId(hashTab);
    if (normalizedHashTab) return normalizedHashTab;
    try {
      const stored = window.localStorage.getItem(activeTabStorageKey);
      const normalizedStoredTab = normalizeTabId(stored);
      if (normalizedStoredTab) return normalizedStoredTab;
    } catch {
      // Dashboard remains the default when browser storage is unavailable.
    }
    return "dashboard";
  }

  function selectLocationTab() {
    const hashTab = window.location.hash.slice(1);
    activateTab(normalizeTabId(hashTab) || "dashboard");
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

  function selectInput(name, value, choices) {
    const select = el("select", { name });
    for (const [optionValue, label] of choices) {
      const option = el("option", { value: optionValue, text: label });
      if (optionValue === value) option.selected = true;
      select.append(option);
    }
    return select;
  }

  function renderMerchandiseProfile(profile) {
    const card = el("section", {
      className: "profile-card",
      "data-profile-id": profile.id,
    });
    const defaultInput = el("input", {
      type: "radio",
      name: "defaultMerchandiseProfileId",
      value: profile.id,
    });
    defaultInput.checked = profile.id === state.settings.defaultMerchandiseProfileId;
    const remove = el("button", {
      className: "profile-remove",
      type: "button",
      text: "Remove",
    });
    remove.disabled = state.settings.merchandiseProfiles.length === 1;
    remove.addEventListener("click", () => removeMerchandiseProfile(profile.id));
    const name = el("input", { name: "profileName", maxlength: "80", required: "" });
    name.value = profile.name;
    const language = el("input", { name: "language", maxlength: "64", required: "" });
    language.value = profile.language;
    const fallback = selectInput("noComparisonFallback", profile.noComparisonFallback, [
      ["market", "Use market price"],
      ["stop", "Stop for review"],
      ["manual", "Use manual price"],
    ]);
    const manualPrice = numberInput(
      "manualPrice",
      profile.manualPrice ?? profile.minimumPrice,
      0.01,
      1000000,
      "0.01",
    );
    const manualField = field("Manual fallback price ($)", manualPrice);
    const updateManualVisibility = () => {
      manualField.hidden = fallback.value !== "manual";
      manualPrice.required = fallback.value === "manual";
    };
    fallback.addEventListener("change", updateManualVisibility);
    updateManualVisibility();
    card.append(
      el("div", { className: "profile-card-head" }, [
        el("label", { className: "profile-default" }, [
          defaultInput,
          el("span", { text: "Default profile" }),
        ]),
        remove,
      ]),
      el("div", { className: "profile-fields" }, [
        field("Profile name", name),
        field("Language", language),
        field("Minimum item price ($)", numberInput("minimumPrice", profile.minimumPrice, 0.01, 1000000, "0.01")),
        field("Shipping rate ($)", numberInput("estimatedShippingPrice", profile.estimatedShippingPrice, 0, 1000000, "0.01")),
        field("Compare using", selectInput("priceBasis", profile.priceBasis, [["delivered", "Item + shipping"], ["item", "Item price only"]])),
        field("Compare against", selectInput("conditionPolicy", profile.conditionPolicy, [["same-or-better", "Same or better condition"], ["same", "Same condition only"]])),
        field("Undercut (cents)", numberInput("adjustmentCents", profile.adjustmentCents, 0, 100000)),
        field("If no listing matches", fallback),
        manualField,
      ]),
    );
    return card;
  }

  function renderMerchandiseProfiles() {
    document.querySelector("#merchandise-profile-list").replaceChildren(
      ...state.settings.merchandiseProfiles.map(renderMerchandiseProfile),
    );
  }

  function merchandiseProfileDrafts() {
    const cards = [...document.querySelectorAll("#merchandise-profile-list [data-profile-id]")];
    return cards.length > 0
      ? cards.map(collectMerchandiseProfile)
      : [...state.settings.merchandiseProfiles];
  }

  function merchandiseProfileDefaultDraft() {
    return document.querySelector('#merchandise-profile-list [name="defaultMerchandiseProfileId"]:checked')?.value
      ?? state.settings.defaultMerchandiseProfileId;
  }

  function addMerchandiseProfile() {
    if (state.settings.merchandiseProfiles.length >= 20) return;
    const profiles = merchandiseProfileDrafts();
    const source = profiles.find((profile) => profile.id === state.selectedMerchandiseProfileId)
      ?? profiles.find((profile) => profile.id === merchandiseProfileDefaultDraft())
      ?? profiles[0];
    let suffix = Date.now().toString(36);
    let id = "profile-" + suffix;
    while (state.settings.merchandiseProfiles.some((profile) => profile.id === id)) {
      suffix += "x";
      id = "profile-" + suffix;
    }
    const profile = {
      ...source,
      id,
      name: "New profile",
    };
    state.settings = {
      ...state.settings,
      merchandiseProfiles: [...profiles, profile],
      defaultMerchandiseProfileId: merchandiseProfileDefaultDraft(),
    };
    renderMerchandiseProfiles();
    updateSaveBarVisibility();
    document.querySelector('[data-profile-id="' + CSS.escape(id) + '"] [name="profileName"]').select();
  }

  function removeMerchandiseProfile(id) {
    if (state.settings.merchandiseProfiles.length === 1) return;
    const merchandiseProfiles = merchandiseProfileDrafts().filter((profile) => profile.id !== id);
    const defaultDraft = merchandiseProfileDefaultDraft();
    const defaultMerchandiseProfileId = defaultDraft === id
      ? merchandiseProfiles[0].id
      : defaultDraft;
    state.settings = {
      ...state.settings,
      merchandiseProfiles,
      defaultMerchandiseProfileId,
    };
    if (state.selectedMerchandiseProfileId === id) {
      state.selectedMerchandiseProfileId = defaultMerchandiseProfileId;
    }
    renderMerchandiseProfiles();
    renderMerchandiseProfileSelector();
    updateSaveBarVisibility();
  }

  function renderRepricingRange(profile, range, index) {
    const previousMaximum = index === 0 ? 0 : profile.ranges[index - 1].maximumPrice;
    const isLast = index === profile.ranges.length - 1;
    const rangeLabel = isLast
      ? (previousMaximum ? "Above " + money(previousMaximum) : "All values")
      : (previousMaximum ? "Above " + money(previousMaximum) + " to " + money(range.maximumPrice) : "Up to " + money(range.maximumPrice));
    const maximum = isLast
      ? el("div", { className: "field" }, [
          el("span", { text: "Range maximum" }),
          el("strong", { text: "No maximum" }),
        ])
      : field("Range maximum ($)", numberInput("maximumPrice", range.maximumPrice, Math.round((previousMaximum + 0.01) * 100) / 100, 1000000, "0.01"));
    const gapThreshold = numberInput("gapThresholdPercent", range.gapThresholdPercent, 0, 10000, "0.1");
    const gapAction = selectInput("gapAction", range.gapAction, [["follow-lowest", "Ignore gap"], ["use-next", "Use next listing"], ["skip", "Skip card"]]);
    const updateGapThreshold = () => {
      gapThreshold.disabled = gapAction.value === "follow-lowest";
    };
    gapAction.addEventListener("change", updateGapThreshold);
    updateGapThreshold();
    const remove = el("button", {
      className: "repricing-range-remove",
      type: "button",
      text: "Remove",
      title: "Remove this range",
    });
    remove.disabled = profile.ranges.length === 1;
    remove.addEventListener("click", () => removeRepricingRange(profile.id, index));
    return el("div", { className: "repricing-range", "data-range-index": String(index) }, [
      el("div", { className: "repricing-range-label", text: rangeLabel }),
      maximum,
      field("Minimum comparables", numberInput("minimumListings", range.minimumListings ?? 0, 0, 100, "1")),
      field("Price from", selectInput("priceSource", range.priceSource, [["lowest", "Lowest listing"], ["market", "Market price"]])),
      field("Use percentage", numberInput("percentage", range.percentage, 1, 500, "0.1")),
      field("Gap threshold (%)", gapThreshold),
      field("When gap is reached", gapAction),
      remove,
    ]);
  }

  function renderRepricingProfile(profile) {
    const card = el("section", {
      className: "profile-card",
      "data-repricing-profile-id": profile.id,
    });
    const defaultInput = el("input", {
      type: "radio",
      name: "defaultRepricingProfileId",
      value: profile.id,
    });
    defaultInput.checked = profile.id === state.settings.defaultRepricingProfileId;
    const remove = el("button", {
      className: "profile-remove",
      type: "button",
      text: "Remove",
    });
    remove.disabled = state.settings.repricingProfiles.length === 1;
    remove.addEventListener("click", () => removeRepricingProfile(profile.id));
    const name = el("input", { name: "profileName", maxlength: "80", required: "" });
    name.value = profile.name;
    const allowIncreases = el("input", { type: "checkbox", name: "allowPriceIncreases" });
    allowIncreases.checked = profile.allowPriceIncreases;
    const addRange = el("button", {
      className: "quiet-button",
      type: "button",
      text: "Add range",
    });
    addRange.disabled = profile.ranges.length >= 20 || (profile.ranges.at(-2)?.maximumPrice ?? 0) >= 1000000;
    addRange.addEventListener("click", () => addRepricingRange(profile.id));
    card.append(
      el("div", { className: "profile-card-head" }, [
        el("label", { className: "profile-default" }, [
          defaultInput,
          el("span", { text: "Default profile" }),
        ]),
        remove,
      ]),
      el("div", { className: "profile-fields" }, [
        field("Profile name", name),
        field("Minimum item price ($)", numberInput("minimumPrice", profile.minimumPrice, 0.01, 1000000, "0.01")),
        field("Compare using", selectInput("priceBasis", profile.priceBasis, [["delivered", "Item + shipping"], ["item", "Item price only"]])),
        field("Compare against", selectInput("conditionPolicy", profile.conditionPolicy, [["same-or-better", "Same or better condition"], ["same", "Same condition only"]])),
        field("Adjustment (cents)", numberInput("adjustmentCents", profile.adjustmentCents, 0, 100000)),
        el("label", { className: "switch-row" }, [
          el("span", {}, [el("strong", { text: "Allow price increases" })]),
          allowIncreases,
          el("span", { className: "switch", "aria-hidden": "true" }),
        ]),
      ]),
      el("div", { className: "repricing-range-head" }, [
        el("strong", { text: "Value ranges" }),
        addRange,
      ]),
      el("div", { className: "repricing-ranges" }, profile.ranges.map((range, index) => renderRepricingRange(profile, range, index))),
    );
    return card;
  }

  function renderRepricingProfiles() {
    document.querySelector("#repricing-profile-list").replaceChildren(
      ...state.settings.repricingProfiles.map(renderRepricingProfile),
    );
  }

  function repricingProfileDrafts() {
    const cards = [...document.querySelectorAll("#repricing-profile-list [data-repricing-profile-id]")];
    return cards.length > 0
      ? cards.map(collectRepricingProfile)
      : [...state.settings.repricingProfiles];
  }

  function repricingProfileDefaultDraft() {
    return document.querySelector('#repricing-profile-list [name="defaultRepricingProfileId"]:checked')?.value
      ?? state.settings.defaultRepricingProfileId;
  }

  function replaceRepricingProfile(profileId, update) {
    const profiles = repricingProfileDrafts();
    state.settings = {
      ...state.settings,
      repricingProfiles: profiles.map((profile) => profile.id === profileId ? update(profile) : profile),
      defaultRepricingProfileId: repricingProfileDefaultDraft(),
    };
    renderRepricingProfiles();
    updateSaveBarVisibility();
  }

  function addRepricingProfile() {
    if (state.settings.repricingProfiles.length >= 20) return;
    const profiles = repricingProfileDrafts();
    const source = profiles.find((profile) => profile.id === state.selectedRepricingProfileId)
      ?? profiles.find((profile) => profile.id === repricingProfileDefaultDraft())
      ?? profiles[0];
    let suffix = Date.now().toString(36);
    let id = "repricing-" + suffix;
    while (state.settings.repricingProfiles.some((profile) => profile.id === id)) {
      suffix += "x";
      id = "repricing-" + suffix;
    }
    state.settings = {
      ...state.settings,
      repricingProfiles: [...profiles, { ...source, id, name: "New repricing profile" }],
      defaultRepricingProfileId: repricingProfileDefaultDraft(),
    };
    renderRepricingProfiles();
    updateSaveBarVisibility();
    document.querySelector('[data-repricing-profile-id="' + CSS.escape(id) + '"] [name="profileName"]').select();
  }

  function removeRepricingProfile(id) {
    if (state.settings.repricingProfiles.length === 1) return;
    const repricingProfiles = repricingProfileDrafts().filter((profile) => profile.id !== id);
    const defaultDraft = repricingProfileDefaultDraft();
    const defaultRepricingProfileId = defaultDraft === id ? repricingProfiles[0].id : defaultDraft;
    state.settings = { ...state.settings, repricingProfiles, defaultRepricingProfileId };
    if (state.selectedRepricingProfileId === id) state.selectedRepricingProfileId = defaultRepricingProfileId;
    renderRepricingProfiles();
    renderRepricingProfileSelector();
    updateSaveBarVisibility();
  }

  function addRepricingRange(profileId) {
    replaceRepricingProfile(profileId, (profile) => {
      if (profile.ranges.length >= 20) return profile;
      const ranges = [...profile.ranges];
      const openRange = ranges.pop();
      const previousMaximum = ranges.at(-1)?.maximumPrice ?? 0;
      if (previousMaximum >= 1000000) return profile;
      const suggestedMaximum = previousMaximum < 5
        ? 5
        : Math.min(1000000, Math.round(previousMaximum * 2 * 100) / 100);
      const { maximumPrice: _maximumPrice, ...openRangeWithoutMaximum } = openRange;
      return {
        ...profile,
        ranges: [
          ...ranges,
          { ...openRangeWithoutMaximum, maximumPrice: suggestedMaximum },
          openRangeWithoutMaximum,
        ],
      };
    });
  }

  function removeRepricingRange(profileId, rangeIndex) {
    replaceRepricingProfile(profileId, (profile) => {
      if (profile.ranges.length === 1) return profile;
      const ranges = profile.ranges.filter((_range, index) => index !== rangeIndex);
      const last = ranges.at(-1);
      const { maximumPrice: _maximumPrice, ...lastWithoutMaximum } = last;
      return { ...profile, ranges: [...ranges.slice(0, -1), lastWithoutMaximum] };
    });
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
      ]),
      toggle,
    ]));
    const body = el("div", { className: "output-body" });
    body.append(field("Printer", printerSelect(output)));
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
      text: "Sends a real print job with synthetic data.",
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
    const card = outputs.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"]');
    const printerName = card.querySelector('[name="printerName"]').value;
    button.disabled = true;
    button.textContent = "Sending...";
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

  function dashboardToggle(label, checked, onChange, actionId) {
    const input = el("input", { type: "checkbox", "aria-label": label });
    input.checked = checked;
    if (actionId) input.dataset.actionId = actionId;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { className: "switch-row dashboard-toggle" }, [
      el("span", {}, [el("strong", { text: label })]),
      input,
      el("span", { className: "switch", "aria-hidden": "true" }),
    ]);
  }

  function renderDashboardAutomation() {
    const container = document.querySelector("#dashboard-automation-controls");
    const controls = [
      dashboardToggle("Dry run", state.settings.dryRun, (checked) => {
        const settingsControl = document.querySelector("#dry-run");
        settingsControl.checked = checked;
        settingsControl.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    ];
    for (const [type, label] of [["print-address-label", "Address labels"], ["print-packing-slip", "Packing slips"]]) {
      const output = state.settings.outputs.find((candidate) => candidate.type === type);
      if (!output) continue;
      controls.push(dashboardToggle(label, output.enabled, (checked) => {
        const settingsControl = outputs.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"] [name="enabled"]');
        settingsControl.checked = checked;
        settingsControl.dispatchEvent(new Event("change", { bubbles: true }));
      }, output.actionId));
    }
    container.replaceChildren(...controls);
  }

  function syncDashboardAutomation() {
    const dryRun = document.querySelector('#dashboard-automation-controls input[aria-label="Dry run"]');
    if (dryRun) dryRun.checked = document.querySelector("#dry-run").checked;
    for (const control of document.querySelectorAll("#dashboard-automation-controls input[data-action-id]")) {
      const settingsControl = outputs.querySelector('[data-action-id="' + CSS.escape(control.dataset.actionId) + '"] [name="enabled"]');
      if (settingsControl) control.checked = settingsControl.checked;
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
    renderMerchandiseProfiles();
    renderMerchandiseProfileSelector();
    renderRepricingProfiles();
    renderRepricingProfileSelector();
    renderDashboardAutomation();
    state.savedSettingsFingerprint = settingsFingerprint();
    updateSaveBarVisibility();
    printerNote.hidden = !state.settings.discoveryIssue;
    printerNote.textContent = state.settings.discoveryIssue || "";
    fatal.hidden = true;
    form.hidden = false;
    void loadQueue();
    void loadInventoryQueue();
    const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab;
    if (selectedTab === "dashboard") void loadOrders("ready-to-ship");
    if (selectedTab === "orders") void loadOrders("all");
  }

  function queueJob(job) {
    const copy = el("div", { className: "queue-job-copy" }, [
      el("strong", { text: job.update.productName }),
      el("small", { text: "$" + Number(job.update.price).toFixed(2) }),
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

  function orderUi(scope) {
    return scope === "ready-to-ship"
      ? {
          rows: document.querySelector("#dashboard-order-rows"),
          message: document.querySelector("#dashboard-orders-message"),
          columns: 7,
        }
      : {
          rows: document.querySelector("#order-rows"),
          message: document.querySelector("#orders-message"),
          columns: 9,
        };
  }

  function showOrderMessage(scope, text, kind = "") {
    const message = orderUi(scope).message;
    message.className = "order-message" + (kind ? " " + kind : "");
    message.textContent = text;
  }

  function orderButton(text, handler, className = "") {
    const button = el("button", {
      className: "order-action" + (className ? " " + className : ""),
      type: "button",
      text,
    });
    button.addEventListener("click", () => void handler(button));
    return button;
  }

  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }

  function trackingRow(order, scope, columns) {
    const input = el("input", {
      type: "text",
      maxlength: "256",
      autocomplete: "off",
      placeholder: "Tracking number",
      "aria-label": "Tracking number for order " + order.orderNumber,
    });
    const row = el("tr", { className: "tracking-row" });
    row.hidden = true;
    const cancel = orderButton("Cancel", () => {
      row.hidden = true;
      input.value = "";
    });
    const submit = orderButton("Add tracking", async (button) => {
      const trackingNumber = input.value.trim();
      if (!trackingNumber) {
        showOrderMessage(scope, "Enter a tracking number.", "error");
        input.focus();
        return;
      }
      await runOrderMutation(
        order,
        scope,
        "tracking",
        { trackingNumber },
        button,
        "Adding...",
        (result) => "Tracking added (" + result.carrier + ").",
      );
    }, "ship-action");
    const field = el("label", { className: "field" }, [
      el("span", { text: "Tracking number" }),
      input,
    ]);
    const cell = el("td", { colspan: String(columns) }, [
      el("div", { className: "tracking-form" }, [field, cancel, submit]),
    ]);
    row.append(cell);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit.click();
      }
    });
    return row;
  }

  function trackingOpenButton(order, row) {
    return orderButton("Add tracking", () => {
      row.hidden = !row.hidden;
      if (!row.hidden) row.querySelector("input").focus();
    });
  }

  function markShippedButton(order, scope) {
    return orderButton("Mark shipped", async (button) => {
      if (!window.confirm("Mark order " + order.orderNumber + " as shipped?")) return;
      await runOrderMutation(
        order,
        scope,
        "mark-shipped",
        {},
        button,
        "Marking...",
        (result) => result.outcome === "already-applied" ? "Order was already shipped." : "Order marked shipped.",
      );
    }, "ship-action");
  }

  function dashboardOrderRows(order) {
    const tracking = trackingRow(order, "ready-to-ship", 7);
    const row = el("tr", {}, [
      el("td", { text: order.buyerName }),
      el("td", { className: "date-cell", text: dateText(order.orderDate) }),
      el("td", { text: order.shippingType }),
      el("td", { className: "money-cell", text: money(order.totalAmount) }),
      el("td", {}, [pirateShipButton(order, "ready-to-ship")]),
      el("td", {}, [trackingOpenButton(order, tracking)]),
      el("td", {}, [markShippedButton(order, "ready-to-ship")]),
    ]);
    return [row, tracking];
  }

  function fullOrderRows(order) {
    const tracking = trackingRow(order, "all", 9);
    const actions = el("div", { className: "order-actions" });
    actions.append(
      orderButton("Print address label", (button) => runOrderPrint(order, "print-address-label", "address label", button, "all")),
      orderButton("Print packing slip", (button) => runOrderPrint(order, "print-packing-slip", "packing slip", button, "all")),
      orderButton("Download packing slip", (button) => downloadPackingSlip(order, button, "all")),
      pirateShipButton(order, "all"),
      trackingOpenButton(order, tracking),
      markShippedButton(order, "all"),
      el("a", {
        className: "order-action",
        text: "Manage order",
        href: "https://sellerportal.tcgplayer.com/orders/" + encodeURIComponent(order.orderNumber),
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    );
    const row = el("tr", {}, [
      el("td", {}, [el("strong", { text: order.orderNumber })]),
      el("td", { text: order.buyerName }),
      el("td", { className: "date-cell", text: dateText(order.orderDate) }),
      el("td", {}, [el("span", { className: "status-pill", text: order.status })]),
      el("td", { text: order.shippingType }),
      el("td", { className: "money-cell", text: money(order.productAmount) }),
      el("td", { className: "money-cell", text: money(order.shippingAmount) }),
      el("td", { className: "money-cell", text: money(order.totalAmount) }),
      el("td", {}, [actions]),
    ]);
    return [row, tracking];
  }

  function renderOrderList(scope) {
    const ui = orderUi(scope);
    const list = state.orderLists[scope];
    if (list === null) {
      ui.rows.replaceChildren(el("tr", {}, [
        el("td", { className: "empty-cell", colspan: String(ui.columns), text: state.orderLoading[scope] ? "Loading orders..." : "Orders have not been loaded." }),
      ]));
      return;
    }
    if (list.orders.length === 0) {
      ui.rows.replaceChildren(el("tr", {}, [
        el("td", { className: "empty-cell", colspan: String(ui.columns), text: scope === "ready-to-ship" ? "No orders are ready to ship." : "No orders found." }),
      ]));
      return;
    }
    ui.rows.replaceChildren(...list.orders.flatMap((order) =>
      scope === "ready-to-ship" ? dashboardOrderRows(order) : fullOrderRows(order),
    ));
  }

  async function loadOrders(scope, force = false) {
    if (state.orderLoading[scope]) return;
    if (!force && state.orderLists[scope] !== null) return;
    state.orderLoading[scope] = true;
    showOrderMessage(scope, "");
    renderOrderList(scope);
    try {
      const query = new URLSearchParams();
      if (scope === "ready-to-ship") query.set("status", "ready-to-ship");
      if (force) query.set("refresh", "1");
      const response = await fetch("/api/orders?" + query.toString(), {
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Orders could not be loaded.");
      state.orderLists[scope] = data;
    } catch (error) {
      showOrderMessage(scope, error instanceof Error ? error.message : "Orders could not be loaded.", "error");
    } finally {
      state.orderLoading[scope] = false;
      renderOrderList(scope);
    }
  }

  async function orderMutationRequest(order, path, body) {
    if (document.querySelector("#dry-run").checked) {
      throw new Error("Turn off dry run and save settings before changing or printing a real order.");
    }
    const response = await fetch(
      "/api/orders/" + encodeURIComponent(order.orderNumber) + "/" + path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error((data.issues || []).join(" ") || data.message || "The order action failed.");
    }
    return data;
  }

  function preparePirateShip(order) {
    const existing = state.pirateShipPreparations.get(order.orderNumber);
    if (existing && existing.expiresAt > Date.now()) return existing.request;
    state.pirateShipPreparations.delete(order.orderNumber);
    const request = fetch(
      "/api/orders/" + encodeURIComponent(order.orderNumber) + "/pirate-ship",
      { headers: { Accept: "application/json" } },
    ).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "The address could not be prepared for Pirate Ship.");
      return data;
    }).catch((error) => {
      const cached = state.pirateShipPreparations.get(order.orderNumber);
      if (cached?.request === request) state.pirateShipPreparations.delete(order.orderNumber);
      throw error;
    });
    state.pirateShipPreparations.set(order.orderNumber, {
      request,
      expiresAt: Date.now() + 30000,
    });
    return request;
  }

  function pirateShipButton(order, scope) {
    const button = orderButton("Open in Pirate Ship", (control) => openInPirateShip(order, scope, control));
    button.title = "Copies the address, then opens Pirate Ship";
    const prefetch = () => void preparePirateShip(order).catch(() => undefined);
    button.addEventListener("pointerenter", prefetch, { once: true });
    button.addEventListener("focus", prefetch, { once: true });
    return button;
  }

  async function openInPirateShip(order, scope, button) {
    const idleText = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing...";
    showOrderMessage(scope, "");
    try {
      const prepared = await preparePirateShip(order);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(prepared.pasteAddress);
      } catch {
        const accepted = window.prompt(
          "Copy this address, then select OK to open Pirate Ship.",
          prepared.pasteAddress,
        );
        if (accepted === null) {
          showOrderMessage(scope, "Pirate Ship was not opened.", "error");
          return;
        }
      }
      showOrderMessage(scope, "Address copied. Press Ctrl+V in Pirate Ship.", "success");
      const pirateShipWindow = window.open(prepared.url, "_blank");
      if (pirateShipWindow) pirateShipWindow.opener = null;
      else window.location.assign(prepared.url);
    } catch (error) {
      showOrderMessage(scope, error instanceof Error ? error.message : "Pirate Ship could not be opened.", "error");
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

  async function runOrderMutation(order, scope, path, body, button, busyText, successText) {
    const idleText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    showOrderMessage(scope, "");
    try {
      const result = await orderMutationRequest(order, path, body);
      const success = successText(result);
      state.orderLists[scope] = null;
      await loadOrders(scope, true);
      showOrderMessage(scope, success, "success");
    } catch (error) {
      showOrderMessage(scope, error instanceof Error ? error.message : "The order action failed.", "error");
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

  async function runOrderPrint(order, actionType, label, button, scope) {
    const idleText = button.textContent;
    button.disabled = true;
    button.textContent = "Printing...";
    showOrderMessage(scope, "");
    try {
      await orderMutationRequest(order, "print", { actionType });
      showOrderMessage(scope, "The " + label + " was sent to the printer.", "success");
    } catch (error) {
      showOrderMessage(scope, error instanceof Error ? error.message : "The order could not be printed.", "error");
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

  async function downloadPackingSlip(order, button, scope) {
    const idleText = button.textContent;
    button.disabled = true;
    button.textContent = "Downloading...";
    showOrderMessage(scope, "");
    try {
      const response = await fetch("/api/orders/" + encodeURIComponent(order.orderNumber) + "/packing-slip", {
        headers: { Accept: "application/pdf" },
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "The packing slip could not be downloaded.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = el("a", { href: url, download: "packing-slip-" + order.orderNumber + ".pdf" });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showOrderMessage(scope, "Packing slip downloaded.", "success");
    } catch (error) {
      showOrderMessage(scope, error instanceof Error ? error.message : "The packing slip could not be downloaded.", "error");
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

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
    const loading = state.inventoryAddingProductIds.has(product.productId);
    const result = state.inventoryResultByProductId.get(product.productId);
    const foilSelected = state.inventoryFoilProductIds.has(product.productId);
    const selectedCondition = state.inventoryConditionByProductId.get(product.productId) || "Near Mint";
    const condition = el("select", {
      className: "catalog-condition-select",
      "aria-label": "Condition for " + product.productName + " from " + product.setName,
      title: "Condition",
    });
    condition.replaceChildren(...inventoryConditionOrder.map((value) => {
      const option = el("option", { value, text: value });
      if (value === selectedCondition) option.selected = true;
      return option;
    }));
    condition.disabled = loading;
    condition.addEventListener("change", () => selectInventoryCondition(product.productId, condition.value));
    const foil = el("button", {
      className: "quiet-button foil-toggle",
      type: "button",
      text: "Foil",
      "aria-pressed": String(foilSelected),
      title: "Toggle foil printing",
    });
    foil.disabled = loading;
    foil.addEventListener("click", () => toggleInventoryFoil(product.productId));
    const quantityButtons = [1, 2, 3, 4].map((quantity) => {
      const button = el("button", {
        className: "quiet-button quantity-choice",
        type: "button",
        text: "+" + String(quantity),
        title: "Add " + String(quantity) + " using the selected profile",
      });
      button.disabled = loading;
      button.addEventListener("click", () => void queueCatalogProduct(product, quantity));
      return button;
    });
    const custom = el("button", {
      className: "quiet-button quantity-choice",
      type: "button",
      text: "+X",
      title: "Enter a custom quantity",
    });
    custom.disabled = loading;
    custom.addEventListener("click", () => openInventoryQuantityDialog(product.productId));
    const actions = el("div", { className: "catalog-result-actions" }, [
      condition,
      foil,
      ...quantityButtons,
      custom,
    ]);
    const children = [
      productImage(product),
      el("div", { className: "catalog-result-copy" }, [
        el("strong", { text: product.productName }),
        el("small", { text: product.productLineName + " / " + product.setName }),
        el("small", { text: (product.cardNumber ? "#" + product.cardNumber + " / " : "") + (product.rarityName || "No rarity") + " / market " + money(product.marketPrice) + " / foil " + (product.foilMarketPrice === undefined ? "—" : money(product.foilMarketPrice)) }),
      ]),
      actions,
    ];
    if (loading || result) {
      children.push(el("div", {
        className: "catalog-inline-status" + (result ? " " + result.kind : ""),
        text: result?.text || "Pricing and adding card...",
      }));
    }
    return el("div", {
      className: "catalog-result" + (foilSelected ? " foil" : ""),
    }, children);
  }

  const catalogMatchOrder = { exact: 0, variant: 1, related: 2 };

  function compareCatalogRanks(left, right) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (left[index] || 0) - (right[index] || 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }

  function sortLoadedCatalogProducts(products) {
    return [...new Map(products.map((product) => [product.productId, product])).values()].sort((left, right) => {
      const categoryDifference = catalogMatchOrder[left.matchKind] - catalogMatchOrder[right.matchKind];
      if (categoryDifference !== 0) return categoryDifference;
      return compareCatalogRanks(left.matchRank, right.matchRank)
        || left.productName.localeCompare(right.productName)
        || left.productLineName.localeCompare(right.productLineName)
        || left.setName.localeCompare(right.setName)
        || left.cardNumber.localeCompare(right.cardNumber)
        || left.productId - right.productId
        || left.loadedOrder - right.loadedOrder;
    });
  }

  function catalogSection(title, products) {
    if (products.length === 0) return null;
    return el("section", { className: "catalog-section", "aria-label": title }, [
      el("div", { className: "catalog-section-head" }, [
        el("h4", { text: title }),
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
      catalogSection("Exact name", exact),
      catalogSection("Name variants", variants),
      catalogSection("Related results", related),
    ].filter(Boolean);
    if (sections.length === 0) {
      sections.push(el("div", { className: "queue-empty", text: "No products matched this search and product line." }));
    }
    if (search.hasMore) {
      if (exact.length === 0) {
        const findExact = el("button", { id: "catalog-find-exact", className: "quiet-button", type: "button", text: "Find exact name" });
        findExact.addEventListener("click", () => void searchCatalog(true, findExact, true));
        sections.push(el("div", { className: "catalog-load-more" }, [
          el("span", { text: "Scan later results until this exact card name appears." }),
          findExact,
        ]));
      }
      const loadMore = el("button", { id: "catalog-load-more", className: "quiet-button", type: "button", text: "Load more" });
      loadMore.addEventListener("click", () => void searchCatalog(true, loadMore));
      sections.push(el("div", { className: "catalog-load-more" }, [
        el("span", { text: search.nextOffset + " of " + search.totalProducts + " loaded" }),
        loadMore,
      ]));
    }
    results.replaceChildren(...sections);
    results.hidden = false;
    updateCatalogProductLineSuggestions(search.products, search.productLine);
    message.className = "repricing-message success";
    message.textContent = search.products.length + " results · " + exact.length + " exact";
  }

  async function searchCatalog(append = false, triggerButton, findExact = false) {
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
    const idleText = findExact ? "Find exact name" : append ? "Load more" : "Search catalog";
    const requestController = new AbortController();
    state.catalogSearchController = requestController;
    button.disabled = true;
    button.textContent = append ? "Loading..." : "Searching...";
    message.className = "repricing-message";
    message.textContent = "";
    if (!append) {
      state.catalogSearch = null;
      results.hidden = true;
    }
    try {
      const parameters = new URLSearchParams({ q: query, offset: String(offset) });
      if (productLine) parameters.set("productLine", productLine);
      if (findExact) parameters.set("findExact", "true");
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

  function activeMerchandiseProfile() {
    if (!state.settings) return null;
    return state.settings.merchandiseProfiles.find(
      (profile) => profile.id === state.selectedMerchandiseProfileId,
    ) ?? state.settings.merchandiseProfiles.find(
      (profile) => profile.id === state.settings.defaultMerchandiseProfileId,
    ) ?? state.settings.merchandiseProfiles[0] ?? null;
  }

  function renderMerchandiseProfileSelector() {
    const select = document.querySelector("#inventory-profile-select");
    if (!state.settings || !select) return;
    if (!state.settings.merchandiseProfiles.some((profile) => profile.id === state.selectedMerchandiseProfileId)) {
      state.selectedMerchandiseProfileId = state.settings.defaultMerchandiseProfileId;
    }
    select.replaceChildren(...state.settings.merchandiseProfiles.map((profile) => {
      const option = el("option", { value: profile.id, text: profile.name });
      if (profile.id === state.selectedMerchandiseProfileId) option.selected = true;
      return option;
    }));
    const profile = activeMerchandiseProfile();
    document.querySelector("#inventory-profile-summary").textContent = profile
      ? profile.language + " · min " + money(profile.minimumPrice) + " · shipping " + money(profile.estimatedShippingPrice) + " · " + (profile.priceBasis === "delivered" ? "delivered price" : "item price") + " · " + (profile.conditionPolicy === "same-or-better" ? "same or better condition" : "same condition")
      : "";
  }

  function selectMerchandiseProfile(id) {
    state.selectedMerchandiseProfileId = id;
    try {
      window.localStorage.setItem(merchandiseProfileStorageKey, id);
    } catch {
      // The saved default remains available when browser storage is unavailable.
    }
    renderMerchandiseProfileSelector();
    state.inventoryResultByProductId.clear();
    if (state.catalogSearch) renderCatalogSearch();
  }

  function restoreMerchandiseProfilePreference() {
    if (!state.settings) return;
    let selected = state.settings.defaultMerchandiseProfileId;
    try {
      const stored = window.localStorage.getItem(merchandiseProfileStorageKey);
      if (state.settings.merchandiseProfiles.some((profile) => profile.id === stored)) {
        selected = stored;
      }
    } catch {
      // The configured default remains selected when browser storage is unavailable.
    }
    state.selectedMerchandiseProfileId = selected;
  }

  function activeRepricingProfile() {
    if (!state.settings) return null;
    return state.settings.repricingProfiles.find(
      (profile) => profile.id === state.selectedRepricingProfileId,
    ) ?? state.settings.repricingProfiles.find(
      (profile) => profile.id === state.settings.defaultRepricingProfileId,
    ) ?? state.settings.repricingProfiles[0] ?? null;
  }

  function renderRepricingProfileSelector() {
    const select = document.querySelector("#repricing-profile-select");
    if (!state.settings || !select) return;
    if (!state.settings.repricingProfiles.some((profile) => profile.id === state.selectedRepricingProfileId)) {
      state.selectedRepricingProfileId = state.settings.defaultRepricingProfileId;
    }
    select.replaceChildren(...state.settings.repricingProfiles.map((profile) => {
      const option = el("option", { value: profile.id, text: profile.name });
      if (profile.id === state.selectedRepricingProfileId) option.selected = true;
      return option;
    }));
    const profile = activeRepricingProfile();
    document.querySelector("#repricing-profile-summary").textContent = profile
      ? String(profile.ranges.length) + (profile.ranges.length === 1 ? " range" : " ranges") + " · min " + money(profile.minimumPrice) + " · " + (profile.priceBasis === "delivered" ? "delivered price" : "item price") + " · " + (profile.allowPriceIncreases ? "increases allowed" : "decreases only")
      : "";
  }

  function selectRepricingProfile(id) {
    state.selectedRepricingProfileId = id;
    try {
      window.localStorage.setItem(repricingProfileStorageKey, id);
    } catch {
      // The saved default remains available when browser storage is unavailable.
    }
    state.repricingPreview = null;
    document.querySelector("#repricing-results").hidden = true;
    renderRepricingProfileSelector();
  }

  function restoreRepricingProfilePreference() {
    if (!state.settings) return;
    let selected = state.settings.defaultRepricingProfileId;
    try {
      const stored = window.localStorage.getItem(repricingProfileStorageKey);
      if (state.settings.repricingProfiles.some((profile) => profile.id === stored)) {
        selected = stored;
      }
    } catch {
      // The configured default remains selected when browser storage is unavailable.
    }
    state.selectedRepricingProfileId = selected;
  }

  function selectInventoryCondition(productId, condition) {
    state.inventoryConditionByProductId.set(productId, condition);
    state.inventoryResultByProductId.delete(productId);
    if (state.catalogSearch) renderCatalogSearch();
  }

  function toggleInventoryFoil(productId) {
    if (state.inventoryFoilProductIds.has(productId)) {
      state.inventoryFoilProductIds.delete(productId);
    } else {
      state.inventoryFoilProductIds.add(productId);
    }
    state.inventoryResultByProductId.delete(productId);
    if (state.catalogSearch) renderCatalogSearch();
  }

  function openInventoryQuantityDialog(productId) {
    state.inventoryQuantityProductId = productId;
    const input = document.querySelector("#inventory-custom-quantity");
    input.value = "5";
    document.querySelector("#inventory-quantity-dialog").showModal();
    input.select();
  }

  function inventoryPricingRules(profile) {
    return {
      minimumPrice: profile.minimumPrice,
      conditionPolicy: profile.conditionPolicy,
      priceBasis: profile.priceBasis,
      adjustmentCents: profile.adjustmentCents,
      estimatedShippingPrice: profile.estimatedShippingPrice,
      noComparisonFallback: profile.noComparisonFallback,
      ...(profile.noComparisonFallback === "manual" ? { manualPrice: profile.manualPrice } : {}),
    };
  }

  async function queueCatalogProduct(product, addQuantity) {
    const productId = product.productId;
    if (state.inventoryAddingProductIds.has(productId)) return;
    const profile = activeMerchandiseProfile();
    const condition = state.inventoryConditionByProductId.get(productId) || "Near Mint";
    const printing = state.inventoryFoilProductIds.has(productId) ? "Foil" : "Normal";
    if (!profile) {
      state.inventoryResultByProductId.set(productId, {
        kind: "error",
        text: "Choose a merchandise profile before adding this card.",
      });
      renderCatalogSearch();
      return;
    }
    state.inventoryAddingProductIds.add(productId);
    state.inventoryResultByProductId.delete(productId);
    renderCatalogSearch();
    try {
      let details = state.inventoryProductDetailsById.get(productId);
      if (!details) {
        const detailsResponse = await fetch("/api/catalog/products/" + encodeURIComponent(productId), {
          headers: { Accept: "application/json" },
        });
        details = await detailsResponse.json();
        if (!detailsResponse.ok) {
          throw new Error(details.message || "Product details could not be loaded.");
        }
        state.inventoryProductDetailsById.set(productId, details);
      }
      const sku = details.skus.find(
        (candidate) => candidate.condition === condition
          && candidate.printing === printing
          && candidate.language === profile.language,
      );
      if (!sku) {
        throw new Error("No " + profile.language + " " + condition + " " + printing.toLocaleLowerCase() + " SKU exists for this product.");
      }
      const previewResponse = await fetch("/api/inventory-additions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          productId,
          productConditionId: sku.productConditionId,
          addQuantity,
          rules: inventoryPricingRules(profile),
        }),
      });
      const preview = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error((preview.issues || []).join(" ") || preview.message || "The card could not be priced.");
      }
      if (!preview.queueable) throw new Error(preview.reason || "The card cannot be queued with this profile.");
      const queueResponse = await fetch("/api/inventory-additions/previews/" + encodeURIComponent(preview.id) + "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      const queued = await queueResponse.json();
      if (!queueResponse.ok) {
        throw new Error((queued.issues || []).join(" ") || queued.message || "The card was not queued.");
      }
      state.inventoryResultByProductId.set(productId, {
        kind: "success",
        text: "Queued +" + String(addQuantity) + " at " + money(preview.proposedPrice) + " using " + profile.name + ".",
      });
      await loadInventoryQueue();
    } catch (error) {
      state.inventoryResultByProductId.set(productId, {
        kind: "error",
        text: error instanceof Error ? error.message : "The card was not queued.",
      });
    } finally {
      state.inventoryAddingProductIds.delete(productId);
      if (state.catalogSearch) renderCatalogSearch();
    }
  }

  function inventoryQueueJob(job) {
    const copy = el("div", { className: "queue-job-copy" }, [
      el("strong", { text: job.addition.productName }),
      el("small", { text: "+" + job.addition.addQuantity + " · " + money(job.addition.price) }),
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
          ? [el("div", { className: "queue-empty", text: "No card additions." })]
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
    const comparableCount = row.qualifyingListings === undefined
      ? ""
      : " · " + row.qualifyingListings + " comparable" + (row.qualifyingListings === 1 ? "" : "s");
    const lowest = row.lowestPrice === undefined
      ? "—" + comparableCount
      : money(row.lowestPrice) + (row.lowestShipping > 0 ? " + " + money(row.lowestShipping) + " shipping" : "") + (row.gapPercent === undefined ? "" : " · " + row.gapPercent.toFixed(1) + "% to next") + comparableCount;
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
      el("td", { text: row.marketPrice === undefined ? "—" : money(row.marketPrice) }),
      el("td", { text: lowest }),
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
    const queueButton = document.querySelector("#repricing-queue");
    queueButton.disabled = preview.counts.ready === 0;
    queueButton.textContent = "Queue selected";
  }

  function repricingRules() {
    const profile = activeRepricingProfile();
    if (!profile) return null;
    return {
      minimumPrice: profile.minimumPrice,
      conditionPolicy: profile.conditionPolicy,
      priceBasis: profile.priceBasis,
      adjustmentCents: profile.adjustmentCents,
      allowPriceIncreases: profile.allowPriceIncreases,
      ranges: profile.ranges,
    };
  }

  async function previewRepricing() {
    const button = document.querySelector("#repricing-preview");
    const message = document.querySelector("#repricing-message");
    button.disabled = true;
    button.textContent = "Loading...";
    message.className = "repricing-message";
    message.textContent = "";
    try {
      const response = await fetch("/api/repricing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(repricingRules()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The preview could not be created.");
      renderRepricingPreview(data);
      message.className = "repricing-message";
      message.textContent = "";
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
    button.textContent = "Queueing...";
    message.className = "repricing-message";
    message.textContent = "";
    try {
      const response = await fetch("/api/repricing/previews/" + encodeURIComponent(preview.id) + "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ rowIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data.issues || []).join(" ") || data.message || "The changes were not queued.");
      message.className = "repricing-message success";
      message.textContent = data.jobs.length + " price " + (data.jobs.length === 1 ? "update" : "updates") + " queued.";
      state.repricingPreview = null;
      document.querySelector("#repricing-results").hidden = true;
      await loadQueue();
    } catch (error) {
      message.className = "repricing-message error";
      message.textContent = error instanceof Error ? error.message : "The changes were not queued.";
      button.disabled = false;
      button.textContent = "Queue selected";
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
          ? [el("div", { className: "queue-empty", text: "No price updates." })]
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
      restoreMerchandiseProfilePreference();
      restoreRepricingProfilePreference();
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

  function collectMerchandiseProfile(card) {
    const fallback = card.querySelector('[name="noComparisonFallback"]').value;
    return {
      id: card.dataset.profileId,
      name: card.querySelector('[name="profileName"]').value.trim(),
      language: card.querySelector('[name="language"]').value.trim(),
      minimumPrice: Number(card.querySelector('[name="minimumPrice"]').value),
      estimatedShippingPrice: Number(card.querySelector('[name="estimatedShippingPrice"]').value),
      conditionPolicy: card.querySelector('[name="conditionPolicy"]').value,
      priceBasis: card.querySelector('[name="priceBasis"]').value,
      adjustmentCents: Number(card.querySelector('[name="adjustmentCents"]').value),
      noComparisonFallback: fallback,
      ...(fallback === "manual" ? { manualPrice: Number(card.querySelector('[name="manualPrice"]').value) } : {}),
    };
  }

  function collectRepricingProfile(card) {
    const rangeCards = [...card.querySelectorAll("[data-range-index]")];
    return {
      id: card.dataset.repricingProfileId,
      name: card.querySelector('[name="profileName"]').value.trim(),
      minimumPrice: Number(card.querySelector('[name="minimumPrice"]').value),
      conditionPolicy: card.querySelector('[name="conditionPolicy"]').value,
      priceBasis: card.querySelector('[name="priceBasis"]').value,
      adjustmentCents: Number(card.querySelector('[name="adjustmentCents"]').value),
      allowPriceIncreases: card.querySelector('[name="allowPriceIncreases"]').checked,
      ranges: rangeCards.map((rangeCard, index) => ({
        ...(index === rangeCards.length - 1
          ? {}
          : { maximumPrice: Number(rangeCard.querySelector('[name="maximumPrice"]').value) }),
        minimumListings: Number(rangeCard.querySelector('[name="minimumListings"]').value),
        priceSource: rangeCard.querySelector('[name="priceSource"]').value,
        percentage: Number(rangeCard.querySelector('[name="percentage"]').value),
        gapThresholdPercent: Number(rangeCard.querySelector('[name="gapThresholdPercent"]').value),
        gapAction: rangeCard.querySelector('[name="gapAction"]').value,
      })),
    };
  }

  function collectSettingsUpdate() {
    const profileCards = [...document.querySelectorAll("#merchandise-profile-list [data-profile-id]")];
    const defaultProfile = document.querySelector('#merchandise-profile-list [name="defaultMerchandiseProfileId"]:checked');
    const repricingProfileCards = [...document.querySelectorAll("#repricing-profile-list [data-repricing-profile-id]")];
    const defaultRepricingProfile = document.querySelector('#repricing-profile-list [name="defaultRepricingProfileId"]:checked');
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
      merchandiseProfiles: profileCards.map(collectMerchandiseProfile),
      defaultMerchandiseProfileId: defaultProfile?.value ?? "",
      repricingProfiles: repricingProfileCards.map(collectRepricingProfile),
      defaultRepricingProfileId: defaultRepricingProfile?.value ?? "",
      outputs: state.settings.outputs.map((output) => {
        const card = outputs.querySelector('[data-action-id="' + CSS.escape(output.actionId) + '"]');
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
      saveDetail.textContent = "";
      saveDetail.hidden = true;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    saveTitle.textContent = "Saving settings";
    saveDetail.hidden = true;
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
      saveDetail.textContent = "";
    } catch (error) {
      saveTitle.textContent = "Settings were not saved";
      saveDetail.textContent = error instanceof Error ? error.message : "Review the values and try again.";
      saveDetail.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save settings";
    }
  });

  form.addEventListener("input", updateSaveBarVisibility);
  form.addEventListener("change", () => {
    updateSaveBarVisibility();
    syncDashboardAutomation();
  });

  document.querySelector("#refresh-printers").addEventListener("click", load);
  document.querySelector("#refresh-dashboard-orders").addEventListener("click", () => void loadOrders("ready-to-ship", true));
  document.querySelector("#refresh-orders").addEventListener("click", () => void loadOrders("all", true));
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
  document.querySelector("#inventory-profile-select").addEventListener("change", (event) => {
    selectMerchandiseProfile(event.target.value);
  });
  document.querySelector("#repricing-profile-select").addEventListener("change", (event) => {
    selectRepricingProfile(event.target.value);
  });
  document.querySelector("#edit-merchandise-profiles").addEventListener("click", () => {
    activateTab("settings", true, true);
    document.querySelector("#merchandise-profiles-title").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelector("#add-merchandise-profile").addEventListener("click", addMerchandiseProfile);
  document.querySelector("#edit-repricing-profiles").addEventListener("click", () => {
    activateTab("settings", true, true);
    document.querySelector("#repricing-profiles-title").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelector("#add-repricing-profile").addEventListener("click", addRepricingProfile);
  const quantityDialog = document.querySelector("#inventory-quantity-dialog");
  document.querySelector("#inventory-quantity-cancel").addEventListener("click", () => quantityDialog.close());
  document.querySelector("#inventory-quantity-apply").addEventListener("click", () => {
    const input = document.querySelector("#inventory-custom-quantity");
    if (!input.reportValidity() || state.inventoryQuantityProductId === null) return;
    const productId = state.inventoryQuantityProductId;
    const product = state.catalogSearch?.products.find((candidate) => candidate.productId === productId);
    if (!product) return;
    quantityDialog.close();
    void queueCatalogProduct(product, Number(input.value));
  });
  document.querySelector("#inventory-custom-quantity").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    document.querySelector("#inventory-quantity-apply").click();
  });
  quantityDialog.addEventListener("close", () => {
    state.inventoryQuantityProductId = null;
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
  activateTab(initialTab());
  load();
  setInterval(loadQueue, 5000);
  setInterval(loadInventoryQueue, 5000);
})();`;
