// src/activation/commands.ts — all command registrations (§5.5).
//
// Phase 1: every command from §5.3 is registered. `coads.menu` opens a real
// quick-pick; `coads.editConfig` materializes the §12 template; the rest are
// placeholder handlers (info messages) — real logic arrives in later phases.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coadsHomeDir, configPath, CONFIG_TEMPLATE } from '../config';
import { dlog } from '../log';
import type { StatusBar } from '../statusbar';
import type { TargetAdapter } from '../adapters/types';

interface Deps {
  getStatusBar: () => StatusBar | undefined;
  // Adapters whose surfaces `coads.restore` should roll back (§5.5).
  // Phase 2: the claude-cli-spinner adapter.
  getRestoreAdapters?: () => TargetAdapter[];
  // Phase 3 — real auth flow + status introspection (§5.5).
  signIn?: () => Promise<void>;
  signOut?: () => Promise<void>;
  getVaultScheme?: () => string;
  isSignedIn?: () => boolean;
  getEmail?: () => string | null;
}

export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: Deps,
): void {
  const reg = (id: string, fn: (...a: unknown[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // BoringSpinner: Sign in — Google OAuth device flow (§10.1). Real in Phase 3.
  reg('coads.signIn', async () => {
    if (!deps.signIn) {
      void vscode.window.showInformationMessage('BoringSpinner: Sign in is not wired in this build.');
      return;
    }
    if (deps.isSignedIn?.()) {
      void vscode.window.showInformationMessage(
        `BoringSpinner: Already signed in as ${deps.getEmail?.() ?? 'your account'}.`,
      );
      return;
    }
    await deps.signIn();
  });

  // BoringSpinner: Sign out — revoke refresh server-side + clear vault + restore (§5.5).
  reg('coads.signOut', async () => {
    if (!deps.isSignedIn?.()) {
      void vscode.window.showInformationMessage('BoringSpinner: You are not signed in.');
      return;
    }
    await deps.signOut?.();
  });

  // BoringSpinner: Restore Claude Code — restore every adapter's surface to its
  // byte-exact backup, verified by checksum (§5.5 / §5.7). Idempotent.
  reg('coads.restore', async () => {
    const adapters = deps.getRestoreAdapters?.() ?? [];
    if (adapters.length === 0) {
      void vscode.window.showInformationMessage(
        'BoringSpinner: Nothing to restore (no patched surfaces).',
      );
      return;
    }
    const results = adapters.map((a) => ({ name: a.name, r: a.restore() }));
    const failed = results.filter((x) => !x.r.ok);
    if (failed.length > 0) {
      const detail = failed
        .map((x) => `${x.name}: ${x.r.reason ?? 'failed'}`)
        .join('; ');
      dlog('coads.restore failures', detail);
      void vscode.window.showErrorMessage(`BoringSpinner: Restore failed — ${detail}`);
      return;
    }
    const restored = results.filter((x) => x.r.restored).length;
    dlog(`coads.restore ok — ${restored} surface(s) restored (checksum-verified)`);
    void vscode.window.showInformationMessage(
      restored > 0
        ? `BoringSpinner: Restored ${restored} surface(s) — checksum verified.`
        : 'BoringSpinner: Already restored (nothing to do).',
    );
  });

  // BoringSpinner: Uninstall — one-click clean removal. Signs out (revoke + clear
  // vault), restores every patched surface (un-patches Claude Code's webview +
  // settings.json/spinnerVerbs to their byte-exact backups), removes the
  // /boringspinner slash commands, then uninstalls the extension itself and
  // offers a reload. Earnings balance is server-side and untouched.
  reg('coads.uninstall', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Uninstall BoringSpinner?',
      {
        modal: true,
        detail:
          'This signs you out, restores Claude Code to its original (unpatched) state, and removes the extension. Your earnings balance is safe on the server. If you also installed the terminal CLI, run `curl -fsSL https://boringspinner.com/uninstall.sh | sh` to remove that too.',
      },
      'Uninstall',
    );
    if (choice !== 'Uninstall') return;

    // 1. Sign out — revoke the refresh token server-side + clear the vault.
    try {
      if (deps.isSignedIn?.()) await deps.signOut?.();
    } catch (e) {
      dlog('uninstall: signOut failed (continuing)', String(e));
    }

    // 2. Restore every patched surface to its checksum-verified backup (this is
    //    the part that un-patches Claude Code so ads stop). Idempotent.
    try {
      for (const a of deps.getRestoreAdapters?.() ?? []) a.restore();
    } catch (e) {
      dlog('uninstall: restore failed (continuing)', String(e));
    }

    // 3. Remove the /boringspinner Claude Code slash commands (best effort).
    try {
      const cmdsDir = path.join(os.homedir(), '.claude', 'commands');
      fs.rmSync(path.join(cmdsDir, 'boringspinner.md'), { force: true });
      fs.rmSync(path.join(cmdsDir, 'boringspinner'), { recursive: true, force: true });
    } catch (e) {
      dlog('uninstall: slash-command cleanup failed (continuing)', String(e));
    }

    // 4. Uninstall the extension itself, then offer a reload to finish.
    try {
      await vscode.commands.executeCommand(
        'workbench.extensions.uninstallExtension',
        'boringspinner.boringspinner',
      );
    } catch (e) {
      dlog('uninstall: uninstallExtension failed', String(e));
      void vscode.window.showWarningMessage(
        'BoringSpinner signed you out and restored Claude Code, but the extension auto-uninstall failed. Remove it from the Extensions panel to finish.',
      );
      return;
    }
    const r = await vscode.window.showInformationMessage(
      'BoringSpinner uninstalled and Claude Code restored. Reload the window to finish.',
      'Reload window',
    );
    if (r) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  });

  // BoringSpinner: Show status — scheme + signed-in state + surface health (§5.5).
  reg('coads.status', () => {
    const st = deps.getStatusBar()?.getState().kind ?? 'signedOut';
    const scheme = deps.getVaultScheme?.() ?? 'file';
    const signedIn = deps.isSignedIn?.() ?? false;
    const who = signedIn ? (deps.getEmail?.() ?? 'signed in') : 'signed out';
    void vscode.window.showInformationMessage(
      `BoringSpinner status: ${st} · vault=${scheme} · ${who}`,
    );
  });

  // BoringSpinner: Menu — quick-pick (§5.5). BOTH "Sign in" and "Sign out" are
  // ALWAYS listed (each handler guards the wrong state with a friendly message),
  // so logout is always reachable regardless of how the extension reads its
  // signed-in state. The signed-in email is shown next to whichever row applies.
  reg('coads.menu', async () => {
    const signedIn = deps.isSignedIn?.() ?? false;
    const email = deps.getEmail?.() || '';
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Sign in', description: signedIn ? undefined : 'Google', cmd: 'coads.signIn' },
        { label: 'Sign out', description: signedIn ? email || 'signed in' : undefined, cmd: 'coads.signOut' },
        { label: 'Open dashboard', description: undefined, cmd: 'coads.openDashboard' },
        { label: 'Run diagnostics', description: undefined, cmd: 'coads.diagnose' },
        { label: 'Edit config', description: undefined, cmd: 'coads.editConfig' },
        { label: 'Show status', description: undefined, cmd: 'coads.status' },
        { label: 'Restore Claude Code', description: undefined, cmd: 'coads.restore' },
        { label: 'Uninstall', description: 'Sign out, restore Claude Code & remove', cmd: 'coads.uninstall' },
      ],
      { title: 'BoringSpinner', placeHolder: 'BoringSpinner menu' },
    );
    if (pick) await vscode.commands.executeCommand(pick.cmd);
  });

  // BoringSpinner: Diagnose — TODO(Phase 6): AdapterDiagnostics per adapter.
  reg('coads.diagnose', () => {
    void vscode.window.showInformationMessage(
      'BoringSpinner: Diagnose has no adapters to report in Phase 1.',
    );
  });

  // BoringSpinner: Edit config — opens ~/.boringspinner/config.json (or the legacy
  // ~/.coads/config.json if that's where an existing install left it), from template.
  reg('coads.editConfig', async () => {
    const p = configPath();
    try {
      fs.mkdirSync(coadsHomeDir(), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, CONFIG_TEMPLATE, 'utf8');
      const doc = await vscode.workspace.openTextDocument(p);
      await vscode.window.showTextDocument(doc);
    } catch (e) {
      dlog('editConfig failed', String(e));
      void vscode.window.showErrorMessage(`BoringSpinner: could not open ${p}`);
    }
  });

  // BoringSpinner: Open dashboard — TODO(Phase 3): device-bound one-shot login token.
  reg('coads.openDashboard', () => {
    void vscode.env.openExternal(
      vscode.Uri.parse('https://boringspinner.com/dashboard'),
    );
  });

  dlog('registered 9 commands');
}
