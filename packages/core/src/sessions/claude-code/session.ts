import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  MCP_SERVER_NAME,
  PERMISSION_TOOL_NAME,
  type McpClientHandlers,
  type McpClientRegistration,
  type PermissionDecision,
  type PermissionRequest,
  type PowerChordMcpServer,
} from '../../mcp/server.ts';
import {
  CLAUDE_PERMISSION_MODES,
  QUESTION_TOOL_NAME,
  type AgentSession,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionScope,
  type QuestionAnswers,
  type SessionEvent,
  type SessionStatus,
} from '../types.ts';
import { stopProcessTree } from '../../system/process.ts';
import { ClaudeStreamParser } from './parser.ts';

/*
 * Drives the user's installed, unmodified `claude` binary in print mode with stream-json input
 * and output (https://code.claude.com/docs/en/headless). The binary performs its own
 * authentication; PowerChord never handles Claude credentials.
 */

const STDERR_TAIL_BYTES = 4000;
const CONTROL_TIMEOUT_MS = 30_000;

/** What rewinding files to a message changes, as Claude Code reports it. */
export interface ClaudeFileRewind {
  canRewind: boolean;
  error: string | null;
  files: string[];
}

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
  /** Gives the session PowerChord's hub tools (shared tasks and notes, local models). */
  hubTools?: boolean;
  /** PowerChord session id given to the hub, which links delegated sub-chats to this session. */
  hubSessionId?: string;
  /** Author name recorded for hub changes made by this session. */
  label?: string;
  /** Added to Claude Code's system prompt with its documented `--append-system-prompt` option. */
  appendSystemPrompt?: string;
  /** After a rewind: the conversation entry the resumed conversation continues from. */
  resumeSessionAt?: string;
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
}

