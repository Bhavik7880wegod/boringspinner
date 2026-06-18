// src/buildinfo.ts — buildLabel(), buildVersion() from the package version.
// Imports package.json (resolveJsonModule) so the version is the single source
// of truth and stays in lockstep with the manifest.

import pkg from '../package.json';

export function buildVersion(): string {
  return (pkg as { version: string }).version;
}

export function buildLabel(): string {
  return `BoringSpinner ${buildVersion()}`;
}
