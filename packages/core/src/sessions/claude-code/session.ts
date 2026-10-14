import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  MCP_SERVER_NAME,
  PERMISSION_TOOL_NAME,
  type McpClientRegistration,
  type PermissionDecision,
  type PermissionRequest,
  type PowerChordMcpServer,
} from '../../mcp/server.ts';
import type { PermissionBehavior, PermissionMode, SessionEvent, SessionStatus } from '../types.ts';
import { ClaudeStreamParser } from './parser.ts';

/*
 * Drives the user's installed, unmodified `claude` binary in print mode with stream-json input
 * and output (https://code.claude.com/docs/en/headless). The binary performs its own
 * authentication; PowerChord never handles Claude credentials.
 */

/** Tools that need a dedicated user interface PowerChord does not provide yet. */
const DISALLOWED_TOOLS = ['AskUserQuestion'];
const STDERR_TAIL_BYTES = 4000;

export interface ClaudeCodeSessionOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcp: PowerChordMcpServer;
  model: string | null;
  permissionMode: PermissionMode;
  onEvent: (event: SessionEvent) => void;
  /** Existing Claude Code session to resume instead of starting a new one. */
  resumeSessionId?: string;
}

export type PermissionScope = 'once' | 'session';

interface PendingPermission {
  toolName: string;
  resolve: (decision: PermissionDecision) => void;
}

export class ClaudeCodeSession {
  readonly agentSessionId: string;
  private readonly options: ClaudeCodeSessionOptions;
  private readonly registration: McpClientRegistration;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly toolsAllowedForSession = new Set<string>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new ClaudeStreamParser();
  private status: SessionStatus = 'idle';
  private hasConversation: boolean;
  private model: string | null;
  private permissionMode: PermissionMode;
  private restartAfterTurn = false;
  private expectedExit = false;
  private stderrTail = '';
  private closed = false;

  constructor(options: ClaudeCodeSessionOptions) {
    this.options = options;
    this.agentSessionId = options.resumeSessionId ?? randomUUID();
    this.hasConversation = options.resumeSessionId !== undefined;
    this.model = options.model;
    this.permissionMode = options.permissionMode;
    this.registration = options.mcp.register({
      requestPermission: (request) => this.requestPermission(request),
    });
  }

  send(text: string): void {
    if (this.closed) throw new Error('Session is closed');
    const child = this.child ?? this.startProcess();
    this.emit({ type: 'user-message', id: randomUUID(), text });
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    child.stdin.write(`${line}\n`);
    this.setStatus('running');
  }

  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    scope: PermissionScope,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    if (behavior === 'allow' && scope === 'session')
      this.toolsAllowedForSession.add(pending.toolName);
    pending.resolve(
      behavior === 'allow' ? { behavior } : { behavior, message: 'The user denied this action.' },
    );
    this.emit({ type: 'permission-resolved', requestId, behavior });
  }

  /** Stops the current turn. The conversation continues with the next message. */
  interrupt(): void {
    if (!this.child) return;
    this.stopProcess();
    this.emit({ type: 'interrupted', id: randomUUID() });
  }

  /** Applies from the next turn; the agent process restarts and resumes the conversation. */
  setModel(model: string | null): void {
    this.model = model;
    this.scheduleRestart();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.scheduleRestart();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopProcess();
    this.registration.dispose();
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private scheduleRestart(): void {
    if (!this.child) return;
    if (this.status === 'running') this.restartAfterTurn = true;
    else this.stopProcess();
  }

  private buildArgs(): string[] {
    const mcpConfig = {
      mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: this.registration.url } },
    };
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      this.hasConversation ? '--resume' : '--session-id',
      this.agentSessionId,
      '--permission-mode',
      this.permissionMode,
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--permission-prompt-tool',
      `mcp__${MCP_SERVER_NAME}__${PERMISSION_TOOL_NAME}`,
      '--disallowedTools',
      ...DISALLOWED_TOOLS,
      ...(this.model ? ['--model', this.model] : []),
    ];
  }

  private startProcess(): ChildProcessWithoutNullStreams {
    this.setStatus('starting');
    this.parser = new ClaudeStreamParser();
    this.stderrTail = '';
    this.expectedExit = false;
    this.restartAfterTurn = false;

    const child = spawn(this.options.executable, this.buildArgs(), {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        for (const event of this.parser.parseLine(line)) this.handleAgentEvent(event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on('error', () => {
      // Writes fail if the process exited; the close handler reports the exit.
    });
    child.on('error', (error) => {
      this.emit({
        type: 'error',
        id: randomUUID(),
        message: `Could not start Claude Code: ${error.message}`,
      });
    });
    child.on('close', (code) => this.handleExit(child, code));
    return child;
  }

  private handleAgentEvent(event: SessionEvent): void {
    if (event.type === 'session-info') this.hasConversation = true;
    this.emit(event);
    if (event.type === 'turn-complete') {
      this.setStatus('idle');
      if (this.restartAfterTurn) this.stopProcess();
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.denyPendingPermissions();
    if (!this.expectedExit && !this.closed) {
      const detail = this.stderrTail.trim();
      this.emit({
        type: 'error',
        id: randomUUID(),
        message: `Claude Code exited unexpectedly (code ${code ?? 'unknown'}).${detail ? `\n${detail}` : ''}`,
      });
    }
    this.setStatus(this.closed ? 'stopped' : 'idle');
  }

  private stopProcess(): void {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    child.stdin.end();
    if (process.platform === 'win32' && child.pid !== undefined) {
      // Ends Claude Code together with any commands it started.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGINT');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }, 3000).unref();
    }
  }

  private requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.toolsAllowedForSession.has(request.toolName)) {
      return Promise.resolve({ behavior: 'allow' });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { toolName: request.toolName, resolve });
      this.emit({
        type: 'permission-request',
        requestId,
        toolName: request.toolName,
        input: request.input,
        toolCallId: request.toolCallId,
      });
    });
  }

  private denyPendingPermissions(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.respondToPermission(requestId, 'deny', 'once');
    }
  }
}
