# Roadmap

Subscription-based agents come first, within the limits described in [COMPLIANCE.md](COMPLIANCE.md). API-key backends follow.

## Phase 0: Foundation (done)

- npm workspaces monorepo, TypeScript, ESLint, Prettier, Vitest
- Electron + React + Tailwind application shell with secure defaults (context isolation, sandbox, CSP)
- Project documentation and CI

## Phase 1: Agent setup (done)

- `@powerchord/core` package with a catalog of supported agents (official install channels, version detection, login commands)
- Detection of installed agents and their versions
- Guided installation from official channels with explicit confirmation and live output
- Sign-in by launching each agent's own login command in a terminal
- `powerchord` command-line tool exposing the same setup flow (`powerchord setup`, `powerchord doctor`)
- Agents screen in the desktop app

## Phase 2: Sessions with Claude Code (done, except split view)

- Agent process management in the main process
- Unified event model: message streaming, reasoning, tool calls, permission requests, plans, usage
- Session view: chat transcript, markdown and code rendering, tool call cards, permission prompts, working directory selection
- First agent: Claude Code, running the user's installed `claude` binary
- Multiple concurrent sessions, each with its own agent, model and working directory, with a split view to follow them side by side
- "Open in" actions for a session's working directory: Antigravity (desktop app, or `agy` in the system terminal), editor, terminal. PowerChord only launches these tools and never drives them.

## Phase 3: Local models (done)

- OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp server, vLLM and others), local or on the network
- Network discovery: complete scan of small networks (such as an OpenVPN site network) and likely addresses on large ones, only on request
- Chat sessions with local models, with streaming answers and reasoning output
- Remaining: API keys for protected endpoints (OS secure storage)

## Phase 4: Shared context hub (MCP) (done)

- Extend PowerChord's local MCP server (already used for Claude Code permission prompts) with context tools: tasks, notes, plans, summaries, status
- `ask_local_model`: lets agents such as Claude Code delegate work to local models
- Available to agents driven by PowerChord and to agents used directly, such as Antigravity
- Guided registration in each agent through its own MCP command, with user confirmation
- Hand-off flow: plan in one agent, continue in another, review in a third, all recorded in PowerChord
- Rules in [COMPLIANCE.md](COMPLIANCE.md#powerchord-mcp-server)

## Phase 5: Codex and Gemini

- Codex through its official app-server protocol, signed in with the user's own `codex login`
- Gemini CLI over ACP (`gemini --acp`) with a paid Gemini API key, which can be billed to the Google Cloud credits included in Google AI Pro/Ultra
- Gemini chat through a Google AI Studio API key, with usage tracking, budgets and warnings
- Evaluate joining OpenAI's "Sign in with ChatGPT" program
- Evaluate running Claude Code against local models through an LLM gateway

## Phase 6: Persistence and polish

- Session history stored locally (SQLite) with search, and resuming Claude Code sessions after a restart
- Split view to follow several sessions side by side
- Interactive questions from agents (Claude Code's AskUserQuestion)
- Settings, keyboard shortcuts, theming
- Packaging and auto-update for Windows, then macOS and Linux

## Phase 7: Pay-as-you-go APIs

- Direct API backends for Anthropic and OpenAI
- Cost estimation, per-session and monthly budgets, and warnings before expensive requests
