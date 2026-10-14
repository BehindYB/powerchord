import type { SessionEvent, TurnSummary, UsageLimits, UsageWindow } from '../types.ts';

/*
 * Translates Claude Code `--output-format stream-json` lines into session events.
 * Reference: https://code.claude.com/docs/en/headless
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumTokens(...values: unknown[]): number | null {
  const numbers = values.map(num).filter((value): value is number => value !== null);
  return numbers.length === 0 ? null : numbers.reduce((total, value) => total + value, 0);
}

/** Flattens tool result content, which is a string or a list of content blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isObject(block)) return '';
      if (block['type'] === 'text') return str(block['text']) ?? '';
      return `[${str(block['type']) ?? 'content'}]`;
    })
    .join('\n');
}

function usageWindow(value: unknown): UsageWindow | undefined {
  if (!isObject(value)) return undefined;
  const utilization = num(value['utilization']);
  const resetsAt = num(value['resetsAt']);
  return utilization === null || resetsAt === null ? undefined : { utilization, resetsAt };
}

type BlockKind = 'text' | 'thinking';

export class ClaudeStreamParser {
  /** Streamed text and thinking blocks per message, used to match later complete blocks. */
  private readonly streamedBlocks = new Map<
    string,
    { id: string; kind: BlockKind; matched: boolean }[]
  >();
  private fallbackCounter = 0;

  /** Parses one stdout line. Unknown or malformed lines yield no events. */
  parseLine(line: string): SessionEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return isObject(message) ? this.parseMessage(message) : [];
  }

  parseMessage(message: Json): SessionEvent[] {
    // Subagent traffic is identified by a parent tool call; only the main conversation is shown.
    if (message['parent_tool_use_id'] !== null && message['parent_tool_use_id'] !== undefined) {
      return [];
    }

    switch (message['type']) {
      case 'system':
        return this.parseSystem(message);
      case 'stream_event':
        return this.parseStreamEvent(message);
      case 'assistant':
        return this.parseAssistant(message);
      case 'user':
        return this.parseUser(message);
      case 'result':
        return this.parseResult(message);
      case 'rate_limit_event':
        return this.parseRateLimit(message);
      default:
        return [];
    }
  }

  private parseSystem(message: Json): SessionEvent[] {
    if (message['subtype'] !== 'init') return [];
    const agentSessionId = str(message['session_id']);
    if (agentSessionId === null) return [];
    return [
      {
        type: 'session-info',
        agentSessionId,
        model: str(message['model']),
        permissionMode: str(message['permissionMode']),
      },
    ];
  }

  private parseStreamEvent(message: Json): SessionEvent[] {
    const event = message['event'];
    const messageId = str(message['api_message_id']);
    if (!isObject(event) || messageId === null) return [];
    const index = num(event['index']);
    const id = `${messageId}:${index}`;

    switch (event['type']) {
      case 'content_block_start': {
        const block = event['content_block'];
        if (!isObject(block) || index === null) return [];
        if (block['type'] === 'text' || block['type'] === 'thinking') {
          const kind: BlockKind = block['type'];
          const blocks = this.streamedBlocks.get(messageId) ?? [];
          blocks.push({ id, kind, matched: false });
          this.streamedBlocks.set(messageId, blocks);
          return [{ type: 'block-start', id, kind }];
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = event['delta'];
        if (!isObject(delta)) return [];
        const text =
          delta['type'] === 'text_delta'
            ? str(delta['text'])
            : delta['type'] === 'thinking_delta'
              ? str(delta['thinking'])
              : null;
        return text ? [{ type: 'block-delta', id, text }] : [];
      }
      case 'content_block_stop':
        return [{ type: 'block-end', id }];
      default:
        return [];
    }
  }

  private matchStreamedBlock(messageId: string, kind: BlockKind): string {
    const block = this.streamedBlocks
      .get(messageId)
      ?.find((candidate) => candidate.kind === kind && !candidate.matched);
    if (block) {
      block.matched = true;
      return block.id;
    }
    this.fallbackCounter += 1;
    return `${messageId}:complete-${this.fallbackCounter}`;
  }

  private parseAssistant(message: Json): SessionEvent[] {
    const body = message['message'];
    if (!isObject(body) || !Array.isArray(body['content'])) return [];
    const messageId = str(body['id']) ?? 'message';
    const events: SessionEvent[] = [];

    for (const block of body['content']) {
      if (!isObject(block)) continue;
      if (block['type'] === 'text' || block['type'] === 'thinking') {
        const kind: BlockKind = block['type'];
        const text = str(block[kind === 'text' ? 'text' : 'thinking']) ?? '';
        events.push({ type: 'text', id: this.matchStreamedBlock(messageId, kind), kind, text });
      } else if (block['type'] === 'tool_use') {
        const toolCallId = str(block['id']);
        const name = str(block['name']);
        if (toolCallId && name) {
          events.push({ type: 'tool-call', toolCallId, name, input: block['input'] ?? {} });
        }
      }
    }
    return events;
  }

  private parseUser(message: Json): SessionEvent[] {
    const body = message['message'];
    if (!isObject(body) || !Array.isArray(body['content'])) return [];
    const events: SessionEvent[] = [];
    for (const block of body['content']) {
      if (!isObject(block) || block['type'] !== 'tool_result') continue;
      const toolCallId = str(block['tool_use_id']);
      if (!toolCallId) continue;
      events.push({
        type: 'tool-result',
        toolCallId,
        output: toolResultText(block['content']),
        isError: block['is_error'] === true,
      });
    }
    return events;
  }

  private parseResult(message: Json): SessionEvent[] {
    const usage = isObject(message['usage']) ? message['usage'] : {};
    const summary: TurnSummary = {
      isError: message['is_error'] === true,
      durationMs: num(message['duration_ms']),
      costUsd: num(message['total_cost_usd']),
      inputTokens: sumTokens(
        usage['input_tokens'],
        usage['cache_creation_input_tokens'],
        usage['cache_read_input_tokens'],
      ),
      outputTokens: num(usage['output_tokens']),
    };
    const id = str(message['uuid']) ?? `result-${Date.now()}`;
    const events: SessionEvent[] = [];
    if (summary.isError) {
      const detail = str(message['result']) ?? str(message['subtype']) ?? 'The turn failed.';
      events.push({ type: 'error', id: `${id}:error`, message: detail });
    }
    events.push({ type: 'turn-complete', id, summary });
    return events;
  }

  private parseRateLimit(message: Json): SessionEvent[] {
    const info = message['rate_limit_info'];
    if (!isObject(info) || !isObject(info['unifiedWindows'])) return [];
    const windows = info['unifiedWindows'];
    const limits: UsageLimits = {};
    const fiveHour = usageWindow(windows['five_hour']);
    const sevenDay = usageWindow(windows['seven_day']);
    if (fiveHour) limits.fiveHour = fiveHour;
    if (sevenDay) limits.sevenDay = sevenDay;
    return fiveHour || sevenDay ? [{ type: 'usage-limits', limits }] : [];
  }
}