export class ClaudeCodeSession implements AgentSession {
  readonly agentSessionId: string;
  private readonly options: ClaudeCodeSessionOptions;
  private readonly registration: McpClientRegistration;
  private readonly mcpHandlers: McpClientHandlers;
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
  private resumeAt: string | null;
  private readonly pendingControls = new Map<
    string,
    { resolve: (response: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(options: ClaudeCodeSessionOptions) {
    this.options = options;
    this.agentSessionId = options.resumeSessionId ?? randomUUID();
    this.hasConversation = options.resumeSessionId !== undefined;
    this.model = options.model;
    this.permissionMode = options.permissionMode;
    this.resumeAt = options.resumeSessionAt ?? null;
    this.mcpHandlers = {
      label: options.label ?? 'Claude Code',
      requestPermission: (request) => this.requestPermission(request),
      hub: options.hubTools ?? false,
      projectFolder: options.cwd,
      ...(options.hubSessionId ? { sessionId: options.hubSessionId } : {}),
    };
    this.registration = options.mcp.register(this.mcpHandlers);
  }

  /** Updates the author name recorded for this session's hub changes. */
  setLabel(label: string): void {
    this.mcpHandlers.label = label;
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
    if (behavior === 'allow' && scope === 'session' && pending.toolName !== QUESTION_TOOL_NAME)
      this.toolsAllowedForSession.add(pending.toolName);
    pending.resolve(
      behavior === 'allow' ? { behavior } : { behavior, message: 'The user denied this action.' },
    );
    this.emit({ type: 'permission-resolved', requestId, behavior });
  }

  /** Answers a question the agent asked with AskUserQuestion. */
  answerQuestion(requestId: string, answers: QuestionAnswers): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.toolName !== QUESTION_TOOL_NAME) return;
    this.pendingPermissions.delete(requestId);
    // The tool reads the answers from its input (https://code.claude.com/docs/en/agent-sdk/user-input).
    pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
    this.emit({ type: 'permission-resolved', requestId, behavior: 'allow', answers });
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

  setMode(mode: string): void {
    if (!CLAUDE_PERMISSION_MODES.includes(mode as PermissionMode)) {
      throw new Error(`Unknown permission mode: ${mode}`);
    }
    this.permissionMode = mode as PermissionMode;
    this.scheduleRestart();
  }

  /**
   * Restores the files Claude Code changed with its file tools since the message `promptId`, or
   * with `dryRun` only reports them. Uses Claude Code's file checkpointing, the same mechanism as
   * the Agent SDK's `rewindFiles`; changes made by shell commands are not tracked.
   */
  async rewindFiles(promptId: string, dryRun: boolean): Promise<ClaudeFileRewind> {
    if (this.closed) throw new Error('Session is closed');
    if (this.status === 'running') throw new Error('Wait for the current turn or stop it first.');
    const started = !this.child;
    if (started) this.startProcess();
    try {
      const response = await this.control({
        subtype: 'rewind_files',
        user_message_id: promptId,
        ...(dryRun ? { dry_run: true } : {}),
      });
      const result = typeof response === 'object' && response !== null ? response : {};
      const fields = result as Record<string, unknown>;
      return {
        canRewind: fields['canRewind'] === true,
        error: typeof fields['error'] === 'string' ? fields['error'] : null,
        files: Array.isArray(fields['filesChanged'])
          ? fields['filesChanged'].filter((file): file is string => typeof file === 'string')
          : [],
      };
    } finally {
      // A process started only for this request waits for the next message.
      if (started && this.status === 'starting') this.setStatus('idle');
    }
  }

  private control(request: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Claude Code is not running.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error('Claude Code did not answer in time.'));
      }, CONTROL_TIMEOUT_MS);
      this.pendingControls.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`,
      );
    });
  }

  private handleControlResponse(message: Record<string, unknown>): void {
    const response = message['response'];
    if (typeof response !== 'object' || response === null) return;
    const fields = response as Record<string, unknown>;
    const pending =
      typeof fields['request_id'] === 'string'
        ? this.pendingControls.get(fields['request_id'])
        : undefined;
    if (!pending) return;
    this.pendingControls.delete(fields['request_id'] as string);
    if (fields['subtype'] === 'success') pending.resolve(fields['response']);
    else
      pending.reject(new Error(typeof fields['error'] === 'string' ? fields['error'] : 'Failed'));
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
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: this.registration.url,
          headers: this.registration.headers,
        },
      },
    };
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // User message UUIDs and subagent text, as the Agent SDK requests them.
      '--replay-user-messages',
      '--forward-subagent-text',
      this.hasConversation ? '--resume' : '--session-id',
      this.agentSessionId,
      ...(this.hasConversation && this.resumeAt ? ['--resume-session-at', this.resumeAt] : []),
      '--permission-mode',
      this.permissionMode,
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--permission-prompt-tool',
      `mcp__${MCP_SERVER_NAME}__${PERMISSION_TOOL_NAME}`,
      ...(this.model ? ['--model', this.model] : []),
      ...(this.options.appendSystemPrompt
        ? ['--append-system-prompt', this.options.appendSystemPrompt]
        : []),
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
      // Enables the file checkpoints used to rewind file changes, as the Agent SDK does.
      env: { ...this.options.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
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
        this.handleLine(line);
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

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const fields = message as Record<string, unknown>;
    if (fields['type'] === 'control_response') return this.handleControlResponse(fields);
    for (const event of this.parser.parseMessage(fields)) this.handleAgentEvent(event);
  }

  private handleAgentEvent(event: SessionEvent): void {
    if (event.type === 'session-info') this.hasConversation = true;
    // The first message after a rewind continues the conversation from the rewind point.
    if (event.type === 'agent-entry' && event.prompt) this.resumeAt = null;
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
    for (const pending of this.pendingControls.values()) {
      pending.reject(new Error('Claude Code stopped.'));
    }
    this.pendingControls.clear();
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
    stopProcessTree(child);
  }

  private requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (
      request.toolName !== QUESTION_TOOL_NAME &&
      this.toolsAllowedForSession.has(request.toolName)
    ) {
      return Promise.resolve({ behavior: 'allow' });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        toolName: request.toolName,
        input: request.input,
        resolve,
      });
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
