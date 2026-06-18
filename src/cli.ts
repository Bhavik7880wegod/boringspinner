// src/cli.ts — `boringspinner` standalone terminal CLI.
//
// Makes BoringSpinner fully terminal-native: NO VS Code / Cursor required. It
// reuses the EXACT extension modules — AuthClient (browser+poll OAuth),
// PortfolioClient (real auction), and the claude-cli-spinner adapter — and shares
// the same on-disk state (`~/.coads/auth.json` + keychain, `~/.claude/settings.json`),
// so a login here is picked up by the editor extension and vice-versa.
//
// Commands:
//   login   — Google sign-in (opens browser, polls), then one sync.
//   sync    — fetch the auction queue once and write spinnerVerbs.
//   watch   — sync on a loop (rotates campaigns) until Ctrl-C. No editor needed.
//   status  — show sign-in, CLI compatibility, and the live spinnerVerbs.
//   logout  — revoke the token and restore settings.json from backup.
//
// NOTE (honest scope): the terminal spinner / status-line ad is plain transient
// text Claude renders — there's no clickable link, so no clicks. It DOES now fire
// a billable `view_threshold_met` impression for the ad actually shown, fired only
// from the throttled background refresh and bounded three ways so it can never
// over-charge an advertiser (≤1/refresh, a persistent ≤1/ad/60s client throttle,
// and the server's durable cooldown + $20/day cap — the advertiser is charged
// only when the SERVER credits). The richer clickable overlay still lives in the
// VS Code / Cursor chat panel.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { loadConfig, coadsHomeDirRead } from './config';
import { deriveClientId } from './util/crypto';
import { SecretVault } from './auth/vault';
import { platformSeal } from './auth/seal';
import { AuthClient } from './auth/client';
import { PortfolioClient, type PortfolioResponse, type PatchAd } from './portfolio/client';
import { EarningsClient } from './earnings/client';
import { MetricsClient } from './metrics/client';
import { buildVersion } from './buildinfo';
import { ClaudeCliSpinnerAdapter, PHASE2_AD_TEXT, defaultSettingsPath } from './adapters/claude-cli/adapter';
import { syncOnce } from './activation/cliSync';
import { SLASH_MENU_MD, SLASH_SUBCOMMANDS } from './cli.slash';

