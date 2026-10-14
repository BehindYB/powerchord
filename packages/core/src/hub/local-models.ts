import { completeChat, listModels, type ChatMessage } from '../models/openai-compatible.ts';
import type { LocalModelGateway, LocalModelInfo } from './tools.ts';

export interface GatewayEndpoint {
  name: string;
  baseUrl: string;
}

export interface GatewayOptions {
  endpoints: () => Promise<GatewayEndpoint[]>;
  /** The user's preferred model for delegated prompts, if any. */
  defaultModel: () => Promise<{ baseUrl: string; model: string } | null>;
  listTimeoutMs?: number;
  completionTimeoutMs?: number;
}

const DEFAULT_LIST_TIMEOUT_MS = 4000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 10 * 60_000;

/** Serves `list_local_models` and `ask_local_model` from the user's saved model servers. */
export function createLocalModelGateway(options: GatewayOptions): LocalModelGateway {
  const listTimeout = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const completionTimeout = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;

  const online = async (): Promise<(GatewayEndpoint & { models: string[] })[]> => {
    const endpoints = await options.endpoints();
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          const models = await listModels(
            { baseUrl: endpoint.baseUrl },
            AbortSignal.timeout(listTimeout),
          );
          return { ...endpoint, models };
        } catch {
          return null;
        }
      }),
    );
    return results.filter(
      (entry): entry is GatewayEndpoint & { models: string[] } => entry !== null,
    );
  };

  return {
    async listModels(): Promise<LocalModelInfo[]> {
      return (await online()).map((endpoint) => ({
        server: endpoint.name,
        models: endpoint.models,
      }));
    },

    async complete(request) {
      const servers = await online();
      if (servers.length === 0) {
        throw new Error('No local model server is reachable. Add one in PowerChord > Models.');
      }

      let target: { endpoint: GatewayEndpoint; model: string } | undefined;
      if (request.model) {
        const endpoint = servers.find((server) => server.models.includes(request.model!));
        if (!endpoint) throw new Error(`No reachable server has the model "${request.model}".`);
        target = { endpoint, model: request.model };
      } else {
        const preferred = await options.defaultModel();
        const endpoint = preferred
          ? servers.find(
              (server) =>
                server.baseUrl === preferred.baseUrl && server.models.includes(preferred.model),
            )
          : undefined;
        if (preferred && endpoint) target = { endpoint, model: preferred.model };
        else {
          const first = servers.find((server) => server.models.length > 0);
          if (first) target = { endpoint: first, model: first.models[0]! };
        }
      }
      if (!target) throw new Error('No local model is available.');

      const messages: ChatMessage[] = [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        { role: 'user', content: request.prompt },
      ];
      const { text } = await completeChat(
        { baseUrl: target.endpoint.baseUrl },
        {
          model: target.model,
          messages,
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        },
        AbortSignal.timeout(completionTimeout),
      );
      return { server: target.endpoint.name, model: target.model, text };
    },
  };
}
