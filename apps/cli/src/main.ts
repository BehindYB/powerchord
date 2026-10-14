#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { doctor, login, setup, UsageError } from './commands.ts';

const HELP = `PowerChord - agent setup and diagnostics

Usage:
  powerchord doctor                     Show installed agents, versions and sign-in state
  powerchord setup [agent...]           Install missing agents (or the listed ones)
        --method <id>                   Use a specific install method (one agent only)
        -y, --yes                       Do not ask for confirmation
  powerchord login <agent>              Run the agent's own sign-in flow in this terminal

Agents: claude-code, codex, gemini-cli, antigravity-cli

Agents are installed only from their vendors' official channels.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      yes: { type: 'boolean', short: 'y' },
      method: { type: 'string' },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case 'doctor':
      return doctor();
    case 'setup':
      return setup(rest, {
        yes: values.yes ?? false,
        ...(values.method ? { method: values.method } : {}),
      });
    case 'login':
      return login(rest);
    default:
      throw new UsageError(`Unknown command "${command}". Run "powerchord help" for usage.`);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    const isParseError =
      error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS');
    process.exitCode = error instanceof UsageError || isParseError ? 2 : 1;
  },
);