// Open a URL in the default browser (best-effort; the URL is also printed).
function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execFile(cmd, [url], () => {});
  } catch {
    /* headless / no browser — the printed URL is the fallback */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Print a prompt and resolve when the user presses Enter (interactive terminals
// only — guard the caller with `process.stdin.isTTY`). Used by the login flow so
// the user controls WHEN we re-check sign-in, instead of relying on a blocking
// 180s poll that can "miss" a slow browser sign-in.
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// Minimal ANSI color — only when stdout is a real TTY (never when piped/captured
// by a slash command), so output stays clean in both places.
const tty = process.stdout.isTTY === true;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => c('1;32', s); // bold green
const yellow = (s: string) => c('33', s);

// --- earnings status line ($$ at the bottom of every `claude` session) ------
// A tiny cache written whenever we fetch earnings (login/sync/earnings/watch). The
// `statusline` command reads it INSTANTLY so the bottom line renders with no
// network call; Claude Code re-runs the command, so it stays current.
const EARN_CACHE = path.join(coadsHomeDirRead(), 'earnings-cache.json');

function writeEarningsCache(s: { today: string; month: string; lifetime: string }): void {
  try {
    fs.mkdirSync(path.dirname(EARN_CACHE), { recursive: true });
    fs.writeFileSync(EARN_CACHE, JSON.stringify({ today: s.today, month: s.month, lifetime: s.lifetime, ts: Date.now() }));
  } catch {
    /* best effort */
  }
}

function readEarningsCache(): { today: string; lifetime: string } | null {
  try {
    const j = JSON.parse(fs.readFileSync(EARN_CACHE, 'utf8'));
    return { today: String(j.today ?? '0.00'), lifetime: String(j.lifetime ?? '0.00') };
  } catch {
    return null;
  }
}

// --- live ad pool for the status line ---------------------------------------
// The status line rotates through the CURRENT live ad pool (so it never gets stuck
// to the set fetched at session start — new advertisers surface continuously). The
// pool is cached locally and refreshed in the background; the `statusline` command
// only ever READS the cache (instant, no network), and opportunistically spawns a
// detached refresh when it's stale, so it stays current without `watch` running.
const ADS_CACHE = path.join(coadsHomeDirRead(), 'ads-cache.json');
const BILL_STATE = path.join(coadsHomeDirRead(), 'bill-state.json'); // per-ad last-billed ts
const ADS_TTL_MS = 30_000; // consider the pool stale after 30s → refresh
const ROTATE_MS = 8_000; // show each ad ~8s before rotating to the next
const REFRESH_THROTTLE_MS = 25_000; // never spawn refreshers faster than this (global)
const BILL_THROTTLE_MS = 60_000; // never bill the same ad more than 1×/60s (matches the server cooldown)

// The status-line ad pool is cached as full ad objects (not just display text) so
// the background refresh can fire a billable impression for the ad actually shown:
// adId / campaignId / sessionToken are exactly what /v1/metrics needs to charge
// the advertiser + credit the publisher.
interface CachedAd { adText: string; adId: string; campaignId: string; sessionToken: string }

// Map an auction queue → the cached ad shape (dropping blank-text entries).
function toCachedAds(ads: PatchAd[]): CachedAd[] {
  return ads
    .map((a) => ({ adText: (a.adText ?? '').trim(), adId: a.adId, campaignId: a.campaignId, sessionToken: a.sessionToken }))
    .filter((a) => a.adText);
}

function writeAdsCache(ads: CachedAd[]): void {
  try {
    fs.mkdirSync(path.dirname(ADS_CACHE), { recursive: true });
    fs.writeFileSync(ADS_CACHE, JSON.stringify({ ads, ts: Date.now() }));
  } catch {
    /* best effort */
  }
}

// Tolerant read: new caches store CachedAd objects; a stale pre-upgrade cache may
// still hold plain strings (display-only — no ids, so not billable). Both parse.
function readAdsCache(): { ads: CachedAd[]; ts: number } {
  try {
    const j = JSON.parse(fs.readFileSync(ADS_CACHE, 'utf8'));
    const raw: unknown[] = Array.isArray(j.ads) ? j.ads : [];
    const ads: CachedAd[] = raw
      .map((a): CachedAd => {
        if (typeof a === 'string') return { adText: a, adId: '', campaignId: '', sessionToken: '' };
        const o = (a ?? {}) as Record<string, unknown>;
        return {
          adText: String(o.adText ?? ''),
          adId: String(o.adId ?? ''),
          campaignId: String(o.campaignId ?? ''),
          sessionToken: String(o.sessionToken ?? ''),
        };
      })
      .filter((a) => a.adText);
    return { ads, ts: Number(j.ts) || 0 };
  } catch {
    return { ads: [], ts: 0 };
  }
}

// If the ad pool is stale, fire a DETACHED background refresh (non-blocking). A
// shared marker file throttles spawns to one per REFRESH_THROTTLE_MS across all
// open sessions, so we never swarm node processes.
function maybeSpawnRefresh(adsTs: number): void {
  const now = Date.now();
  if (now - adsTs < ADS_TTL_MS) return;
  const lock = path.join(coadsHomeDirRead(), 'refresh-spawn.json');
  try {
    const last = Number(JSON.parse(fs.readFileSync(lock, 'utf8')).ts) || 0;
    if (now - last < REFRESH_THROTTLE_MS) return;
  } catch {
    /* no marker yet — fall through and spawn */
  }
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ ts: now }));
    spawn(process.execPath, [process.argv[1], '__refresh-caches'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* best effort */
  }
}

