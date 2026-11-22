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

## Phase 2: Sessions with Claude Code (done)

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
- API keys for protected endpoints (OS secure storage), added in phase 7

## Phase 4: Shared context hub (MCP) (done)

- Extend PowerChord's local MCP server (already used for Claude Code permission prompts) with context tools: tasks, notes, plans, summaries, status
- `ask_local_model`: lets agents such as Claude Code delegate work to local models
- Available to agents driven by PowerChord and to agents used directly, such as Antigravity
- Guided registration in each agent through its own MCP command, with user confirmation
- Hand-off flow: plan in one agent, continue in another, review in a third, all recorded in PowerChord
- Rules in [COMPLIANCE.md](COMPLIANCE.md#powerchord-mcp-server)

## Phase 5: Codex and Gemini (done)

- Codex through its official app-server protocol, signed in with the user's own `codex login`: streaming, reasoning summaries, command and file-change approvals, sandbox modes (read only, auto, full access), model list, plan usage, thread resume and the hub
- Gemini CLI over ACP (`gemini --acp`) with the user's Gemini API key, which can be billed to the Google Cloud credits included in Google AI Pro/Ultra: streaming, thoughts, tool calls, permission prompts, the agent's own models and modes, session loading and the hub
- A generic Agent Client Protocol client, ready for other ACP agents
- API keys stored with the operating system's secure storage and checked with the provider before saving
- Gemini chat through an API key is part of phase 7
- Later: evaluate joining OpenAI's "Sign in with ChatGPT" program, and running Claude Code against local models through an LLM gateway

## Phase 6: Persistence and polish (done, except auto-update)

- Session history stored locally (one JSON file per session) with search; Claude Code sessions resume their conversation after a restart, local model chats continue with their saved history
- Split view to follow up to three sessions side by side
- Interactive questions from agents (Claude Code's AskUserQuestion)
- Settings (theme, trusted folders, hub token, data folder) and keyboard shortcuts
- Packaging with electron-builder and a release workflow that builds Windows, macOS and Linux installers
- Remaining: auto-update and code signing, once releases are public

## Phase 7: Pay-as-you-go APIs (done)

- API model chats with Anthropic (Messages API), OpenAI and Gemini, using the user's own keys
- Claude Code sessions billed to an Anthropic API key instead of the plan
- Cost estimates from published list prices, a monthly ledger per provider, monthly budgets and confirmation before messages estimated above a threshold
- API keys for protected model servers (OS secure storage)

## Phase 8: Tools for model chats (done)

- Local model and API chats can work in a project folder: list, read, search, create and edit files, run commands, and fetch web pages
- Tool calling over the OpenAI-compatible API (llama.cpp, Ollama, LM Studio, vLLM, OpenAI, Gemini) and Anthropic's Messages API
- Modes like those of the coding agents: ask before changes, auto edit, full access; approvals for one call or the whole session
- Context meter for model chats, with the window read from the server (llama.cpp, Ollama, LM Studio) or the provider (Anthropic, Gemini)
- Compaction: the model summarizes the conversation on request, or automatically when a turn reaches 80% of the context window
- Rules in [COMPLIANCE.md](COMPLIANCE.md#model-chat-tools)

## Phase 9: Projects and memory (done)

- Projects: a folder whose chats are kept together, with any number of chats with any agent or model; existing sessions are grouped by folder
- Sidebar with expandable projects and loose chats; a project page with its chats, instructions and memory
- Project instructions in the folder: `AGENTS.md` as the shared file, with optional `@AGENTS.md` imports in `CLAUDE.md` and `GEMINI.md`; model chats receive them in their system prompt
- Private project memory in PowerChord's data folder, given to model chats and Claude Code at start and available to every agent through the hub tools `read_project_memory` and `remember`
- Rules in [COMPLIANCE.md](COMPLIANCE.md#project-instructions-and-memory)

## Next

- Codex and Gemini CLI read the private memory through the hub tools; give it to them at start once their protocols offer a documented way

- Web search for model chats, through a search API the user chooses

- Auto-update and code signing once releases are public
- Evaluate joining OpenAI's "Sign in with ChatGPT" program
- Evaluate running Claude Code against local models through an LLM gateway
