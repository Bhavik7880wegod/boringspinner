# BoringSpinner — Source-available VS Code extension

> A single one-line sponsored slot lives in the wait between your prompt and the AI’s answer. Half of each auction price is credited to the developer who hosted the slot during their session.

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=boringspinner.boringspinner) · [Open VSX](https://open-vsx.org/extension/boringspinner/boringspinner) · [boringspinner.com](https://boringspinner.com)

---

## Why this repo exists

This is the **source code of the extension that runs on your machine**, published for public verification. The backend, web app, ad-auction engine, and ledger are proprietary and remain private — this repo is the client surface only.

Source-available, not open-source. See [`LICENSE`](./LICENSE). Read it, audit it, file issues. Don't fork, redistribute, or build a derivative.

---

## What this extension actually does on your machine

We make strong privacy claims publicly. This section tells you exactly which lines of code back them up so you can verify rather than trust.

### 1. It never reads your code, prompts, files, or terminal contents

- No `vscode.workspace.fs.readFile` calls against arbitrary files.
- No reads of `vscode.window.activeTextEditor.document.getText()`.
- No interception of Claude Code prompts, responses, or chat history.
- No terminal scrollback capture.

Search the source yourself — those APIs are not used.

### 2. Contextual targeting is opt-in and self-declared

Ad targeting works in **exactly one way**:

- During onboarding you optionally pick interest categories (e.g. `python`, `ai-ml`, `devops`) from a fixed list.
- That list of self-declared tags is sent to the auction.
- Advertisers whose campaigns match a tag get a relevance boost in the auction; non-matching ads still serve normally.

The extension does **not** infer interests from your code, file extensions, project structure, package.json, or workspace contents. If you don't pick any interests, you see untargeted ads.

The relevant code lives in `src/onboarding/` (the prompt) and the backend's `auction.ts` (the `publisherInterests` field).

### 3. Exactly three network destinations

- `https://api.boringspinner.com` — auction, ledger, payout, telemetry beacons (impression/click events).
- `https://marketplace.visualstudio.com` / `https://open-vsx.org` — extension updates (managed by VS Code, not by us).
- `http://127.0.0.1:<random>` — local loopback for the OAuth sign-in callback. Bound to localhost only.

That's the entire network surface. There is no third-party tracker, analytics SDK, or telemetry vendor.

### 4. Sign-in is Google OAuth — no password, no email scraping

Sign-in opens a browser tab to `accounts.google.com`. We receive your verified email address (so payouts and ad credit go to the right account) and a refresh token, sealed in your OS keychain. We never see your Google password.

### 5. Earnings are credited only after a real view

An ad has to be on-screen for ≥ 3 seconds AND pass a per-device cooldown gate before any money moves. A spinner that flashes for 200ms credits nobody — not the advertiser, not the developer. The relevant logic is in `src/lib/billable-event.ts` and (server-side) `auction.ts` + `fraud.ts`.

---

## What lives in this repo

```
src/
├── extension.ts              Top-level activation
├── auth/                     Google OAuth device-flow client
├── surfaces/                 The five ad surfaces (overlay, statusline, etc.)
├── api/                      Talks to api.boringspinner.com (typed client)
├── onboarding/               Interest opt-in + Stripe Connect setup
├── lib/                      Shared utilities (billing event, cooldown, etc.)
└── ...
test/                         vitest unit + integration suite
media/                        icons + branding (logo trademark; see LICENSE §5)
```

What's NOT here (and won't be):

- `coads-backend/` — the auction engine, ledger, fraud detection, billing, advertiser admin
- `coads-web/` — the boringspinner.com site, dashboard, advertiser portal
- Database schemas, Stripe Connect logic, moderation tools
- Any secret, API key, or credential

That's intentional. The extension is published so users can audit what runs locally; the rest is the product.

---

## The five ad surfaces

| Surface ID | Host | Where the ad shows |
|---|---|---|
| `claude-overlay` | Claude Code (VS Code) | webview overlay panel |
| `claude-banner` | Claude Code (VS Code) | usage-limit banner |
| `codex-shimmer` | Codex (VS Code) | thinking shimmer |
| `claude-cli-statusline` | Claude Code (terminal) | bottom status line |
| `claude-cli-spinner` | Claude Code (terminal) | spinner verb (between prompt and response) |

Each surface is a separate adapter under `src/surfaces/`. They all do the same thing: render one line of plain text from the auction queue. No banners, no popovers, no rich media, no auto-clicking.

---

## How earnings work (the short version)

1. You install the extension and sign in with Google.
2. The extension polls the backend every ~30 seconds for a personalized ad queue.
3. While Claude Code is generating, the spinner cycles through queued ads.
4. Each ad that's visible for ≥ 3 seconds AND passes the cooldown gate fires a billable impression event.
5. The advertiser is charged. The publisher (you) is credited 50% of that charge. The other 50% covers serving costs and operations.
6. Clicks pay 50× a view, billed separately.
7. Stripe Connect pays your balance to your bank when the holding window clears.

The auction is open. Highest bid per 1,000 views shows first. Smaller bidders still rotate in via a weighted random sample — the queue is never empty, and the top bidder doesn't monopolize 100% of impressions.

---

## Building locally (for verification only — see LICENSE §3)

```bash
npm install
npm run build     # esbuild → dist/extension.js
npm test          # vitest suite
```

You can run the built `.vsix` against your own VS Code instance to confirm behavior matches what we claim. You **cannot** repackage, redistribute, fork, or run a modified version against real users — that's a license violation.

---

## Reporting issues

- **Bugs**: open a GitHub issue here.
- **Security**: please email `support@boringspinner.com` privately before public disclosure. We'll acknowledge within 24 hours.
- **Privacy concerns**: if you read this source and believe a claim above is false, that's the highest-priority issue we can receive. Email `support@boringspinner.com` with the file + line number.

---

## Trademarks

"BoringSpinner" and the orange spinner ring are trademarks of BoringSpinner. The license to view this source does not grant trademark rights — see LICENSE §5.

---

`support@boringspinner.com` · `support@boringspinner.com`
