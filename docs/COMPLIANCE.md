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
4. API keys entered by the user are stored only in the operating system's secure storage and sent only to the provider they belong to.

## Agent binaries

1. Agents are installed only from the vendor's official channels (official installer scripts, the vendor's npm packages, or WinGet/Homebrew packages published by the vendor).
2. Every installation shows the exact command and requires explicit user confirmation. Installations run without administrator privileges.
3. Agent binaries are never bundled with PowerChord, patched, or wrapped in a way that disables or alters their built-in authentication.
4. For Claude, PowerChord runs the `claude` binary installed by the user, through its documented print mode (`-p` with stream-json input and output), and never with `--bare` or other options that change how it authenticates. PowerChord does not depend on the Claude Agent SDK package, which bundles its own copy of the binary.
5. Vendor agents whose consumer terms prohibit use from third-party applications (currently Antigravity CLI) are not integrated with consumer accounts.

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
3. The server listens only on local transports (stdio, or loopback HTTP with a per-install token). It is never exposed to the network.
4. Tool calls follow each agent's own approval settings; PowerChord does not ask users to auto-approve its tools.

## Network discovery

PowerChord can look for model servers (Ollama, LM Studio, llama.cpp, vLLM and similar) on the user's networks. To keep this a convenience rather than a scanner:

1. Discovery runs only when the user starts it; it never runs in the background or on a schedule.
2. Only private addresses are probed: loopback, RFC 1918 and carrier-grade NAT (100.64.0.0/10), and only on networks this machine is attached to, plus hosts where servers were found before.
3. Small networks (/22 or smaller) are probed completely; larger ones only at likely addresses: hosts in the system neighbor table, the first addresses of the range, and the /24 around this machine. The total is capped at 4096 hosts.
4. Only the default ports of known inference servers are tried, with a short TCP connect followed by a single `GET /v1/models`. Nothing else is sent, and nothing is stored except endpoints the user chooses to add.
5. The interface tells users to scan only networks they are allowed to scan.

## Usage

1. PowerChord is a local, single-user application. It must not route one user's subscription usage on behalf of another person, expose agents over the network, or pool accounts.
2. Vendor usage limits and messages are surfaced to the user as reported by the agent; PowerChord does not attempt to circumvent them, rotate accounts, or automate account switching.

## Branding

1. Vendor names are used in plain text only to identify the software PowerChord interoperates with.
2. Vendor logos and brand colors are not used in PowerChord's name, logo or visual identity.

## References

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- OpenAI: [Sign in with ChatGPT](https://developers.openai.com/siwc), [Codex app-server with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- Google: [Google AI plans for developers](https://ai.google.dev/gemini-api/docs/google-ai-plans), [Antigravity FAQ](https://antigravity.google/docs/faq/), [Antigravity MCP documentation](https://antigravity.google/docs/mcp), [Antigravity Additional Terms of Service](https://antigravity.google/terms/), [Gemini CLI terms of service and privacy](https://geminicli.com/docs/resources/tos-privacy)
