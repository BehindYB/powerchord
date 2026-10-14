# PowerChord

A desktop workspace for AI coding agents and models. Run **Claude Code**, **OpenAI Codex**, **Gemini** and **local models** from a single interface, using the subscriptions and tools you already have.

> **Status: pre-alpha.** Agent setup (detection, installation and sign-in) works; agent sessions are under active development. See the [roadmap](docs/ROADMAP.md).

## How it works

PowerChord does not talk to subscription services directly. It drives the **official, unmodified command-line agents** published by each vendor, installed from their official channels and signed in through their own login flows, using each agent's documented integration protocol. Subscriptions are supported only where the vendor's terms allow it; see [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

| Backend            | Access                            | Integration                 |
| ------------------ | --------------------------------- | --------------------------- |
| Claude Code        | Claude Pro / Max subscription     | Official `claude` binary    |
| OpenAI Codex       | ChatGPT plan                      | Official Codex agent        |
| Gemini             | Google AI Studio API key          | Gemini API                  |
| Local models       | Ollama, llama.cpp, LM Studio, ... | OpenAI-compatible HTTP API  |
| Pay-as-you-go APIs | API keys                          | Planned, with cost controls |

## Principles

- **Your accounts stay yours.** PowerChord never reads, stores, copies or forwards credentials or session tokens belonging to the vendor CLIs. Sign-in always completes through the vendor's own flow.
- **Official software only.** Agents are installed from the vendor's official distribution channels and run unmodified.
- **Local first.** Everything runs on your machine; there is no PowerChord server.

See [docs/COMPLIANCE.md](docs/COMPLIANCE.md) for the full set of rules the codebase follows.

## Development

Requirements: Node.js 22.18 or later (24 recommended) and npm.

```bash
npm install
npm run dev
```

| Command                    | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `npm run dev`              | Start the desktop app with hot reload                 |
| `npm run build`            | Build the desktop app                                 |
| `npm run typecheck`        | Type-check all workspaces                             |
| `npm run lint`             | Lint the repository                                   |
| `npm run format`           | Format the repository with Prettier                   |
| `npm test`                 | Run the test suite                                    |
| `npm run cli -- <command>` | Run the `powerchord` CLI (`doctor`, `setup`, `login`) |

## Disclaimer

PowerChord is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google or any other vendor. Claude, Claude Code, OpenAI, Codex, ChatGPT, Gemini and other product names are trademarks of their respective owners and are used only to identify the software PowerChord interoperates with. Use of each vendor's service remains subject to that vendor's terms.

## License

[MIT](LICENSE)
