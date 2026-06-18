// src/extension.ts — activate() / deactivate() entry point.
//
// Phase 3 scope (§5.6 steps 10–13, 19): construct AuthClient / PortfolioClient /
// MetricsClient / EarningsClient / ConsentClient; loadCached() (keychain → file);
// signed-in → real portfolio + 30s earnings refresh → Active status; signed-out
// → demo portfolio + `BoringSpinner: Sign in`; wire coads.signIn / coads.signOut to the
// real flow; onSignedIn → refresh portfolio + reload nudge; wire ViewTimer →
// MetricsClient so view events post. Demo serves regardless of sign-in (§5.11).
//
// Auction queue (Phase 4), webview surfaces / loopback (Phase 5), kill-switch
// fail-closed boot gate (Phase 6) remain TODO(Phase N).

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from './config';
import { initLog, dlog } from './log';
import { buildLabel, buildVersion } from './buildinfo';
import { StatusBar } from './statusbar';
import { registerCommands } from './activation/commands';
import { ClaudeCliSpinnerAdapter, PHASE2_AD_TEXT } from './adapters/claude-cli/adapter';
import { createTerminalAdProvider, type TerminalAdLink } from './adapters/claude-terminal/provider';
import { restoreVscodeSpinnerVerb } from './adapters/claude-vscode/spinnerVerbs';
import { startWebviewInjection, type OverlaySession } from './activation/webviewInjection';
import { setupCliSync } from './activation/cliSync';
import { ReloadSignal } from './reloadSignal';
import type { KillPosture } from './servingGate';
import { coadsHomeDirRead } from './config';

import { SecretVault } from './auth/vault';
import { platformSeal } from './auth/seal';
import { AuthClient } from './auth/client';
import { PortfolioClient, isQuoteAd } from './portfolio/client';
import { MetricsClient } from './metrics/client';
import { EarningsClient } from './earnings/client';
import { ConsentClient } from './consent/client';
import { SessionState } from './sessionState';
import { deriveClientId } from './util/crypto';
import { ViewTimer, type ViewEvent } from './viewTracking/timer';
import { setupEarningsRefresh } from './activation/earningsRefresh';
import { wireViewMetrics } from './activation/cliTick';

let statusBar: StatusBar | undefined;
let reloadSignal: ReloadSignal | undefined;
let overlaySession: OverlaySession | null = null; // claude-overlay webview surface
const disposers: Array<() => void> = [];

