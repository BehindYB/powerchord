import { createInterface } from 'node:readline/promises';
import {
  AGENTS,
  buildChildEnv,
  detectAgent,
  detectAgents,
  getAgent,
  installOptions,
  isAgentId,
  resolveSearchPath,
  runInstall,
  runInteractive,
  type AgentId,
  type AgentStatus,
  type InstallOption,
} from '@powerchord/core';

export class UsageError extends Error {}

function describeAuth(status: AgentStatus): string {
  if (!status.installed) return '-';
  if (status.auth === null) return 'n/a';
  if (status.auth.state === 'signed-in')
    return status.auth.detail ? `yes (${status.auth.detail})` : 'yes';
  return status.auth.state === 'signed-out' ? 'no' : 'unknown';
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function parseAgentIds(values: readonly string[]): AgentId[] {
  return values.map((value) => {
    if (!isAgentId(value)) {
      throw new UsageError(
        `Unknown agent "${value}". Available agents: ${AGENTS.map((agent) => agent.id).join(', ')}`,
      );
    }
    return value;
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function doctor(): Promise<number> {
  const statuses = await detectAgents();
  const rows = [
    ['AGENT', 'ID', 'INSTALLED', 'VERSION', 'SIGNED IN', 'MODE'],
    ...statuses.map((status) => [
      status.displayName,
      status.id,
      status.installed ? 'yes' : 'no',
      status.version ?? '-',
      describeAuth(status),
      status.integration === 'driven' ? 'driven' : 'launch only',
    ]),
  ];
  console.log(table(rows));

  const installed = statuses.filter((status) => status.installed);
  if (installed.length > 0) {
    console.log('');
    for (const status of installed) console.log(`${status.id}: ${status.path}`);
  }
  if (statuses.some((status) => !status.installed)) {
    console.log('\nRun "powerchord setup" to install missing agents.');
  }
  return 0;
}

function chooseOption(
  options: InstallOption[],
  methodId: string | undefined,
): InstallOption | undefined {
  if (methodId !== undefined) return options.find((option) => option.method.id === methodId);
  return options.find((option) => option.missingRequirements.length === 0);
}

async function installAgent(
  status: AgentStatus,
  methodId: string | undefined,
  assumeYes: boolean,
): Promise<boolean> {
  const agent = getAgent(status.id);
  const options = await installOptions(agent);
  const option = chooseOption(options, methodId);

  if (!option) {
    console.error(`No usable install method for ${status.displayName} on this system.`);
    for (const candidate of options) {
      const missing = candidate.missingRequirements.join(', ') || 'none';
      console.error(`  ${candidate.method.id}: ${candidate.method.display} (missing: ${missing})`);
    }
    console.error(`  Documentation: ${agent.docsUrl}`);
    return false;
  }
  if (option.missingRequirements.length > 0) {
    console.error(
      `Cannot use "${option.method.id}": missing ${option.missingRequirements.join(', ')}.`,
    );
    return false;
  }

  console.log(`\n${status.displayName} (${status.vendor}) - ${option.method.label}`);
  console.log(`  Command: ${option.method.display}`);
  console.log(`  Source:  ${option.method.sourceUrl}`);

  if (!assumeYes && !(await confirm('Run this command?'))) {
    console.log('Skipped.');
    return false;
  }

  const result = await runInstall(option.method, {
    onOutput: (chunk, stream) =>
      (stream === 'stdout' ? process.stdout : process.stderr).write(chunk),
  });
  if (result.exitCode !== 0) {
    console.error(`\nInstallation failed with exit code ${result.exitCode}.`);
    return false;
  }

  const after = await detectAgent(agent);
  if (!after.installed) {
    console.error(
      '\nThe installer finished, but the agent was not found. Open a new terminal and run "powerchord doctor".',
    );
    return false;
  }
  console.log(`\nInstalled ${after.displayName} ${after.version ?? ''}`.trimEnd());
  console.log(`Next: sign in with "powerchord login ${after.id}".`);
  return true;
}

export async function setup(
  agentArgs: readonly string[],
  options: { method?: string; yes: boolean },
): Promise<number> {
  const requested = parseAgentIds(agentArgs);
  if (options.method !== undefined && requested.length !== 1) {
    throw new UsageError('--method requires exactly one agent.');
  }

  const statuses = await detectAgents();
  const targets =
    requested.length > 0
      ? statuses.filter((status) => requested.includes(status.id))
      : statuses.filter((status) => !status.installed);

  if (targets.length === 0) {
    console.log('All agents are installed.');
    return 0;
  }
  if (!options.yes && !process.stdin.isTTY) {
    throw new UsageError('Confirmation is required. Run in an interactive terminal or pass --yes.');
  }

  let failures = 0;
  for (const status of targets) {
    if (status.installed) {
      console.log(
        `${status.displayName} is already installed (${status.version ?? 'unknown version'}).`,
      );
      continue;
    }
    if (!(await installAgent(status, options.method, options.yes))) failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

export async function login(agentArgs: readonly string[]): Promise<number> {
  const [id, ...extra] = parseAgentIds(agentArgs);
  if (id === undefined || extra.length > 0)
    throw new UsageError('login requires exactly one agent.');

  const agent = getAgent(id);
  const status = await detectAgent(agent);
  if (!status.path) {
    console.error(`${agent.displayName} is not installed. Run "powerchord setup ${id}".`);
    return 1;
  }

  // The agent's own sign-in flow runs in this terminal; PowerChord never sees the credentials.
  console.log(
    `Starting ${agent.displayName} sign-in. Follow the instructions from ${agent.vendor}.\n`,
  );
  const env = buildChildEnv(await resolveSearchPath());
  const exitCode = await runInteractive({ command: status.path, args: agent.loginArgs }, { env });
  return exitCode ?? 1;
}
