import { spawn } from 'node:child_process';
import type { SessionOption } from '../types.ts';
import { stopProcessTree } from '../../system/process.ts';

/*
 * Asks the installed `claude` binary which models it offers, through the `initialize` control
 * request that the official Claude Agent SDK sends at startup. No prompt is sent, so no turn
 * runs. The response also describes the signed-in account; PowerChord reads only the models.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export interface ClaudeCodeModels {
  /** The model Claude Code uses when no model is chosen, such as "Opus 5.5". */
  defaultLabel: string | null;
  /** Aliases (`opus`, `sonnet`, ...) followed by specific versions (`claude-opus-4-8`, ...). */
  models: SessionOption[];
}

export interface ClaudeCodeModelQuery {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface ReportedModel {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseClaudeCodeModels(reported: unknown): ClaudeCodeModels {
  if (!Array.isArray(reported)) throw new Error('Claude Code did not report its models.');
  const entries = reported as ReportedModel[];
  const models: SessionOption[] = [];
  for (const entry of entries) {
    const id = text(entry.value);
    if (!id || id === 'default' || models.some((model) => model.id === id)) continue;
    const description = text(entry.description);
    models.push({
      id,
      label: text(entry.displayName) ?? id,
      ...(description ? { description } : {}),
    });
  }
  const fallback = entries.find((entry) => entry.value === 'default');
  const resolved = text(fallback?.resolvedModel);
  const match = resolved
    ? entries.find((entry) => entry !== fallback && entry.resolvedModel === resolved)
    : undefined;
  return { defaultLabel: text(match?.displayName) ?? null, models };
}

export function listClaudeCodeModels(query: ClaudeCodeModelQuery): Promise<ClaudeCodeModels> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      query.executable,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: query.cwd, env: query.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    const finish = (error: Error | null, result?: ClaudeCodeModels) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcessTree(child);
      if (error) reject(error);
      else resolve(result as ClaudeCodeModels);
    };
    const timer = setTimeout(
      () => finish(new Error('Claude Code did not report its models in time.')),
      query.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        let message: {
          type?: unknown;
          response?: { subtype?: unknown; error?: unknown; response?: { models?: unknown } };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.type !== 'control_response') continue;
        if (message.response?.subtype === 'error') {
          finish(new Error(text(message.response.error) ?? 'Claude Code refused the request.'));
          return;
        }
        try {
          finish(null, parseClaudeCodeModels(message.response?.response?.models));
        } catch (error) {
          finish(error as Error);
        }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      // Writes fail if the process exited; the close handler reports it.
    });
    child.on('error', (error) =>
      finish(new Error(`Could not start Claude Code: ${error.message}`)),
    );
    child.on('close', () => finish(new Error('Claude Code exited before reporting its models.')));
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'powerchord-models',
        request: { subtype: 'initialize' },
      })}\n`,
    );
  });
}
