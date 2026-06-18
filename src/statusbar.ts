// src/statusbar.ts — right-aligned status bar item; click → coads.menu.
// The §5.4 state→text mapping lives in pure functions (statusText / statusTooltip)
// so it is unit-testable. Phase 1 renders the signed-out state live.

import * as vscode from 'vscode';

// Every UX state from §5.4.
export type StatusState =
  | { kind: 'signedOut' }
  | { kind: 'active'; todayUsd: string; lifetimeUsd: string }
  | { kind: 'disabled' }
  | { kind: 'killed' }
  | { kind: 'offline' }
  | { kind: 'incompatible' }
  | { kind: 'hourlyCap'; resetLabel: string }
  | { kind: 'dailyCap'; resetLabel: string }
  | { kind: 'needsReload' };

// §5.4 "Text" column. Pure function.
export function statusText(state: StatusState): string {
  switch (state.kind) {
    case 'signedOut':
      return 'BoringSpinner: Sign in';
    case 'active':
      return `BoringSpinner ($${state.todayUsd} today · $${state.lifetimeUsd})`;
    case 'disabled':
      return 'BoringSpinner: Off';
    case 'killed':
      return 'BoringSpinner: Paused';
    case 'offline':
      return 'BoringSpinner: Offline';
    case 'incompatible':
      return 'BoringSpinner: incompatible';
    case 'hourlyCap':
      return `BoringSpinner: Hourly cap (${state.resetLabel})`;
    case 'dailyCap':
      return `BoringSpinner: Daily cap (${state.resetLabel})`;
    case 'needsReload':
      return 'BoringSpinner: reload to start';
  }
}

// §5.4 "Tooltip" column. Pure function.
export function statusTooltip(state: StatusState): string {
  switch (state.kind) {
    case 'signedOut':
      return 'Click to sign in';
    case 'active':
      return 'today / lifetime';
    case 'disabled':
      return 'Click to enable';
    case 'killed':
      return 'Service paused remotely';
    case 'offline':
      return "Can't reach api.boringspinner.com";
    case 'incompatible':
      return 'No supported target found';
    case 'hourlyCap':
    case 'dailyCap':
      return 'Earnings resume at …';
    case 'needsReload':
      return 'Reload VS Code window';
  }
}

export class StatusBar {
  private item: vscode.StatusBarItem;
  private state: StatusState = { kind: 'signedOut' };

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'coads.menu';
    this.render();
    this.item.show();
  }

  setState(state: StatusState): void {
    this.state = state;
    this.render();
  }

  getState(): StatusState {
    return this.state;
  }

  private render(): void {
    this.item.text = statusText(this.state);
    this.item.tooltip = statusTooltip(this.state);
  }

  dispose(): void {
    this.item.dispose();
  }
}
