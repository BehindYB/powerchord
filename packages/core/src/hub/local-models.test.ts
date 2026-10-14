import { afterEach, describe, expect, it } from 'vitest';
import { startFakeModelServer, type FakeModelServer } from '../test/fake-model-server.ts';
import { createLocalModelGateway } from './local-models.ts';

const servers: FakeModelServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(models: string[]): Promise<FakeModelServer> {
  const server = await startFakeModelServer({ models, answer: ['Short', ' summary'] });
  servers.push(server);
  return server;
}

describe('createLocalModelGateway', () => {
  it('lists reachable servers and skips offline ones', async () => {
    const lab = await start(['qwen3:0.6b']);
    const gateway = createLocalModelGateway({
      endpoints: async () => [
        { name: 'Lab', baseUrl: lab.baseUrl },
        { name: 'Offline', baseUrl: 'http://127.0.0.1:9/v1' },
      ],
      defaultModel: async () => null,
    });
    expect(await gateway.listModels()).toEqual([{ server: 'Lab', models: ['qwen3:0.6b'] }]);
  });

  it('routes a requested model to the server that has it', async () => {
    const small = await start(['qwen3:0.6b']);
    const large = await start(['llama3.3:70b']);
    const gateway = createLocalModelGateway({
      endpoints: async () => [
        { name: 'Small', baseUrl: small.baseUrl },
        { name: 'Large', baseUrl: large.baseUrl },
      ],
      defaultModel: async () => null,
    });

    const answer = await gateway.complete({
      prompt: 'Summarize',
      system: 'Be brief',
      model: 'llama3.3:70b',
    });
    expect(answer).toEqual({ server: 'Large', model: 'llama3.3:70b', text: 'Short summary' });
    expect(large.chatRequests[0]).toMatchObject({
      model: 'llama3.3:70b',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Summarize' },
      ],
    });
    await expect(gateway.complete({ prompt: 'x', model: 'missing' })).rejects.toThrow(/missing/);
  });

  it('uses the default model, then the first available one', async () => {
    const one = await start(['a']);
    const two = await start(['b']);
    const endpoints = async () => [
      { name: 'One', baseUrl: one.baseUrl },
      { name: 'Two', baseUrl: two.baseUrl },
    ];
    const preferred = createLocalModelGateway({
      endpoints,
      defaultModel: async () => ({ baseUrl: two.baseUrl, model: 'b' }),
    });
    expect((await preferred.complete({ prompt: 'x' })).model).toBe('b');

    const fallback = createLocalModelGateway({ endpoints, defaultModel: async () => null });
    expect((await fallback.complete({ prompt: 'x' })).model).toBe('a');
  });

  it('explains when no server is reachable', async () => {
    const gateway = createLocalModelGateway({
      endpoints: async () => [],
      defaultModel: async () => null,
    });
    await expect(gateway.complete({ prompt: 'x' })).rejects.toThrow(/No local model server/);
  });
});
