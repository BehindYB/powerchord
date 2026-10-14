# Compliance rules

PowerChord integrates with services whose terms restrict how third-party software may use subscription accounts. These rules keep the project within those terms. They are mandatory for every contribution.

## Vendor status

Last reviewed: 2026-10-14. Re-check the referenced terms before changing an integration.

| Vendor    | Subscription use in PowerChord | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | Allowed, with conditions       | Products may run Claude Code if the binary is unmodified, its built-in authentication is left intact, and each end user authenticates with their own subscription or API key. Anthropic does not allow third-party apps to offer Claude.ai login or to handle Claude.ai credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| OpenAI    | Allowed via the official agent | The open-source Codex CLI is driven through its documented app-server protocol, signed in by the user with `codex login`. OpenAI also runs an official "Sign in with ChatGPT" program for third-party apps; using it requires a client ID issued by OpenAI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Google    | **Not allowed**                | The Antigravity FAQ states that wrapping `agy` inside third-party coding agents or applications is not supported under consumer plans, and the Antigravity terms prohibit accessing the service through third-party software. Gemini CLI no longer serves Google AI Pro/Ultra plans, and Google AI plan quotas apply only inside Google AI Studio's web interface. Gemini is supported through the official Gemini CLI (driven over ACP, signed in through its own flow with any account type it accepts, currently paid API keys and Gemini Code Assist Standard/Enterprise) and through API keys (AI Studio, Vertex AI, Gemini Enterprise). Google AI Pro/Ultra include monthly Google Cloud credits that cover Gemini API usage on a Cloud Billing-enabled project. |

## Credentials

1. Never read, parse, copy, store or transmit credential or session files written by vendor CLIs (for example `~/.claude/`, `~/.codex/auth.json`, `~/.gemini/`).
2. Never implement a sign-in flow for a vendor account inside PowerChord, unless the vendor runs an official program for third-party apps and PowerChord holds the credentials that program issues (for example a "Sign in with ChatGPT" client ID). Otherwise sign-in is performed by the vendor CLI's own login command, which PowerChord may launch in a terminal.
3. Never call vendor endpoints directly with subscription credentials outside such an official program.
4. API keys entered by the user are encrypted with the operating system's secure storage (DPAPI, Keychain or the Secret Service) and never stored in plain text; where no secure storage is available, PowerChord refuses to store keys. A key is sent only to the provider it belongs to, or to that provider's own agent through the agent's documented mechanism (for example `GEMINI_API_KEY` for Gemini CLI). Keys never reach the renderer process.

## Agent binaries

1. Agents are installed only from the vendor's official channels (official installer scripts, the vendor's npm packages, or WinGet/Homebrew packages published by the vendor).
2. Every installation shows the exact command and requires explicit user confirmation. Installations run without administrator privileges.
3. Agent binaries are never bundled with PowerChord, patched, or wrapped in a way that disables or alters their built-in authentication.
4. For Claude, PowerChord runs the `claude` binary installed by the user, through its documented print mode (`-p` with stream-json input and output), and never with `--bare` or other options that change how it authenticates. PowerChord does not depend on the Claude Agent SDK package, which bundles its own copy of the binary.
5. For Codex, PowerChord runs the `codex` binary installed by the user through its documented app-server protocol (`codex app-server`). Codex authenticates with the account the user signed in with `codex login`; PowerChord only reads whether an account is present (`account/read`).
6. For Gemini CLI, PowerChord runs the `gemini` binary installed by the user in its documented Agent Client Protocol mode (`gemini --acp`) and selects the `gemini-api-key` authentication method the agent advertises, with the user's key in `GEMINI_API_KEY`. Gemini CLI records the selected method in its own settings, as it does when the user chooses it interactively.
7. Claude Code sessions billed to the user's Anthropic API key run the same binary with `ANTHROPIC_API_KEY` and a separate `CLAUDE_CONFIG_DIR` inside PowerChord's data folder. A signed-in Claude Code keeps using the subscription even when the key is set, so the separate folder, which has no login, is what makes the key take effect. PowerChord never reads that folder.
8. Vendor agents whose consumer terms prohibit use from third-party applications (currently Antigravity CLI) are not integrated with consumer accounts.

## Agents PowerChord does not drive (Antigravity)

