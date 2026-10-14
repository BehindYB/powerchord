import { afterEach, describe, expect, it } from 'vitest';
import { applySessionEvent } from '../sessions/transcript.ts';
import { ModelChatSession } from '../sessions/model-chat/session.ts';
import { createSessionState, type SessionEvent, type SessionState } from '../sessions/types.ts';
import { startFakeModelServer, type FakeModelServer } from '../test/fake-model-server.ts';
import { discoverServers, isPrivateAddress, planDiscovery, prefixLength } from './discovery.ts';
import { parseNeighborTable } from './network.ts';
import { listModels, normalizeBaseUrl, streamChat } from './openai-compatible.ts';

let server: FakeModelServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('normalizeBaseUrl', () => {
  it.each([
    ['10.0.0.5:11434', 'http://10.0.0.5:11434/v1'],
    ['http://10.0.0.5:1234/', 'http://10.0.0.5:1234/v1'],
    ['https://models.lan/v1/', 'https://models.lan/v1'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('OpenAI-compatible client', () => {
  it('lists models and streams chat chunks', async () => {
    server = await startFakeModelServer({ reasoning: ['Let me', ' think'], answer: ['Hi', '!'] });
    expect(await listModels({ baseUrl: server.baseUrl })).toEqual(['llama3.2:1b', 'qwen3:0.6b']);

    const chunks = [];
    for await (const chunk of streamChat(
      { baseUrl: server.baseUrl },
      { model: 'qwen3:0.6b', messages: [{ role: 'user', content: 'Hello' }] },
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'reasoning', text: 'Let me' },
      { type: 'reasoning', text: ' think' },
      { type: 'text', text: 'Hi' },
      { type: 'text', text: '!' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 2 } },
    ]);
  });
});

describe('protected endpoints', () => {
  it('send the key as a bearer token and explain rejections', async () => {
    server = await startFakeModelServer({ apiKey: 'secret-key' });
    await expect(listModels({ baseUrl: server.baseUrl })).rejects.toThrow(
      /401 Unauthorized: Invalid API key/,
    );
    expect(await listModels({ baseUrl: server.baseUrl, apiKey: 'secret-key' })).toHaveLength(2);
  });

  it('estimate the cost of priced turns', async () => {
    server = await startFakeModelServer();
    const events: SessionEvent[] = [];
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      priceFor: () => ({ input: 1, output: 2 }),
      onEvent: (event) => events.push(event),
    });
    session.send('Hello');
    await expect.poll(() => events.some((event) => event.type === 'turn-complete')).toBe(true);
    const turn = events.find((event) => event.type === 'turn-complete');
    expect(turn?.type === 'turn-complete' && turn.summary.costUsd).toBeCloseTo(16 / 1_000_000);
    session.close();
  });
});

describe('ModelChatSession', () => {
  function collect(): { events: SessionEvent[]; state: () => SessionState } {
    const events: SessionEvent[] = [];
    return { events, state: () => events.reduce(applySessionEvent, createSessionState()) };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  it('streams answers and keeps the conversation history', async () => {
    server = await startFakeModelServer({ reasoning: ['hmm'], answer: ['Hi', '!'] });
    const { events, state } = collect();
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      onEvent: (event) => events.push(event),
    });

    session.send('Hello');
    await waitFor(
      () => state().status === 'idle' && events.some((e) => e.type === 'turn-complete'),
    );
    session.send('Again');
    await waitFor(() => events.filter((e) => e.type === 'turn-complete').length === 2);

    expect(state().model).toBe('qwen3:0.6b');
    expect(state().items.map((item) => item.kind)).toEqual([
      'user',
      'thinking',
      'text',
      'turn-end',
      'user',
      'thinking',
      'text',
      'turn-end',
    ]);
    expect(state().items[2]).toMatchObject({ text: 'Hi!', streaming: false });
    expect(server.chatRequests[1]).toMatchObject({
      model: 'qwen3:0.6b',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'Again' },
      ],
    });
    session.close();
  });

  it('can be interrupted', async () => {
    server = await startFakeModelServer({ answer: ['a', 'b', 'c', 'd', 'e'], chunkDelayMs: 50 });
    const { events, state } = collect();
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      onEvent: (event) => events.push(event),
    });
    session.send('Hello');
    await waitFor(() => events.some((e) => e.type === 'block-delta'));
    session.interrupt();
    await waitFor(() => events.some((e) => e.type === 'interrupted'));
    expect(state().items.at(-1)?.kind).toBe('interrupted');
    await waitFor(() => state().status === 'idle');
    expect(state().status).toBe('idle');
  });

  it('reports server errors', async () => {
    const { events, state } = collect();
    const session = new ModelChatSession({
      endpoint: { baseUrl: 'http://127.0.0.1:9/v1' },
      model: 'missing',
      onEvent: (event) => events.push(event),
    });
    session.send('Hello');
    await waitFor(() => events.some((e) => e.type === 'turn-complete'));
    expect(state().items.map((item) => item.kind)).toEqual(['user', 'error', 'turn-end']);
  });
});