// --- billable status-line impression (conservative, server-capped) ----------
// The background refresh fires ONE `view_threshold_met` for the ad currently shown
// in the status line — the ad the user actually saw (shown ≥ ROTATE_MS, well past
// the ≥3s view threshold). It can NEVER over-charge an advertiser because it is
// bounded three independent ways:
//   1. only the throttled detached refresh calls it (≤1 per REFRESH_THROTTLE_MS),
//   2. a persistent per-ad throttle here (≤1 per ad per BILL_THROTTLE_MS), and
//   3. the server's DURABLE cooldown (≤1 credit / account+surface+ad / 60s) and
//      $20/day cap — and the advertiser is charged ONLY when the server credits.
// We bill on surface `claude-cli-spinner` (what the ad was auctioned + served on,
// and what the campaign bid on) so the server can resolve the per-impression
// charge from that surface's bid; the status line is just where the CLI renders it.

function readBillState(): Record<string, number> {
  try {
    const j = JSON.parse(fs.readFileSync(BILL_STATE, 'utf8'));
    return j && typeof j === 'object' ? (j as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function recordBilled(adId: string, now: number): void {
  try {
    const st = readBillState();
    // Prune entries older than the throttle window so the file can't grow forever.
    for (const k of Object.keys(st)) if (now - Number(st[k]) > BILL_THROTTLE_MS) delete st[k];
    st[adId] = now;
    fs.mkdirSync(path.dirname(BILL_STATE), { recursive: true });
    fs.writeFileSync(BILL_STATE, JSON.stringify(st));
  } catch {
    /* best effort */
  }
}

// Pick the ad currently shown in the status line (same wall-clock rotation as
// cmdStatusline) and — if signed in and within throttle — fire one billable
// impression. Records the throttle BEFORE the await so a racing refresh in another
// process can't double-fire the same ad.
async function billCurrentImpression(metrics: MetricsClient, surface: string, signedIn: boolean): Promise<void> {
  if (!signedIn) return; // signed-out previews are never billable (server returns demo_preview)
  const { ads } = readAdsCache();
  if (ads.length === 0) return;
  const ad = ads[Math.floor(Date.now() / ROTATE_MS) % ads.length];
  if (!ad.adId || !ad.campaignId || !ad.sessionToken) return; // pre-upgrade / demo entry — not billable
  const now = Date.now();
  if (now - Number(readBillState()[ad.adId] ?? 0) < BILL_THROTTLE_MS) return; // billed this ad too recently
  recordBilled(ad.adId, now);
  await metrics.send({
    event: 'view_threshold_met',
    adId: ad.adId,
    campaignId: ad.campaignId,
    surface,
    corr: `${ad.adId}.${Math.random().toString(36).slice(2, 8)}`,
    sessionNonce: ad.sessionToken, // mirrors the terminal/overlay impression path
    sessionToken: ad.sessionToken,
    visibleMs: ROTATE_MS,
    viewable: true,
    viewPct: 1.0,
    viewMs: ROTATE_MS,
  });
}

// Add a Claude Code statusLine that shows earnings at the bottom of the terminal.
// Only sets it when absent or already ours — NEVER clobbers a user's own statusLine.
function wireStatusLine(): boolean {
  const p = defaultSettingsPath();
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    /* fresh / missing settings.json */
  }
  const ex = obj.statusLine as { command?: unknown } | undefined;
  const ours =
    !!ex &&
    typeof ex.command === 'string' &&
    ex.command.includes('statusline') &&
    ex.command.toLowerCase().includes('boringspinner');
  if (ex && !ours) return false; // respect an existing custom statusLine
  // Absolute command (this node + this cli.js) so it runs regardless of the PATH
  // Claude Code's statusLine shell has — a common "nothing shows" cause otherwise.
  const self = `"${process.execPath}" "${process.argv[1]}" statusline`;
  obj.statusLine = { type: 'command', command: self, padding: 0 };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Refresh the cached earnings + ensure the bottom-of-terminal line is wired on.
async function refreshEarningsLine(earnings: EarningsClient): Promise<void> {
  const s = await earnings.fetch().catch(() => null);
  if (s) writeEarningsCache(s);
  wireStatusLine();
}

// Build the same client graph the extension constructs (minus vscode bits).
function deps() {
  const config = loadConfig();
  const adapter = new ClaudeCliSpinnerAdapter(); // → ~/.claude/settings.json
  const vault = new SecretVault({
    root: coadsHomeDirRead(), // ~/.coads — same file the extension uses
    seal: platformSeal(), // Keychain/DPAPI/libsecret — interop with the extension
  });
  const auth = new AuthClient({ backendBase: config.backendBase, vault, open: openUrl });
  const clientId = deriveClientId();
  const portfolio = new PortfolioClient({
    backendBase: config.backendBase,
    clientId,
    claudeCodeVersion: adapter.version() ?? 'unknown',
    getAccessToken: () => auth.getAccessToken(),
    refresh: () => auth.refresh(), // recover an expired access token instead of dropping to demo
  });
  const earnings = new EarningsClient({
    backendBase: config.backendBase,
    clientId, // server keys on email now; clientId is harmless/back-compat
    getAccessToken: () => auth.getAccessToken(),
    refresh: () => auth.refresh(),
  });
  // Fires the billable status-line impression. Routes to /v1/metrics (bearer) when
  // signed in, /v1/metrics/demo (no charge) otherwise; self-heals an expired token.
  const metrics = new MetricsClient({
    backendBase: config.backendBase,
    clientId,
    claudeCodeVersion: adapter.version() ?? 'unknown',
    extensionVersion: buildVersion(),
    ext: { os: process.platform, arch: process.arch, os_version: os.release(), editor: 'claude-cli' },
    getAccessToken: () => auth.getAccessToken(),
    refresh: () => auth.refresh(),
  });
  return { config, adapter, auth, portfolio, earnings, metrics };
}

// Write the current auction queue into spinnerVerbs (one pass). Returns the
// fetched portfolio (for cadence + reporting) or null on a network failure.
async function syncPass(
  adapter: ClaudeCliSpinnerAdapter,
  portfolio: PortfolioClient,
): Promise<PortfolioResponse | null> {
  const res = await portfolio.fetch();
  if (!res) return null;
  const verbs = res.ads.map((a) => a.adText.trim()).filter(Boolean);
  writeAdsCache(toCachedAds(res.ads)); // feed the rotating status-line ad pool (full objects → billable)
  syncOnce({
    adapter,
    enabled: () => true,
    killPosture: () => 'clear',
    adText: () => verbs[0] ?? PHASE2_AD_TEXT,
    verbs: () => verbs,
  });
  return res;
}

function readSpinnerVerbs(): string[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(defaultSettingsPath(), 'utf8')) as { spinnerVerbs?: { verbs?: string[] } | string[] };
    const sv = j.spinnerVerbs;
    if (Array.isArray(sv)) return sv;
    if (sv && Array.isArray(sv.verbs)) return sv.verbs;
    return [];
  } catch {
    return null;
  }
}

function preflightLine(adapter: ClaudeCliSpinnerAdapter): { ok: boolean; line: string } {
  const pf = adapter.preflight();
  if (pf.compatible) return { ok: true, line: `Claude Code CLI ${pf.version} — compatible` };
  return { ok: false, line: `⚠ ${pf.reason ?? 'Claude Code CLI not usable'}` };
}

function reportQueue(res: PortfolioResponse): void {
  const demo = res.ads[0]?.demo === true;
  if (demo) {
    console.log(yellow('⚠ Signed out — showing sample ads (not real campaigns, no earnings):'));
  } else {
    console.log(green('✓ Campaigns are now live in your spinner:'));
  }
  for (const a of res.ads) console.log(`    • ${a.adText}`);
  if (demo) console.log('  Run `boringspinner login` to show real campaigns from advertisers.');
}

async function cmdLogin(): Promise<number> {
  const { auth, adapter, portfolio, earnings } = deps();
  if (await auth.loadCached()) {
    // Already have a session — recognize it WITHOUT forcing a network refresh. The
    // refresh token is single-use and shared with the editor extension, so a forced
    // refresh here can race/fail and needlessly send you back to Google. syncPass
    // uses the access token and self-heals on a genuine 401.
    console.log(`Already signed in as ${auth.getEmail() ?? 'your account'}.`);
    await syncPass(adapter, portfolio);
    await refreshEarningsLine(earnings);
    console.log(green('✓ BoringSpinner is now live — start earning.'));
    console.log('  Your earnings now show at the bottom of every new `claude` session.');
    return 0;
  }
  // Manual start→open→poll so we can PRINT the URL (headless fallback).
  const started = await auth.start();
  console.log('\nOpen this URL to sign in with Google (opening your browser now):\n');
  console.log('  ' + started.url + '\n');
  openUrl(started.url);

  const pollMs = started.pollMs || 1500;
  let signedIn = false;
  if (process.stdin.isTTY) {
    // INTERACTIVE terminal: let the user tell us when they're done. After they
    // finish in the browser they press Enter, and we do ONE short bounded check.
    // This fixes the "signed in on Google but the terminal never noticed" issue
    // (Srijan's) — a slow browser sign-in can't be missed because the user, not a
    // 180s timer, drives the re-check, and they can retry as many times as needed.
    for (let attempt = 1; attempt <= 30 && !signedIn; attempt++) {
      await waitForEnter('\nSign in complete? Press Enter here to refresh and finish… ');
      process.stdout.write('Checking… ');
      signedIn = await auth.poll(started.state, pollMs, 8_000); // short bounded poll
      if (signedIn) {
        console.log('done.');
      } else {
        console.log('not signed in yet.');
        console.log('  Finish signing in in the browser, then press Enter again. (Ctrl-C to cancel.)');
      }
    }
  } else {
    // NON-interactive (e.g. a `/boringspinner` slash command captures stdin —
    // there's no Enter to wait for): fall back to the blocking 180s auto-poll.
    console.log('Waiting for you to finish in the browser…');
    signedIn = await auth.poll(started.state, pollMs);
  }

  if (!signedIn) {
    console.error('✗ Sign-in did not complete (timed out or was cancelled).');
    return 1;
  }
  console.log(`Signed in as ${auth.getEmail() ?? '(unknown)'}.`);
  await syncPass(adapter, portfolio); // write the campaigns to the spinner silently
  await refreshEarningsLine(earnings); // populate the cache + wire the $$ status line
  console.log(green('✓ Sign in complete — BoringSpinner is now live, start earning.'));
  console.log('  Your earnings now show at the bottom of every new `claude` session.');
  return 0;
}

async function cmdSync(): Promise<number> {
  const { auth, adapter, portfolio } = deps();
  const pf = preflightLine(adapter);
  if (!pf.ok) {
    console.error(pf.line);
    console.error('The terminal spinner needs Claude Code CLI ≥ 2.1.143.');
    return 1;
  }
  await auth.loadCached();
  const res = await syncPass(adapter, portfolio);
  if (!res) {
    console.error('✗ Could not reach api.boringspinner.com — settings.json left unchanged.');
    return 1;
  }
  reportQueue(res);
  return 0;
}

async function cmdWatch(): Promise<number> {
  const { auth, adapter, portfolio, earnings } = deps();
  const pf = preflightLine(adapter);
  console.log(pf.line);
  if (!pf.ok) return 1;
  await auth.loadCached();
  console.log(`Watching as ${auth.getEmail() ?? 'signed-out (demo)'} — Ctrl-C to stop.\n`);
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    console.log('\nStopping watch.');
    process.exit(0);
  });
  while (!stop) {
    const res = await syncPass(adapter, portfolio);
    const when = new Date().toTimeString().slice(0, 8);
    if (res) {
      const demo = res.ads[0]?.demo === true;
      console.log(`[${when}] synced ${res.ads.length} verb(s)${demo ? ' (demo)' : ''}`);
      await refreshEarningsLine(earnings); // keep the bottom-of-terminal $$ line current
      await sleep(res.rotationIntervalMs); // already floored ≥ 15s by clampFloors
    } else {
      console.log(`[${when}] offline — retrying in 30s`);
      await sleep(30_000);
    }
  }
  return 0;
}

