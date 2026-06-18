// test/vscode-stub.ts — minimal `vscode` module shim for vitest.
// The host provides the real `vscode` at runtime; tests only need the symbols
// referenced at import time so pure functions (e.g. statusText) can be tested.
// This is an adapter stub for type/shape — NOT a behavioral mock.

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = {
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  }),
  createOutputChannel: () => ({
    appendLine() {},
    dispose() {},
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showTextDocument: async () => undefined,
};

export const commands = {
  registerCommand: () => ({ dispose() {} }),
  executeCommand: async () => undefined,
};

export const workspace = {
  openTextDocument: async () => ({}),
  getConfiguration: () => ({
    get: <T>(_key: string, def?: T): T | undefined => def,
  }),
};

export const env = {
  openExternal: async () => true,
};

export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
};
