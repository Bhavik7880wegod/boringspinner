// src/loopback.ts — local loopback HTTP server (§5.9).
//
// Binds 127.0.0.1 on a random free port and serves exactly two routes, both
// guarded by an unguessable path token (only the injected webview block knows
// it, which is what prevents cross-origin abuse):
//
//   POST /coads/<token>/click  → records a click metric → 204
//   POST /coads/<token>/log    → appends a lifecycle line to ~/.coads/debug.log → 204
//
// The webview reaches this over `http://127.0.0.1:<port>` (resolved through
// vscode.env.asExternalUri() at the call site for Remote-SSH/devcontainers).
// Requests arrive as CORS "simple requests" (mode:'no-cors', no custom headers),
// so no preflight is needed; we still answer OPTIONS and stamp permissive CORS
// headers for safety. NEVER throws to the caller.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { coadsHomeDirRead } from './config';

export interface LoopbackHandlers {
  // Path token gating both routes. Generate with crypto.randomUUID() / randomBytes.
  token: string;
  // Fired on POST /coads/<token>/click with the parsed query (corr, ad, surface…).
  onClick?: (q: URLSearchParams) => void;
  // Fired on POST /coads/<token>/log. If debugLogPath is set the line is also
  // appended there.
  onLog?: (q: URLSearchParams) => void;
  // Returns the CURRENT auction ad set for the live overlay refresh
  // (GET /coads/<token>/ads). A long-running webview polls this so new campaigns
  // appear WITHOUT a reload. Best-effort; errors/absent → empty array.
  getAds?: () => unknown[];
  // Defaults to ~/.coads/debug.log. Append-only; best-effort (failures swallowed).
  debugLogPath?: string;
  // Bind host (default 127.0.0.1) — overridable for tests.
  host?: string;
}

export interface LoopbackServer {
  port: number;
  baseUrl: string; // http://127.0.0.1:<port>
  token: string;
  close(): Promise<void>;
}

export function defaultDebugLogPath(): string {
  // ~/.boringspinner/debug.log (falls back to the legacy ~/.coads/ for existing installs).
  return path.join(coadsHomeDirRead(), 'debug.log');
}

function appendDebugLine(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
  } catch {
    /* best-effort; never throws */
  }
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function startLoopback(h: LoopbackHandlers): Promise<LoopbackServer> {
  const host = h.host ?? '127.0.0.1';
  const debugLogPath = h.debugLogPath ?? defaultDebugLogPath();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS);
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        // GET /coads/<token>/ads → the current auction queue as JSON (CORS-
        // readable). The injected overlay polls this to swap in new campaigns
        // live, with no reload, in a session kept open for days. Token-gated.
        const adsMatch = url.pathname.match(/^\/coads\/([^/]+)\/ads$/);
        if (adsMatch && adsMatch[1] === h.token && req.method === 'GET') {
          let ads: unknown[] = [];
          try {
            ads = h.getAds?.() ?? [];
          } catch {
            ads = [];
          }
          res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ads }));
          return;
        }

        const m = url.pathname.match(/^\/coads\/([^/]+)\/(click|log)$/);
        // Token mismatch or unknown route → 404 (do not leak which failed).
        if (!m || m[1] !== h.token || req.method !== 'POST') {
          res.writeHead(404, CORS);
          res.end();
          return;
        }
        const kind = m[2];
        const q = url.searchParams;
        // Drain the (small/empty) body so the socket frees promptly.
        req.on('data', () => {});
        req.on('end', () => {
          try {
            if (kind === 'click') {
              h.onClick?.(q);
            } else {
              appendDebugLine(
                debugLogPath,
                `${new Date().toISOString()} ${q.toString()}`,
              );
              h.onLog?.(q);
            }
          } catch {
            /* handler errors must not crash the server */
          }
          res.writeHead(204, CORS);
          res.end();
        });
      } catch {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* ignore */
        }
      }
    });

    server.on('error', reject);
    // port 0 → OS assigns a free port.
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        baseUrl: `http://${host}:${port}`,
        token: h.token,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