async function cmdStatus(): Promise<number> {
  const { auth, adapter } = deps();
  const signedIn = await auth.loadCached();
  console.log('BoringSpinner — terminal status\n');
  console.log(`  Account : ${signedIn ? auth.getEmail() || '(signed in)' : 'signed out (demo ads, no earnings)'}`);
  console.log(`  ${preflightLine(adapter).line}`);
  const verbs = readSpinnerVerbs();
  if (verbs === null) console.log('  Spinner : ~/.claude/settings.json missing or unreadable');
  else if (verbs.length === 0) console.log('  Spinner : no spinnerVerbs set yet — run `boringspinner sync`');
  else {
    console.log(`  Spinner : ${verbs.length} verb(s) in ~/.claude/settings.json`);
    for (const v of verbs) console.log(`      • ${v}`);
  }
  if (!signedIn) console.log('\n  Run `boringspinner login` to serve your real campaigns.');
  return 0;
}

async function cmdLogout(): Promise<number> {
  const { auth, adapter } = deps();
  await auth.loadCached();
  await auth.revoke(); // POST /v1/auth/revoke + clear keychain + auth.json
  const r = adapter.restore(); // put settings.json back to its pre-ad backup (drops the statusLine too)
  try {
    fs.rmSync(EARN_CACHE, { force: true });
  } catch {
    /* best effort */
  }
  console.log('✓ Signed out and cleared the saved token.');
  console.log(r.restored ? '✓ Restored ~/.claude/settings.json from backup.' : `  settings.json: ${r.reason ?? 'nothing to restore'}`);
  return 0;
}

