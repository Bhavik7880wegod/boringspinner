// src/locate.ts — finds the installed Claude Code (and Codex) VS Code
// extension on disk so the webview adapters know which files to patch.
//
// Extensions install under `<editor>/extensions/<publisher>.<name>-<version>[-platform]/`.
// We scan the known editor roots, match the publisher/name prefix, and pick the
// HIGHEST version that actually has the files we need. Pure fs; never throws.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LocatedHost {
  id: 'claude-code' | 'codex';
  dir: string; // extension root directory
  version: string | null; // parsed from the directory name
  hostJs: string | null; // extension.js (CSP lives here)
  webviewJs: string | null; // webview/index.js (ad injection target)
}

// Editor extension roots, broadest first (VS Code, Insiders, Cursor, Windsurf).
export function extensionRoots(home: string = os.homedir()): string[] {
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ];
}

// "anthropic.claude-code-2.1.175-darwin-arm64" → "2.1.175"
export function parseExtVersion(dirName: string): string | null {
  const m = dirName.match(/-(\d+\.\d+\.\d+)(?:-[^/]*)?$/);
  return m ? m[1] : null;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface HostShape {
  hostJs: (dir: string) => string;
  webviewJs: (dir: string) => string;
}

const SHAPES: Record<'claude-code' | 'codex', { prefix: string } & HostShape> = {
  'claude-code': {
    prefix: 'anthropic.claude-code-',
    hostJs: (d) => path.join(d, 'extension.js'),
    webviewJs: (d) => path.join(d, 'webview', 'index.js'),
  },
  // Codex's bundle layout (surface 3, deliverable 6) — paths confirmed at build time.
  codex: {
    prefix: 'openai.chatgpt-',
    hostJs: (d) => path.join(d, 'dist', 'extension.js'),
    webviewJs: (d) => path.join(d, 'webview', 'index.js'),
  },
};

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Find the newest installed host of `id` across all editor roots.
export function locateHost(
  id: 'claude-code' | 'codex',
  roots: string[] = extensionRoots(),
): LocatedHost | null {
  const shape = SHAPES[id];
  const candidates: { dir: string; version: string | null }[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      if (!exists(root)) continue;
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(shape.prefix)) continue;
      candidates.push({ dir: path.join(root, name), version: parseExtVersion(name) });
    }
  }
  if (candidates.length === 0) return null;
  // Highest version first; null versions sort last.
  candidates.sort((a, b) => {
    if (a.version && b.version) return -compareSemver(a.version, b.version);
    if (a.version) return -1;
    if (b.version) return 1;
    return 0;
  });
  for (const c of candidates) {
    const hostJs = shape.hostJs(c.dir);
    const webviewJs = shape.webviewJs(c.dir);
    if (exists(webviewJs)) {
      return {
        id,
        dir: c.dir,
        version: c.version,
        hostJs: exists(hostJs) ? hostJs : null,
        webviewJs,
      };
    }
  }
  // Fall back to the newest candidate even if files are missing (diagnostics).
  const top = candidates[0];
  return {
    id,
    dir: top.dir,
    version: top.version,
    hostJs: exists(shape.hostJs(top.dir)) ? shape.hostJs(top.dir) : null,
    webviewJs: exists(shape.webviewJs(top.dir)) ? shape.webviewJs(top.dir) : null,
  };
}

export function locateClaudeCode(roots?: string[]): LocatedHost | null {
  return locateHost('claude-code', roots);
}
