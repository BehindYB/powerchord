import type { ChatMessage } from '../../models/openai-compatible.ts';
import { approximateTokens } from '../../models/pricing.ts';
import { truncateOutput } from './tools.ts';

/*
 * Compaction replaces a long conversation with a summary written by the model itself, so the
 * chat can continue within the model's context window.
 */

/** Share of the context window at which a turn compacts the conversation before continuing. */
export const AUTO_COMPACT_AT = 0.8;

/** Introduces the summary in the compacted history, as a question the summary answers. */
export const COMPACTED_QUESTION =
  'The earlier part of this conversation was compacted to save context. What happened so far?';

/** Added to a request that was in progress when the conversation was compacted. */
export const CONTINUE_NOTE =
  '(This request is in progress. The summary above records what has been done so far; continue from there.)';

const SUMMARY_INSTRUCTIONS = [
  'Summarize the conversation below between a user and an AI assistant, so that the assistant can',
  'continue the work from the summary alone, without the original messages. Include:',
  '- the user’s requests, goals and constraints, and decisions taken;',
  '- what has been done: files read, created or changed (with their paths), commands run and',
  '  their results;',
  '- the current state, open problems and the next steps.',
  'Keep exact names, paths, values and error messages that still matter. Leave out pleasantries',
  'and anything no longer relevant. Write concise notes in the language of the conversation.',
  'Answer with the summary only.',
].join('\n');

/** Tool output kept per call in the conversation given to the summarizer, from most to least. */
const TOOL_OUTPUT_STEPS = [2000, 400];

/** Rough token count of a message, including its tool calls. */
export function messageTokens(message: ChatMessage): number {
  let text = message.content;
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) text += call.name + call.arguments;
  }
  // A few tokens of per-message framing in every chat template.
  return approximateTokens(text) + 4;
}

export function historyTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

/** Writes a conversation as plain text, shortening tool output. */
export function renderConversation(
  messages: readonly ChatMessage[],
  toolOutputChars: number,
): string {
  return messages
    .map((message) => {
      switch (message.role) {
        case 'system':
          return '';
        case 'user':
          return `User: ${message.content}`;
        case 'assistant': {
          const calls = (message.toolCalls ?? []).map(
            (call) => `[Assistant called ${call.name} ${call.arguments}]`,
          );
          return [message.content ? `Assistant: ${message.content}` : '', ...calls]
            .filter(Boolean)
            .join('\n');
        }
        case 'tool':
          return `[${message.isError ? 'Tool error' : 'Tool result'}]\n${truncateOutput(message.content, toolOutputChars)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The request that asks the model for a summary. The conversation travels as text in a single
 * message, which every chat template and API accepts whatever tool calls it contains, and is
 * shortened to fit the context window when it is known.
 */
export function summaryRequest(
  messages: readonly ChatMessage[],
  windowTokens: number | null,
): ChatMessage[] {
  // Room for the instructions and the summary itself.
  const budget = windowTokens === null ? Infinity : Math.floor(windowTokens * 0.65);
  let conversation = '';
  for (const limit of TOOL_OUTPUT_STEPS) {
    conversation = renderConversation(messages, limit);
    if (approximateTokens(conversation) <= budget) break;
  }
  if (approximateTokens(conversation) > budget) {
    conversation = `[The earliest part of the conversation is omitted.]\n\n${conversation.slice(-budget * 4)}`;
  }
  return [
    {
      role: 'user',
      content: `${SUMMARY_INSTRUCTIONS}\n\n<conversation>\n${conversation}\n</conversation>`,
    },
  ];
}

/** Removes reasoning that some servers leave in the answer text. */
export function cleanSummary(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
