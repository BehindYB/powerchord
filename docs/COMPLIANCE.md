# Compliance rules

PowerChord integrates with services whose terms restrict how third-party software may use subscription accounts. These rules keep the project within those terms. They are mandatory for every contribution.

## Vendor status

Last reviewed: 2026-10-14. Re-check the referenced terms before changing an integration.

| Vendor    | Subscription use in PowerChord | Basis                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | Allowed, with conditions       | Products may run Claude Code if the binary is unmodified, its built-in authentication is left intact, and each end user authenticates with their own subscription or API key. Anthropic does not allow third-party apps to offer Claude.ai login or to handle Claude.ai credentials.                                                                                      |
| OpenAI    | Allowed via the official agent | The open-source Codex CLI is driven through its documented app-server protocol, signed in by the user with `codex login`. OpenAI also runs an official "Sign in with ChatGPT" program for third-party apps; using it requires a client ID issued by OpenAI.                                                                                                               |
| Google    | **Not allowed**                | The Antigravity FAQ states that wrapping `agy` inside third-party coding agents or applications is not supported under consumer plans, and the Antigravity terms prohibit accessing the service through third-party software. Gemini CLI no longer serves Google AI Pro/Ultra plans. Gemini is supported only through API keys (AI Studio, Vertex AI, Gemini Enterprise). |

## Credentials

1. Never read, parse, copy, store or transmit credential or session files written by vendor CLIs (for example `~/.claude/`, `~/.codex/auth.json`, `~/.gemini/`).
2. Never implement a sign-in flow for a vendor account inside PowerChord, unless the vendor runs an official program for third-party apps and PowerChord holds the credentials that program issues (for example a "Sign in with ChatGPT" client ID). Otherwise sign-in is performed by the vendor CLI's own login command, which PowerChord may launch in a terminal.
3. Never call vendor endpoints directly with subscription credentials outside such an official program.
4. API keys entered by the user are stored only in the operating system's secure storage and sent only to the provider they belong to.

## Agent binaries

1. Agents are installed only from the vendor's official channels (official installer scripts, the vendor's npm packages, or WinGet/Homebrew packages published by the vendor).
2. Every installation shows the exact command and requires explicit user confirmation. Installations run without administrator privileges.
3. Agent binaries are never bundled with PowerChord, patched, or wrapped in a way that disables or alters their built-in authentication.
4. For Claude, PowerChord runs the `claude` binary installed by the user.
5. Vendor agents whose consumer terms prohibit use from third-party applications (currently Antigravity CLI) are not integrated with consumer accounts.

## Usage

1. PowerChord is a local, single-user application. It must not route one user's subscription usage on behalf of another person, expose agents over the network, or pool accounts.
2. Vendor usage limits and messages are surfaced to the user as reported by the agent; PowerChord does not attempt to circumvent them, rotate accounts, or automate account switching.

## Branding

1. Vendor names are used in plain text only to identify the software PowerChord interoperates with.
2. Vendor logos and brand colors are not used in PowerChord's name, logo or visual identity.

## References

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- OpenAI: [Sign in with ChatGPT](https://developers.openai.com/siwc), [Codex app-server with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- Google: [Antigravity FAQ](https://antigravity.google/docs/faq/), [Antigravity Additional Terms of Service](https://antigravity.google/terms/), [Gemini CLI terms of service and privacy](https://geminicli.com/docs/resources/tos-privacy)
