# Roadmap

Subscription-based agents come first, within the limits described in [COMPLIANCE.md](COMPLIANCE.md). API-key backends follow.

## Phase 0: Foundation (done)

- npm workspaces monorepo, TypeScript, ESLint, Prettier, Vitest
- Electron + React + Tailwind application shell with secure defaults (context isolation, sandbox, CSP)
- Project documentation and CI

## Phase 1: Agent setup

- `@powerchord/core` package with a catalog of supported agents (official install channels, version detection, login commands)
- Detection of installed agents and their versions
- Guided installation from official channels with explicit confirmation and live output
- Sign-in by launching each agent's own login command in a terminal
- `powerchord` command-line tool exposing the same setup flow (`powerchord setup`, `powerchord doctor`)
- Agents screen in the desktop app

## Phase 2: Sessions with Claude Code

- Agent process management in the main process
- Unified event model: message streaming, reasoning, tool calls, permission requests, plans, usage
- Session view: chat transcript, markdown and code rendering, tool call cards, permission prompts, working directory selection
- First agent: Claude Code, running the user's installed `claude` binary

## Phase 3: Codex

- Codex through its official app-server protocol, signed in with the user's own `codex login`
- Per-session agent and model selection
- Evaluate joining OpenAI's "Sign in with ChatGPT" program

## Phase 4: Model backends

- OpenAI-compatible endpoints (Ollama, llama.cpp server, LM Studio, vLLM), local or on the network
- Gemini through a Google AI Studio API key
- Endpoint and key management (OS secure storage), model discovery
- Chat sessions with model backends

## Phase 5: Persistence and polish

- Session history stored locally (SQLite) with search
- Settings, keyboard shortcuts, theming
- Packaging and auto-update for Windows, then macOS and Linux

## Phase 6: Pay-as-you-go APIs

- Direct API backends for Anthropic and OpenAI
- Cost estimation, per-session and monthly budgets, and warnings before expensive requests
