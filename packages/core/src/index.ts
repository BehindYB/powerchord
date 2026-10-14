export type {
  AgentDefinition,
  AgentId,
  AuthState,
  AuthStatus,
  CommandSpec,
  InstallMethod,
  IntegrationMode,
  Platform,
} from './agents/types.ts';
export { AGENTS, getAgent, installMethodsFor, isAgentId, parseSemver } from './agents/catalog.ts';
export {
  agentSearchPath,
  buildChildEnv,
  currentPlatform,
  detectAgent,
  detectAgents,
  type AgentStatus,
  type DetectOptions,
} from './agents/detect.ts';
export { installOptions, runInstall, type InstallOption } from './agents/install.ts';
export {
  runCommand,
  runInteractive,
  type CommandResult,
  type OutputStream,
  type RunOptions,
} from './system/run.ts';
export { findExecutable, resolveSearchPath } from './system/search-path.ts';
export { openInTerminal, type TerminalLaunchOptions } from './system/terminal.ts';