async function cmdEarnings(): Promise<number> {
  const { auth, earnings } = deps();
  if (!(await auth.loadCached())) {
    console.log('Signed out — run `boringspinner login` to see your earnings.');
    return 1;
  }
  const s = await earnings.fetch();
  if (!s) {
    console.error('✗ Could not load earnings (offline, or token expired — try `boringspinner login`).');
    return 1;
  }
  writeEarningsCache(s); // refresh the bottom-of-terminal $$ line
  wireStatusLine();
  console.log(`BoringSpinner earnings — ${auth.getEmail() ?? 'your account'}\n`);
  console.log(`  Today     : $${s.today}`);
  console.log(`  This month: $${s.month}`);
  console.log(`  Lifetime  : $${s.lifetime}`);
  console.log('\n  Your terminal spinner now earns from impressions; the VS Code/Cursor overlay adds clicks too.');
  return 0;
}

// Install the `/boringspinner` slash commands into ~/.claude/commands/ so users
// can sign in / check status + earnings from the `/` menu (terminal AND editor).
async function cmdInit(): Promise<number> {
  const base = path.join(os.homedir(), '.claude', 'commands');
  const sub = path.join(base, 'boringspinner');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(base, 'boringspinner.md'), SLASH_MENU_MD, 'utf8');
  for (const [name, body] of Object.entries(SLASH_SUBCOMMANDS)) {
    fs.writeFileSync(path.join(sub, `${name}.md`), body, 'utf8');
  }
  const names = ['', ...Object.keys(SLASH_SUBCOMMANDS)];
  console.log('✓ Installed BoringSpinner slash commands → ~/.claude/commands/boringspinner/\n');
  console.log('  Type `/boringspinner` in Claude Code (terminal or editor):');
  for (const n of names) console.log(`    /boringspinner${n ? ':' + n : ''}`);
  console.log('\n  Restart your `claude` session (or reload the editor) to pick them up.');
  return 0;
}

