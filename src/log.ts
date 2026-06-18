// src/log.ts — dlog(): single-channel debug log.
// Lazily creates one VS Code OutputChannel; safe to call before init AND safe to
// import outside the VS Code runtime (CLI tools / standalone libs) — `vscode` is
// a type-only import and is require()'d lazily inside a try/catch.

import type * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

// Lazy, failure-tolerant access to the host `vscode` module. Returns null when
// not running inside VS Code (e.g. the coads-overlay demo tool).
function tryVscode(): typeof vscode | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('vscode') as typeof vscode;
  } catch {
    return null;
  }
}

export function initLog(): vscode.OutputChannel | undefined {
  if (!channel) {
    const vs = tryVscode();
    if (vs) channel = vs.window.createOutputChannel('BoringSpinner');
  }
  return channel;
}

export function dlog(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ');
  const stamped = `[${new Date().toISOString()}] ${line}`;
  if (channel) {
    channel.appendLine(stamped);
  } else if (process.env.COADS_DEBUG) {
    // Outside the VS Code OutputChannel (standalone CLI / demo tools / pre-init):
    // stay SILENT by default so the `boringspinner` CLI's output is clean. Opt in
    // with COADS_DEBUG=1, and emit to stderr so it never pollutes stdout.
    // eslint-disable-next-line no-console
    console.error(stamped);
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
