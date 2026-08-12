# TCGPlayerAlert Session Connector privacy policy

Effective date: August 11, 2026

The TCGPlayerAlert Session Connector exists only to connect an authorized,
signed-in TCGplayer Seller Portal browser session to the TCGPlayerAlert
application running on the same computer. This project is not affiliated with,
endorsed by, or supported by TCGplayer.

## Data handled

The connector handles the following data solely to provide its stated
function:

- The value and expiration time, when present, of the exact
  `TCGAuthTicket_Production` cookie set by `store.tcgplayer.com`. This is
  authentication information and must be treated like a password.
- A one-time pairing code entered by the user.
- A random connector token and the loopback port returned by the local
  TCGPlayerAlert application.

The connector does not inspect Seller Portal pages, browsing history, orders,
messages, payments, inventory, or page content. It contains no analytics,
advertising, tracking, or remotely downloaded code.

## Transmission and use

The connector sends the current authentication cookie and its expiration time
only to the paired TCGPlayerAlert application at
`http://127.0.0.1:<port>/api/auth/session`. It does this when the user first
pairs the browser, when the user selects **Refresh session**, when the browser
reports that the exact cookie changed, and during a five-minute local renewal
check while the connector is paired. Before initial pairing, the connector
prominently explains this transmission and the user must select **Connect and
share session**.

The connector does not send this information to the project maintainer,
Mozilla, advertising or analytics services, or any other remote service. The
local application uses the session only to authenticate seller operations that
the user is authorized to perform with TCGplayer.

## Storage and retention

The extension stores only its random connector token and selected local port in
browser extension-local storage. It does not store the TCGplayer authentication
cookie outside the browser's cookie store.

The local TCGPlayerAlert application stores its current session, seller key,
and matching connector token in its ignored local data directory after
encrypting them with Windows DPAPI for the current Windows user. The application
does not return those credentials to its web interface or write them to logs.

Selecting **Disconnect** in TCGPlayerAlert removes the usable application
session and invalidates the connector token. Removing the extension or clearing
its extension data removes its local token and port. TCGplayer controls the
Seller Portal cookie and its expiration.

## Permissions

- `cookies` and access to `https://store.tcgplayer.com/*` are used only to read
  the exact seller authentication cookie described above.
- Access to `http://127.0.0.1/*` is used only to communicate with the local
  TCGPlayerAlert application.
- `storage` retains the random connector token and local port.
- `alarms` schedules the five-minute local renewal check.

## Questions and changes

Privacy questions and policy changes are tracked through the public project at
<https://github.com/Reldnahc/TCGPlayerAlert/issues>. Material changes to the
data handled or its destination require an updated disclosure and extension
release.

## Chrome Web Store Limited Use disclosure

The connector's use of information received from browser APIs complies with
the Chrome Web Store User Data Policy, including the Limited Use requirements.
Authentication information is used only to provide the connector's single,
user-facing purpose. It is not sold, used for advertising or creditworthiness,
transferred to third parties, or made available for human review. It is sent
only to the user-installed TCGPlayerAlert application on the same computer.