// Claude Code statusLine command (wired into ~/.claude/settings.json by login).
// Prints the cached earnings line at the bottom of the terminal — INSTANT (cache
// only, no network) since Claude Code re-runs this on every render.
// Internal: background refresh of the live ad pool + earnings caches. Spawned
// detached by the status line when its caches go stale — keeps everything current
// (new advertisers within ~30s) WITHOUT a foreground process or `watch`.
async function cmdRefreshCaches(): Promise<number> {
  const { auth, portfolio, earnings, metrics, adapter } = deps();
  const signedIn = await auth.loadCached();
  // Bill the impression for the ad currently shown — reads the OLD pool, so it
  // bills the ad the user actually saw, BEFORE we overwrite the cache below.
  await billCurrentImpression(metrics, adapter.name, signedIn).catch(() => {});
  const res = await portfolio.fetch().catch(() => null);
  if (res) writeAdsCache(toCachedAds(res.ads));
  const s = await earnings.fetch().catch(() => null);
  if (s) writeEarningsCache(s);
  return 0;
}

// Claude Code statusLine command (re-run by Claude on every render). Shows a
// rotating sponsored line from the CURRENT live ad pool + today's earnings —
// INSTANT (cache only, no network) and always-fresh (it triggers a throttled
// background refresh when the pool is stale, so it never sticks to the startup set).
function cmdStatusline(): number {
  const g = (s: string) => `\x1b[1;32m${s}\x1b[0m`; // bold green (statusLine renders ANSI)
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const { ads, ts } = readAdsCache();
  const earn = readEarningsCache();
  maybeSpawnRefresh(ts); // keep the pool current in the background

  let line = '';
  if (ads.length > 0) {
    // Rotate through the live pool by wall-clock: the ad changes ~every 8s and
    // always reflects the latest fetched campaigns (new advertisers included).
    line = ads[Math.floor(Date.now() / ROTATE_MS) % ads.length].adText;
  }
  if (earn) {
    const tail = `BoringSpinner ${g('$' + earn.today)} today`;
    line = line ? `${line}  ${dim('·')}  ${tail}` : tail;
  } else if (!line) {
    line = 'BoringSpinner — run `boringspinner login` to see ads + earnings';
  }
  process.stdout.write(line);
  return 0;
}

