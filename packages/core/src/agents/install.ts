import { runCommand, type CommandResult, type RunOptions } from '../system/run.ts';
import { findExecutable, resolveSearchPath } from '../system/search-path.ts';
import { installMethodsFor } from './catalog.ts';
import { buildChildEnv, currentPlatform } from './detect.ts';
import type { AgentDefinition, InstallMethod, Platform } from './types.ts';

export interface InstallOption {
  method: InstallMethod;
  /** Required executables that were not found; the method cannot run until they are installed. */
  missingRequirements: string[];
}

/** Lists the install methods for an agent on this platform, in order of preference. */
export async function installOptions(
  agent: AgentDefinition,
  options: { env?: NodeJS.ProcessEnv; platform?: Platform; searchPath?: readonly string[] } = {},
): Promise<InstallOption[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const searchPath = options.searchPath ?? (await resolveSearchPath(env, platform));

  return Promise.all(
    installMethodsFor(agent, platform).map(async (method) => {
      const missingRequirements: string[] = [];
      for (const requirement of method.requires) {
        if (!(await findExecutable(requirement, searchPath, platform))) {
          missingRequirements.push(requirement);
        }
      }
      return { method, missingRequirements };
    }),
  );
}

/**
 * Runs an install method. Callers must have shown `method.display` to the user and received
 * explicit confirmation first (docs/COMPLIANCE.md).
 */
export async function runInstall(
  method: InstallMethod,
  options: Omit<RunOptions, 'env'> & { env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const platform = currentPlatform();
  const searchPath = await resolveSearchPath(env, platform);
  return runCommand(method.command, { ...options, env: buildChildEnv(searchPath, env, platform) });
}
