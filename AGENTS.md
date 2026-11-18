# AGENTS.md - opencode-handy-voice

OpenCode Desktop GUI plugin: local voice dictation through Handy. No TUI part,
no server part, no LLM.

## Key invariants

- `src/gui.tsx` is bundled by Vite into `dist/gui-experimental.cjs`, which is
  committed: OpenCode installs the plugin from a local path or Git without
  building it. Rebuild and commit it with every source change.
- No `build`, `prepare`, `prepack` or install scripts: they break OpenCode's Git
  install (anomalyco/opencode#49704). `npm run bundle` is a manual script.
- `setup` runs in each window: recording (`getUserMedia`, WAV encoding) lives
  there. `main` runs in the Electron main process: file and `handy.exe` work
  lives there.
- The window bundle also evaluates `src/handy.ts` at module scope. Never touch
  `process`, `fs`, `spawn` or other Node-only APIs at module scope; guard them
  in functions, or the window fails with `ReferenceError: process is not
  defined`. Node built-ins are inert placeholders in the window.
- The Ipc id must start with the package name:
  `opencode-handy-voice.transcribe`.
- Desktop's PATH is minimal, so `findHandy` checks `%LOCALAPPDATA%\Handy`,
  Program Files and common Unix paths before PATH.
- Settings live in plugin storage (`Store.global`) and are edited in
  Settings → Handy Voice. The window passes `handyPath` and `model` on each Ipc
  call, and main validates them again.
- The mic button is inserted into the app's composer DOM because the GUI SDK
  has no composer action registry. `src/composer-button.ts` targets
  `[data-slot="composer-actions"]` and `[data-action="composer-submit"]` and
  survives composer remounts with a `MutationObserver` and a 500 ms poll.
- Handy accepts 16 kHz mono 16-bit PCM WAV. `src/wav.ts` is the only encoder and
  `src/handy.ts` rejects anything else before writing a temp file.
- Handy logs to stderr and prints one JSON object to stdout. Parse from the last
  line backwards; do not treat stderr as the result.

## Scripts

```bash
npm install
npm run typecheck
npm test
npm run bundle   # vite build -> dist/gui-experimental.cjs
```

## Try it locally

The repo's absolute path is in the `plugins` list of
`~/.config/opencode/opencode.json`. Desktop loads the working tree: run
`npm run bundle`, then reload the OpenCode window after each change.
