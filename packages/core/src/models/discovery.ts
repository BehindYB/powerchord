import { connect } from 'node:net';
import { listModels } from './openai-compatible.ts';

/*
 * Discovery of OpenAI-compatible model servers on the user's own networks. It only runs when the
 * user asks for it, only targets private address ranges, and limits concurrency
 * (docs/COMPLIANCE.md, "Network discovery").
 */

export interface KnownPort {
  port: number;
  server: string;
}

/** Default ports of popular local inference servers. */
export const KNOWN_PORTS: readonly KnownPort[] = [
  { port: 11434, server: 'Ollama' },
  { port: 1234, server: 'LM Studio' },
  { port: 8080, server: 'llama.cpp' },
  { port: 8000, server: 'vLLM' },
  { port: 1337, server: 'Jan' },
  { port: 4891, server: 'GPT4All' },
  { port: 5001, server: 'KoboldCpp' },
  { port: 30000, server: 'SGLang' },
];

export interface InterfaceAddress {
  name: string;
  address: string;
  netmask: string;
}

export interface ScannedNetwork {
  interfaceName: string;
  cidr: string;
  /** `full` scans every address; `likely` scans the most probable ones in a large network. */
  mode: 'full' | 'likely';
}

export interface DiscoveryPlan {
  hosts: string[];
  networks: ScannedNetwork[];
}

export interface PlanOptions {
  interfaces: readonly InterfaceAddress[];
  /** Addresses from the system neighbor (ARP) table. */
  neighbors?: readonly string[];
  /** Hosts where servers were found before. */
  previousHosts?: readonly string[];
  maxHosts?: number;
  /** Networks with this prefix length or longer are scanned completely. */
  fullScanMinPrefix?: number;
  /** Number of addresses at the start of a large network treated as likely server addresses. */
  likelyLowHosts?: number;
}

const DEFAULT_MAX_HOSTS = 4096;
const DEFAULT_FULL_SCAN_MIN_PREFIX = 22;
const DEFAULT_LIKELY_LOW_HOSTS = 20;

export function ipToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export function prefixLength(netmask: string): number | null {
  const value = ipToInt(netmask);
  if (value === null) return null;
  const bits = value.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bits)) return null;
  const firstZero = bits.indexOf('0');
  return firstZero === -1 ? 32 : firstZero;
}

const PRIVATE_RANGES: readonly [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10], // Carrier-grade NAT, used by many VPNs.
  ['127.0.0.0', 8],
];

function inRange(address: number, base: number, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return address >= base && address < base + size;
}

/** True for loopback, RFC 1918 and carrier-grade NAT addresses. */
export function isPrivateAddress(address: string): boolean {
  const value = ipToInt(address);
  if (value === null) return false;
  return PRIVATE_RANGES.some(([base, prefix]) => inRange(value, ipToInt(base)!, prefix));
}

/** Plans which hosts to probe. Pure, so the selection logic can be tested without a network. */
export function planDiscovery(options: PlanOptions): DiscoveryPlan {
  const maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
  const fullScanMinPrefix = options.fullScanMinPrefix ?? DEFAULT_FULL_SCAN_MIN_PREFIX;
  const likelyLowHosts = options.likelyLowHosts ?? DEFAULT_LIKELY_LOW_HOSTS;

  const hosts = new Set<string>(['127.0.0.1']);
  const ownAddresses = new Set(options.interfaces.map((entry) => entry.address));
  const add = (address: string) => {
    if (hosts.size >= maxHosts || ownAddresses.has(address) || !isPrivateAddress(address)) return;
    hosts.add(address);
  };

  for (const host of options.previousHosts ?? []) add(host);

  const networks: ScannedNetwork[] = [];
  for (const entry of options.interfaces) {
    const address = ipToInt(entry.address);
    const prefix = prefixLength(entry.netmask);
    if (address === null || prefix === null || prefix >= 31 || !isPrivateAddress(entry.address)) {
      continue;
    }
    const size = 2 ** (32 - prefix);
    const network = address - (address % size);
    const firstHost = network + 1;
    const lastHost = network + size - 2;
    const inNetwork = (value: number) => value >= firstHost && value <= lastHost;
    const mode = prefix >= fullScanMinPrefix ? 'full' : 'likely';
    networks.push({ interfaceName: entry.name, cidr: `${intToIp(network)}/${prefix}`, mode });

    // Hosts this machine talked to recently are the strongest signal in any network.
    for (const neighbor of options.neighbors ?? []) {
      const value = ipToInt(neighbor);
      if (value !== null && inNetwork(value)) add(neighbor);
    }

    if (mode === 'full') {
      for (let value = firstHost; value <= lastHost; value++) add(intToIp(value));
      continue;
    }

    // Large networks: servers usually sit at the start of the range or near this machine.
    for (let value = firstHost; value < firstHost + likelyLowHosts && inNetwork(value); value++) {
      add(intToIp(value));
    }
    const ownBlock = address - (address % 256);
    for (let value = ownBlock + 1; value <= ownBlock + 254; value++) {
      if (inNetwork(value)) add(intToIp(value));
    }
  }

  return { hosts: [...hosts], networks };
}

export interface DiscoveredServer {
  baseUrl: string;
  host: string;
  port: number;
  /** The server usually found on this port; a hint, not a verified identity. */
  serverHint: string;
  models: string[];
}

export interface DiscoveryOptions {
  hosts: readonly string[];
  ports?: readonly KnownPort[];
  concurrency?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Probes host and port pairs and returns the ones that answer like a model server. */
export async function discoverServers(options: DiscoveryOptions): Promise<DiscoveredServer[]> {
  const ports = options.ports ?? KNOWN_PORTS;
  const concurrency = options.concurrency ?? 512;
  const connectTimeoutMs = options.connectTimeoutMs ?? 400;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3000;
  const targets = options.hosts.flatMap((host) => ports.map((port) => ({ host, ...port })));
  const found: DiscoveredServer[] = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < targets.length && !options.signal?.aborted) {
      const target = targets[next++]!;
      if (await isPortOpen(target.host, target.port, connectTimeoutMs)) {
        const baseUrl = `http://${target.host}:${target.port}/v1`;
        try {
          const timeout = AbortSignal.timeout(requestTimeoutMs);
          const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
          const models = await listModels({ baseUrl }, signal);
          found.push({
            baseUrl,
            host: target.host,
            port: target.port,
            serverHint: target.server,
            models,
          });
        } catch {
          // An open port that is not an OpenAI-compatible server.
        }
      }
      done += 1;
      options.onProgress?.(done, targets.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return found.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl));
}
