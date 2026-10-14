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

## Phase 3: Codex and Gemini CLI

- Codex through its official app-server protocol, signed in with the user's own `codex login`
- Gemini CLI over ACP (`gemini --acp`), signed in through its own flow; a paid Gemini API key can be billed to the Google Cloud credits included in Google AI Pro/Ultra
- Per-session model selection from the models each agent reports, changeable mid-session where the agent supports it
- Evaluate joining OpenAI's "Sign in with ChatGPT" program

## Phase 3b: Shared context hub (MCP)

- Local PowerChord MCP server with context tools: tasks, notes, plans, summaries, status
- Available to agents driven by PowerChord and to agents used directly, such as Antigravity
- Guided registration in each agent through its own MCP command, with user confirmation
- Hand-off flow: plan in one agent, continue in another, review in a third, all recorded in PowerChord
- Rules in [COMPLIANCE.md](COMPLIANCE.md#powerchord-mcp-server)

## Phase 4: Model backends

- OpenAI-compatible endpoints (Ollama, llama.cpp server, LM Studio, vLLM), local or on the network
- Gemini through a Google AI Studio API key, including keys billed to the monthly Google Cloud credits of a Google AI Pro/Ultra plan
- Usage tracking, budgets and warnings for billed keys
- Endpoint and key management (OS secure storage), model discovery
- Chat sessions with model backends

## Phase 5: Persistence and polish

- Session history stored locally (SQLite) with search
- Settings, keyboard shortcuts, theming
- Packaging and auto-update for Windows, then macOS and Linux

## Phase 6: Pay-as-you-go APIs

- Direct API backends for Anthropic and OpenAI
- Cost estimation, per-session and monthly budgets, and warnings before expensive requests
