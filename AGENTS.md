# AGENTS.md - opencode-dictation

OpenCode Desktop GUI plugin, macOS only, whisper.cpp only. No TUI part, no LLM.

## Key invariants

- `src/gui.tsx` is bundled by Vite into `dist/gui-experimental.cjs`, which is
  committed: OpenCode installs the plugin from Git without building it. Rebuild
  and commit it with every source change.
- No `build`, `prepare`, `prepack` or install scripts: they break OpenCode's Git
  install (anomalyco/opencode#49704).
- `setup` runs in each window: recording (`getUserMedia`, WAV encoding) lives
  there. `main` runs in the Electron main process: file, network and
  `whisper-cli` work lives there.
- The Ipc id must start with the package name: `opencode-dictation.whisper`.
- Desktop's PATH is minimal, so `whisper-cli` is looked up in Homebrew dirs too.
- Settings live in plugin storage (`Store.global`) and are edited in Settings →
  Dictation. `opencode.jsonc` options are not read. The window passes model and
  language on each Ipc call, and main validates them again.

## Scripts

```bash
npm install
npm run test       # node --test
npm run bundle     # vite build -> dist/gui-experimental.cjs
npm run check      # lint (oxlint) + fmt check (oxfmt) + typecheck
npm run fmt:fix    # format with oxfmt
```

`.githooks/pre-commit` runs check, test and bundle, and fails when `dist/` is out
of date. Enable it once per clone: `git config core.hooksPath .githooks`. CI
(`.github/workflows/ci.yml`) runs the same checks on every push and PR.

The hook checks the working tree, not the index. For a partial commit, stash the
rest first: `git stash push --keep-index`.

## Try it locally

Put the repo's absolute path in the `plugins` list of
`~/.config/opencode/opencode.jsonc`. Desktop loads the working tree: run
`npm run bundle`, then restart Desktop after each change.