describe('planDiscovery', () => {
  it('scans small networks completely and skips own addresses', () => {
    const plan = planDiscovery({
      interfaces: [{ name: 'OpenVPN', address: '10.0.0.2', netmask: '255.255.255.0' }],
    });
    expect(plan.networks).toEqual([
      { interfaceName: 'OpenVPN', cidr: '10.0.0.0/24', mode: 'full' },
    ]);
    expect(plan.hosts).toHaveLength(1 + 253);
    expect(plan.hosts).toContain('10.0.0.1');
    expect(plan.hosts).toContain('10.0.0.254');
    expect(plan.hosts).not.toContain('10.0.0.2');
  });

  it('scans only likely hosts in large networks', () => {
    const plan = planDiscovery({
      interfaces: [{ name: 'VPN', address: '100.96.12.34', netmask: '255.192.0.0' }],
      neighbors: ['100.70.1.9', '192.168.0.1'],
      previousHosts: ['10.8.0.5'],
    });
    expect(plan.networks).toEqual([
      { interfaceName: 'VPN', cidr: '100.64.0.0/10', mode: 'likely' },
    ]);
    expect(plan.hosts.slice(0, 3)).toEqual(['127.0.0.1', '10.8.0.5', '100.70.1.9']);
    expect(plan.hosts).toContain('100.64.0.1');
    expect(plan.hosts).toContain('100.96.12.1');
    expect(plan.hosts).not.toContain('192.168.0.1');
    expect(plan.hosts.length).toBeLessThan(300);
  });

  it('ignores public addresses and honours the host budget', () => {
    expect(
      planDiscovery({ interfaces: [{ name: 'eth', address: '8.8.8.8', netmask: '255.255.255.0' }] })
        .hosts,
    ).toEqual(['127.0.0.1']);
    const plan = planDiscovery({
      interfaces: [{ name: 'lan', address: '192.168.0.10', netmask: '255.255.255.0' }],
      maxHosts: 10,
    });
    expect(plan.hosts).toHaveLength(10);
  });

  it('parses prefixes and private ranges', () => {
    expect(prefixLength('255.255.252.0')).toBe(22);
    expect(prefixLength('255.0.255.0')).toBeNull();
    expect(isPrivateAddress('172.20.1.1')).toBe(true);
    expect(isPrivateAddress('172.32.1.1')).toBe(false);
  });
});

describe('parseNeighborTable', () => {
  it('reads Windows arp output in any language', () => {
    const output = [
      '',
      'Interfaccia: 10.0.0.2 --- 0x7',
      '  Indirizzo Internet    Indirizzo fisico      Tipo',
      '  10.0.0.1              00-11-22-33-44-55     dinamico',
      '  10.0.0.255            ff-ff-ff-ff-ff-ff     statico',
      '  224.0.0.22            01-00-5e-00-00-16     statico',
    ].join('\r\n');
    expect(parseNeighborTable(output)).toEqual(['10.0.0.1']);
  });

  it('reads Linux ip neigh output', () => {
    expect(parseNeighborTable('10.8.0.1 dev tun0 lladdr 00:11:22:33:44:55 REACHABLE')).toEqual([
      '10.8.0.1',
    ]);
  });
});

describe('discoverServers', () => {
  it('finds a model server and ignores closed ports', async () => {
    server = await startFakeModelServer();
    const progress: number[] = [];
    const found = await discoverServers({
      hosts: ['127.0.0.1'],
      ports: [
        { port: server.port, server: 'Test' },
        { port: 9, server: 'Closed' },
      ],
      onProgress: (done) => progress.push(done),
    });
    expect(found).toEqual([
      {
        baseUrl: server.baseUrl,
        host: '127.0.0.1',
        port: server.port,
        serverHint: 'Test',
        models: ['llama3.2:1b', 'qwen3:0.6b'],
      },
    ]);
    expect(progress.at(-1)).toBe(2);
  });
});
