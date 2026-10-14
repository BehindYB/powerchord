# PowerChord

Desktop workspace for AI coding agents (Claude Code, Codex, Gemini CLI) and local models. Electron + TypeScript + React, npm workspaces.

## Language

Everything in this repository is written in English: code, identifiers, comments, commit messages, documentation and UI strings. Comments are professional and explain intent or constraints; no casual remarks.

## Compliance

[docs/COMPLIANCE.md](docs/COMPLIANCE.md) is mandatory. In particular: never read vendor CLI credential files, never implement vendor sign-in, never call vendor endpoints with subscription credentials, install agents only from official channels with user confirmation.

## Layout

- `apps/desktop` — Electron app (electron-vite)
  - `src/main` — main process (window, IPC handlers, agent processes)
  - `src/preload` — context bridge exposing `window.powerchord`
  - `src/renderer` — React UI (Tailwind v4, tokens in `src/renderer/src/styles.css`)
  - `src/shared` — types shared between processes (IPC contract in `ipc.ts`)
- `apps/cli` — `powerchord` command-line tool (`npm run cli -- doctor`), run from TypeScript sources by Node's type stripping
- `packages/core` — `@powerchord/core`: agent catalog (official install channels), detection, installation, process helpers, the agent-neutral session model (`src/sessions`), the Claude Code adapter (`src/sessions/claude-code`) and the local MCP server (`src/mcp`). Shipped as TypeScript sources; the desktop main process bundles it. `@powerchord/core/sessions` is the browser-safe subset used by the renderer.
- `docs` — roadmap and compliance rules

## Commands

- `npm run dev` — run the desktop app
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` — must pass before committing

## Conventions

- TypeScript strict mode, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Renderer code never accesses Node or Electron APIs directly; add a typed method to `PowerChordApi` in `src/shared/ipc.ts`, implement it in the preload and handle it in the main process.
- Keep `contextIsolation`, `sandbox` and the CSP enabled.
- Version constraints: electron-vite 5 requires Vite 7; typescript-eslint requires TypeScript < 6.1.
- Code under `packages/*` and `apps/cli` must stay compatible with Node type stripping: relative imports use `.ts` extensions, no enums, namespaces or parameter properties.
- Install commands in `packages/core/src/agents/catalog.ts` must come from vendor documentation; the renderer can only request installs by agent and method id, and the main process shows the confirmation dialog.