export function activate(ctx: vscode.ExtensionContext): void {
  // §5.6 step 1: config + env.
  initLog();
  const config = loadConfig();
  dlog(`activate — ${buildLabel()} — backendBase=${config.backendBase}`);

  // §5.6 steps 3–5: locate + construct the claude-cli-spinner adapter (surface 5).
  const spinnerAdapter = new ClaudeCliSpinnerAdapter();
  const pf = spinnerAdapter.preflight();
  dlog(`[claude-cli-spinner] preflight — compatible=${pf.compatible} version=${pf.version ?? 'none'}`);

  // The VS Code Claude Code CHAT PANEL reads the spinner verb from VS Code user
  // settings (claudeCode.spinnerVerbs), NOT ~/.claude/settings.json. Derive that
  // file from globalStorageUri (<userDataDir>/User/globalStorage/<ext> → up two).
  const vscodeSettingsPath = path.join(ctx.globalStorageUri.fsPath, '..', '..', 'settings.json');
  // The chat-panel ad is now the real webview overlay (below) — so
  // drop the earlier claudeCode.spinnerVerbs stopgap that replaced the "thinking"
  // word with bare ad text. Leaves the rest of the user's settings untouched.
  restoreVscodeSpinnerVerb(vscodeSettingsPath);

  // §5.6 step 6: status bar (signed-out by default).
  statusBar = new StatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // §5.6 step 10: construct the Phase-3 clients.
  const clientId = deriveClientId();
  const vault = new SecretVault({
    root: coadsHomeDirRead(),
    secretStore: ctx.secrets, // Layer 1 (§10.1)
    seal: platformSeal(), // Layer 2 platform seal (Keychain/DPAPI/libsecret/file)
    onPlaintextWarn: () => dlog('[vault] plaintext floor in use — refresh token unsealed'),
  });

  const auth = new AuthClient({
    backendBase: config.backendBase,
    vault,
    open: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    onSignedIn: () => onSignedIn(),
  });

  const getAccessToken = () => auth.getAccessToken();
  let demoted = false; // set when a signed-in token dies mid-session (§6.2)

  const portfolio = new PortfolioClient({
    backendBase: config.backendBase,
    clientId,
    claudeCodeVersion: spinnerAdapter.version() ?? 'unknown',
    getAccessToken,
    // Recover an expired access token on 401 (single-flight refresh) instead of
    // silently dropping to the demo queue — keeps the REAL portfolio served.
    refresh: () => auth.refresh(),
  });

  const metrics = new MetricsClient({
    backendBase: config.backendBase,
    clientId,
    claudeCodeVersion: spinnerAdapter.version() ?? 'unknown',
    extensionVersion: buildVersion(),
    ext: {
      os: process.platform,
      arch: process.arch,
      os_version: os.release(),
      editor: vscode.env.appName,
    },
    getAccessToken,
    isDemoted: () => demoted,
    // Recover an expired access token on 401 (single-flight refresh) + retry, so
    // billable impression / click events keep recording (§10.1) instead of
    // silently 401-dropping mid-session — same recovery as PortfolioClient.
    refresh: () => auth.refresh(),
  });

  const earnings = new EarningsClient({
    backendBase: config.backendBase,
    clientId, // read publisherAccount(device) — the account credits land in (not email)
    getAccessToken,
    // Recover an expired token on 401 + retry, so the status bar shows real
    // earnings instead of $0.00 when the access token has expired (§10.1).
    refresh: () => auth.refresh(),
  });
  const consent = new ConsentClient({ backendBase: config.backendBase, getAccessToken });
  void consent; // wired into the consent prompt path (Phase 3 keeps it light)

  // §5.6 step 8: session state.
  const session = new SessionState();

  // §5.6 step 15: cliSync — keep settings.json synced (gated; demo serves too).
  const enabled = (): boolean =>
    vscode.workspace.getConfiguration('coads').get<boolean>('enabled', true);
  const killPosture = (): KillPosture => 'clear'; // TODO(Phase 6): KillSwitchClient
  const cliSync = setupCliSync({
    adapter: spinnerAdapter,
    enabled,
    killPosture,
    adText: () => session.currentAd()?.adText ?? PHASE2_AD_TEXT,
    // Write the WHOLE auction queue as the spinner rotation set so Claude Code
    // rotates across every sampled campaign (not just the head). Falls back to
    // the hardcoded ad only when the queue is empty (signed-out / pre-fetch).
    verbs: () => {
      const all = session.allAdTexts();
      return all.length > 0 ? all : [PHASE2_AD_TEXT];
    },
  });

  // §5.6 step 16: view-tick → MetricsClient. The ViewTimer emits billable
  // events; each posts via MetricsClient (routes to /demo when signed out).
  const viewTimer = new ViewTimer({
    thresholdMs: session.getViewThresholdMs(),
    onEvent: (e: ViewEvent) => {
      const ad = session.currentAd();
      void metrics.send({
        event: e.event,
        adId: e.adId,
        campaignId: ad?.campaignId ?? '',
        surface: e.surface,
        corr: `${e.adId}.${Math.random().toString(36).slice(2, 8)}`,
        sessionNonce: e.sessionNonce,
        sessionToken: ad?.sessionToken ?? '',
        visibleMs: e.visibleMs,
        viewable: true,
        viewPct: 1.0,
        viewMs: e.visibleMs,
      });
    },
  });
  const tick = wireViewMetrics(viewTimer);
  disposers.push(() => tick.dispose());

  // New render target (additive): show the SAME head ad in the VS Code integrated
  // terminal when `claude` is running, via a TerminalLinkProvider on Claude Code's
  // spinner line. Reuses session/metrics/dedupe + the claude-cli-spinner surface.
  // The DOM .spinnerRow_ overlay surface is untouched.
  const termAds = createTerminalAdProvider({
    getAd: () => session.currentAd(),
    metrics,
    openExternal: (url) => {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });
  const termLinkProvider: vscode.TerminalLinkProvider<TerminalAdLink> = {
    provideTerminalLinks: (context) =>
      termAds.provideTerminalLinks({
        line: context.line,
        terminal: { name: context.terminal.name },
      }),
    handleTerminalLink: (link) => {
      termAds.handleTerminalLink(link);
    },
  };
  ctx.subscriptions.push(vscode.window.registerTerminalLinkProvider(termLinkProvider));

  // §5.6 step 11–12: load cached tokens, then fetch the right portfolio.
  const refreshPortfolioNow = async (): Promise<void> => {
    const res = await portfolio.fetch();
    if (res) {
      session.setQueue(res.ads, {
        viewThresholdMs: res.viewThresholdMs,
        rotationIntervalMs: res.rotationIntervalMs,
      });
      session.setBalances(res.balances);
      cliSync.syncOnce();
      const head = session.currentAd();
      if (head) {
        // Over daily cap: the head is a "Thought of the Day". A quote is NOT
        // billable — don't arm the view-threshold timer (and the injected overlay
        // also suppresses its own impression/threshold/click beacons when the
        // creative has no adId, and renders the 💭 quote as a non-clickable line).
        // A real paid ad arms the timer exactly as before.
        if (isQuoteAd(head)) viewTimer.stop();
        else viewTimer.show(head.adId, spinnerAdapter.name, head.sessionToken);
        // §5.8/§5.9 claude-overlay: inject the real clickable sponsored hyperlink
        // into Claude Code's webview; the anchor opens the
        // advertiser URL and a click fires the loopback billing beacon → `click`
        // metric. Applied once; torn down on sign-out / deactivate.
        if (!overlaySession) {
          overlaySession = await startWebviewInjection(
            { adId: head.adId, adText: head.adText, clickUrl: head.clickUrl, iconUrl: head.iconUrl },
            {
              enabled: vscode.workspace.getConfiguration('coads').get<boolean>('enabled', true),
              killPosture: 'clear',
              viewThresholdMs: res.viewThresholdMs,
              onClick: (q) => {
                // The overlay rotates per message, so resolve the ad ACTUALLY
                // shown (the beacon sends its adId) and bill THAT campaign — not
                // always the head. Falls back to the head if the id is unknown.
                const clickedId = q.get('ad');
                const ad =
                  session.getQueue().find((a) => a.adId === clickedId) ?? session.currentAd();
                if (!ad) return;
                void metrics.send({
                  event: 'click',
                  adId: ad.adId,
                  campaignId: ad.campaignId,
                  surface: q.get('surface') ?? 'claude-cli-spinner',
                  corr: q.get('corr') ?? `${ad.adId}.click`,
                  sessionNonce: ad.sessionToken,
                  sessionToken: ad.sessionToken,
                });
              },
              onLog: (q) => {
                dlog('[claude-overlay]', q.toString());
                // Promote the overlay's view-threshold beacon (a LOG event) to a
                // REAL billable impression so the rotated ad ACTUALLY shown credits
                // the publisher. The backend bills view_threshold_met (advertiser
                // charged + publisher credited); MetricsClient stamps a fresh UUID
                // nonce so each per-message impression is distinct. Then repaint the
                // status bar $$ immediately instead of waiting for the 30s poll.
                if (q.get('ev') === 'view_threshold_met') {
                  const adId = q.get('ad');
                  const ad = session.getQueue().find((a) => a.adId === adId) ?? session.currentAd();
                  if (!ad) return;
                  void metrics
                    .send({
                      event: 'view_threshold_met',
                      adId: ad.adId,
                      campaignId: ad.campaignId,
                      surface: q.get('surface') ?? 'claude-overlay',
                      corr: q.get('corr') ?? `${ad.adId}.view`,
                      sessionNonce: ad.sessionToken,
                      sessionToken: ad.sessionToken,
                      viewable: true,
                      viewPct: 1.0,
                      visibleMs: 3000,
                      viewMs: 3000,
                    })
                    .then(() => showActive());
                }
              },
              // Live overlay refresh (v0.3.6): the loopback serves THIS at GET
              // /ads so the injected overlay polls + swaps campaigns in place —
              // no reload — for chat sessions kept open for days.
              getAds: () =>
                session.getQueue().map((a) => ({
                  adId: a.adId,
                  adText: a.adText,
                  clickUrl: a.clickUrl,
                  iconUrl: a.iconUrl,
                })),
            },
            // The full auction sample → the injected block rotates one creative
            // per message across all of these.
            session.getQueue().map((a) => ({
              adId: a.adId,
              adText: a.adText,
              clickUrl: a.clickUrl,
              iconUrl: a.iconUrl,
            })),
          );
          // The Claude Code panel webview that's already open loaded BEFORE this
          // patch, so it would keep showing Claude's default spinner. Reload
          // webviews once so it picks up the freshly-injected overlay (with the
          // live loopback) and renders the sponsored ad immediately — without the
          // user running "Developer: Reload Webviews" by hand. Guarded by
          // !overlaySession above, so this fires once per activation. No-op if no
          // webview panel is open yet.
          if (overlaySession) {
            try {
              await vscode.commands.executeCommand(
                'workbench.action.webview.reloadWebviewAction',
              );
              dlog('[claude-overlay] reloaded webviews to render the injected ad');
            } catch (e) {
              dlog('[claude-overlay] webview reload failed (renders on manual reload)', String(e));
            }
          }
        }
      }
    }
  };

  // A LIGHT periodic re-sync so NEW campaigns reach the terminal spinner without
  // a VS Code reload. Re-fetch the auction queue and re-write spinnerVerbs
  // (idempotent — only writes when the set changes). Deliberately does NOT re-arm
  // the view-timer or re-inject the overlay, so it never re-bills or re-mounts;
  // `claude` reads settings.json at startup, so the next fresh session picks up
  // the new ads automatically.
  const resyncQueue = async (): Promise<void> => {
    const res = await portfolio.fetch();
    if (!res) return;
    session.setQueue(res.ads, {
      viewThresholdMs: res.viewThresholdMs,
      rotationIntervalMs: res.rotationIntervalMs,
    });
    session.setBalances(res.balances);
    cliSync.syncOnce();
  };

  const showActive = async (): Promise<void> => {
    if (!auth.isSignedIn()) {
      statusBar?.setState({ kind: 'signedOut' });
      return;
    }
    // The REAL publisher balance is /v1/earnings (the account the credits land
    // in) — NOT session.getBalances(), which carries the portfolio's balances
    // field and stays $0.00. Use earnings; fall back to portfolio only if the
    // earnings fetch fails (signed-out / network).
    const summary = await earnings.fetch();
    const b = session.getBalances();
    statusBar?.setState({
      kind: 'active',
      todayUsd: summary?.today ?? b?.todayUsd ?? '0.00',
      lifetimeUsd: summary?.lifetime ?? b?.lifetimeUsd ?? '0.00',
    });
    dlog('[status] active', summary ? `$${summary.today} today · $${summary.lifetime}` : '(no earnings)');
  };

  function onSignedIn(): void {
    dlog('[auth] signed in — refreshing portfolio + nudging reload (§5.6 step 19)');
    void (async () => {
      demoted = false;
      await refreshPortfolioNow();
      await showActive();
      void vscode.window.showInformationMessage(
        'BoringSpinner: Signed in — reload the window to start earning.',
        'Reload',
      ).then((choice) => {
        if (choice === 'Reload') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    })();
  }

  // Kick off async activation (§5.6 steps 11–13). Failures fall back to demo.
  void (async () => {
    await auth.loadCached();
    await refreshPortfolioNow(); // signed-in → real; signed-out → demo (§5.11)
    await showActive();
  })();

  // §5.6 step 17: periodic earnings refresh (30s) → status bar (§5.4 Active).
  const earningsRefresh = setupEarningsRefresh({
    intervalMs: 30_000,
    refresh: () => showActive(),
  });
  disposers.push(() => earningsRefresh.dispose());

  // Periodic portfolio re-sync (45s): re-fetch the auction queue and re-write
  // spinnerVerbs so NEW/changed campaigns appear in the terminal spinner on the
  // next fresh `claude` session — no VS Code reload needed. Light + idempotent
  // (see resyncQueue): no re-billing, no overlay re-mount.
  const portfolioRefresh = setupEarningsRefresh({
    intervalMs: 45_000,
    refresh: () => resyncQueue(),
  });
  disposers.push(() => portfolioRefresh.dispose());

  // §11 self-update reload watcher.
  reloadSignal = new ReloadSignal();
  reloadSignal.start();
  ctx.subscriptions.push({ dispose: () => reloadSignal?.dispose() });

  // §5.6 step 18: register all commands. Sign in/out wired to the real flow.
  registerCommands(ctx, {
    getStatusBar: () => statusBar,
    getRestoreAdapters: () => [spinnerAdapter],
    signIn: async () => {
      const ok = await auth.signIn();
      if (!ok) {
        void vscode.window.showErrorMessage('BoringSpinner: Sign-in did not complete (timed out).');
      }
    },
    signOut: async () => {
      await auth.revoke();
      spinnerAdapter.restore();
      if (overlaySession) {
        overlaySession.restore();
        void overlaySession.dispose();
        overlaySession = null;
      }
      restoreVscodeSpinnerVerb(vscodeSettingsPath);
      await refreshPortfolioNow(); // back to demo (§5.11)
      statusBar?.setState({ kind: 'signedOut' });
      void vscode.window.showInformationMessage('BoringSpinner: Signed out — surfaces restored.');
    },
    getVaultScheme: () => vault.scheme,
    isSignedIn: () => auth.isSignedIn(),
    getEmail: () => auth.getEmail(),
  });

  ctx.subscriptions.push({ dispose: () => disposers.forEach((d) => d()) });
  dlog('activate complete — Phase 3 wired (auth/portfolio/metrics/earnings)');
}

export function deactivate(): void {
  // Restore Claude Code's webview bundle FIRST (irreversible user-file change).
  if (overlaySession) {
    overlaySession.restore();
    void overlaySession.dispose();
    overlaySession = null;
  }
  statusBar?.dispose();
  statusBar = undefined;
  reloadSignal?.dispose();
  reloadSignal = undefined;
  disposers.forEach((d) => d());
  disposers.length = 0;
}
