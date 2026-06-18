// src/reloadSignal.ts — sentinel-file watcher for self-update reload (§11).
//
// Watches ~/.coads/reload.sentinel. When the sentinel's payload changes to a
// version/mtime we haven't reloaded for yet, call
// workbench.action.restartExtensionHost — capped at 3 restarts per session (§11).

import * as fs from 'fs';
import * as vscode from 'vscode';

import { reloadSentinelPath } from './update/client';
import { dlog } from './log';

export interface SentinelPayload {
  version: string;
  mtimeMs: number;
}

export const MAX_RESTARTS_PER_SESSION = 3; // §11.

// Pure decision: given the last-seen payload and the freshly-read one, should we
// restart? True only when the payload is new (different version OR newer mtime)
// and we haven't exhausted the per-session restart budget.
export function shouldRestart(
  last: SentinelPayload | null,
  next: SentinelPayload | null,
  restartsSoFar: number,
): boolean {
  if (!next) return false;
  if (restartsSoFar >= MAX_RESTARTS_PER_SESSION) return false;
  if (!last) return true;
  if (next.version !== last.version) return true;
  return next.mtimeMs > last.mtimeMs;
}

export function readSentinel(path: string): SentinelPayload | null {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SentinelPayload>;
    if (typeof parsed.version === 'string' && typeof parsed.mtimeMs === 'number') {
      return { version: parsed.version, mtimeMs: parsed.mtimeMs };
    }
    return null;
  } catch {
    return null;
  }
}

export class ReloadSignal {
  private last: SentinelPayload | null = null;
  private restarts = 0;
  private watcher: fs.FSWatcher | undefined;
  private readonly path: string;

  constructor(sentinelPath: string = reloadSentinelPath()) {
    this.path = sentinelPath;
  }

  // Begin watching. Seeds `last` with the current sentinel so a pre-existing
  // sentinel (e.g. from a prior boot) does not trigger an immediate restart.
  start(): void {
    this.last = readSentinel(this.path);
    try {
      // Watch the containing dir so creation of the sentinel is observed too.
      const dir = this.path.replace(/[^/\\]+$/, '');
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && !String(filename).endsWith('reload.sentinel')) return;
        this.onChange();
      });
    } catch (e) {
      dlog('[reloadSignal] watch failed', String(e));
    }
  }

  // Exposed for tests + the watcher callback.
  onChange(): void {
    const next = readSentinel(this.path);
    if (shouldRestart(this.last, next, this.restarts)) {
      this.last = next;
      this.restarts++;
      dlog(`[reloadSignal] restart ${this.restarts}/${MAX_RESTARTS_PER_SESSION}`);
      void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    } else if (next) {
      this.last = next;
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