Antigravity is used by the user through its own interfaces. PowerChord's role is limited to:

1. **Launching.** "Open in Antigravity" starts the Antigravity desktop app, or `agy` in the system terminal, in a working directory. PowerChord does not write to its input or read its output.
2. **Registration.** PowerChord may run Antigravity's own MCP management command (`agy mcp`), with user confirmation, to register the PowerChord MCP server. It does not edit files under `~/.gemini/`.
3. **Serving MCP tools.** Antigravity may call the PowerChord MCP server, a documented Antigravity extension mechanism.

PowerChord never sends prompts to `agy`, runs it in headless or print mode, reads its conversation storage, or connects to its remote-control service.

## PowerChord MCP server

The MCP server lets any agent, whether driven by PowerChord or used directly by the user, share context through PowerChord. It must remain a context-sharing service, not a control channel:

1. Tools expose and record shared context: tasks, notes, plans, summaries and status. The one exception is the permission prompt tool that PowerChord passes to Claude Code with `--permission-prompt-tool`, through which the user approves or denies Claude Code's actions. No tool returns instructions for an agent to execute next on PowerChord's behalf, and no tool is designed to be polled in a loop.
2. PowerChord never triggers an agent it does not drive. Work in such an agent starts only from the user's own input in that agent's interface.
3. The server listens only on loopback HTTP and is never exposed to the network. Every client authenticates with a bearer token: each PowerChord-driven session gets its own, passed through the agent's documented MCP configuration (a Claude Code `--mcp-config`, an ACP `mcpServers` entry, or a Codex configuration override that reads the token from an environment variable), and agents the user registers the hub in share a per-install token kept in PowerChord's settings.
4. Tool calls follow each agent's own approval settings; PowerChord does not ask users to auto-approve its tools.

## Network discovery

PowerChord can look for model servers (Ollama, LM Studio, llama.cpp, vLLM and similar) on the user's networks. To keep this a convenience rather than a scanner:

1. Discovery runs only when the user starts it; it never runs in the background or on a schedule.
2. Only private addresses are probed: loopback, RFC 1918 and carrier-grade NAT (100.64.0.0/10), and only on networks this machine is attached to, plus hosts where servers were found before.
3. Small networks (/22 or smaller) are probed completely; larger ones only at likely addresses: hosts in the system neighbor table, the first addresses of the range, and the /24 around this machine. The total is capped at 4096 hosts.
4. Only the default ports of known inference servers are tried, with a short TCP connect followed by a single `GET /v1/models`. Nothing else is sent, and nothing is stored except endpoints the user chooses to add.
5. The interface tells users to scan only networks they are allowed to scan.

## Pay-as-you-go APIs

1. API chats call each provider's public API (Anthropic Messages, OpenAI, Gemini's OpenAI-compatible endpoint) with the key the user entered, never with subscription credentials.
2. Costs shown in PowerChord are estimates from the providers' published list prices, recorded with a review date in `packages/core/src/models/pricing.ts`. The interface says so wherever it shows them; providers bill by their own records.
3. PowerChord asks before sending a message past a monthly budget or above the user's per-message threshold. It never sends requests the user did not start.

## Usage

1. PowerChord is a local, single-user application. It must not route one user's subscription usage on behalf of another person, expose agents over the network, or pool accounts.
2. Vendor usage limits and messages are surfaced to the user as reported by the agent; PowerChord does not attempt to circumvent them, rotate accounts, or automate account switching.

## Branding

1. Vendor names are used in plain text only to identify the software PowerChord interoperates with.
2. Vendor logos and brand colors are not used in PowerChord's name, logo or visual identity.

## References

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- Agent Client Protocol: [specification](https://agentclientprotocol.com), [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode)
- OpenAI: [Codex app-server](https://developers.openai.com/codex/app-server), [Sign in with ChatGPT](https://developers.openai.com/siwc), [Codex app-server with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- Google: [Google AI plans for developers](https://ai.google.dev/gemini-api/docs/google-ai-plans), [Antigravity FAQ](https://antigravity.google/docs/faq/), [Antigravity MCP documentation](https://antigravity.google/docs/mcp), [Antigravity Additional Terms of Service](https://antigravity.google/terms/), [Gemini CLI terms of service and privacy](https://geminicli.com/docs/resources/tos-privacy)
