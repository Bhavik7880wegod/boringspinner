// src/cli.slash.ts — Claude Code custom slash-command templates installed by
// `boringspinner init` into ~/.claude/commands/. They let users sign in / sign
// up and check status + earnings from the `/` menu, in the terminal OR the editor.
//
// Each is a thin wrapper that tells Claude to run the matching `boringspinner`
// CLI subcommand (pre-authorized via `allowed-tools: Bash(boringspinner:*)`), so
// the slash command and the CLI never drift.

// Top-level `/boringspinner` — the menu + a live status read.
export const SLASH_MENU_MD = `---
description: BoringSpinner — earn from ads in your Claude Code spinner
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner status\` to show my current sign-in and ad status, then list what I can do (keep it brief):

- \`/boringspinner:login\` — sign in / sign up with Google
- \`/boringspinner:status\` — sign-in, CLI compatibility, current spinner ads
- \`/boringspinner:earnings\` — today / month / lifetime earnings
- \`/boringspinner:sync\` — refresh my campaigns into the spinner
- \`/boringspinner:logout\` — sign out
`;

// Namespaced `/boringspinner:<name>` subcommands → ~/.claude/commands/boringspinner/<name>.md
export const SLASH_SUBCOMMANDS: Record<string, string> = {
  login: `---
description: Sign in or sign up to BoringSpinner with Google
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner login\` to sign me in / sign me up (the first Google sign-in creates my account). Allow up to ~3 minutes for me to finish in the browser; don't cancel early. Show the command's output EXACTLY as printed and nothing else — do NOT compose your own sign-in URL line, your own campaign list, or your own summary. The command already prints the URL (when needed) and a final green "BoringSpinner is now live" confirmation; just relay them.
`,

  signup: `---
description: Create a BoringSpinner account (Google — same flow as login)
allowed-tools: Bash(boringspinner:*)
---
Signing up uses the same Google flow as signing in (the first sign-in creates the account). Run \`boringspinner login\`. Show the command's output EXACTLY as printed and nothing else — do NOT compose your own URL line, campaign list, or summary. The command prints the sign-in URL (when needed) and a final green "BoringSpinner is now live" confirmation; just relay them. Wait up to ~3 minutes for me to finish.
`,

  status: `---
description: BoringSpinner sign-in, CLI status, and current spinner ads
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner status\` and show me the result verbatim, then add a one-line takeaway.
`,

  earnings: `---
description: Show my BoringSpinner earnings (today / month / lifetime)
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner earnings\` and show me my earnings. If it says I'm signed out, tell me to run \`/boringspinner:login\` first. Remember: earnings come from the VS Code/Cursor chat-panel overlay — the terminal spinner is exposure-only.
`,

  sync: `---
description: Refresh my BoringSpinner campaigns into the terminal spinner
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner sync\` and show its output as-is — it refreshes the live campaigns from advertisers into my spinner. Remind me to start a NEW \`claude\` session (or reload the editor) to see them. Don't say "verbs" — say "campaigns" or "ads".
`,

  logout: `---
description: Sign out of BoringSpinner and restore settings.json
allowed-tools: Bash(boringspinner:*)
---
Run \`boringspinner logout\` and confirm I'm signed out and my settings.json was restored.
`,
};