function usage(): void {
  console.log(`boringspinner — earn from ads in your terminal's Claude Code spinner

Usage: boringspinner <command>

  login    Sign in / sign up with Google (opens your browser), then sync once
  sync     Fetch your campaigns and write the spinner verbs once
  watch    Keep the spinner synced + rotating (runs until Ctrl-C; no editor needed)
  status   Show sign-in, CLI compatibility, and the current spinner verbs
  earnings Show today / month / lifetime earnings
  logout   Revoke the token and restore settings.json
  init     Install /boringspinner slash commands into ~/.claude/commands/

Notes:
  • After login, your earnings show at the bottom of every \`claude\` session (a
    statusLine). Run \`boringspinner watch\` to keep that line live-updating.
  • Reads/writes the global ~/.claude/settings.json, so EVERY terminal running
    \`claude\` picks up the ads — start a NEW \`claude\` session to see changes.
  • The terminal spinner now earns from impressions (transient text, no click).
    Clicks + the richer clickable overlay come from the VS Code/Cursor chat panel.`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  let code = 0;
  switch (cmd) {
    case 'login':
    case 'signup': code = await cmdLogin(); break;
    case 'sync': code = await cmdSync(); break;
    case 'watch': code = await cmdWatch(); break;
    case 'status': code = await cmdStatus(); break;
    case 'earnings': code = await cmdEarnings(); break;
    case 'statusline': code = cmdStatusline(); break; // internal: Claude Code statusLine
    case '__refresh-caches': code = await cmdRefreshCaches(); break; // internal: background pool/earnings refresh
    case 'logout': code = await cmdLogout(); break;
    case 'init': code = await cmdInit(); break;
    case undefined:
    case '-h':
    case '--help':
    case 'help': usage(); break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      code = 2;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('✗ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
