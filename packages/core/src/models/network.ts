import { networkInterfaces } from 'node:os';
import { runCommand } from '../system/run.ts';
import { isPrivateAddress, type InterfaceAddress } from './discovery.ts';

/** IPv4 addresses of this machine's non-loopback interfaces in private ranges. */
export function localInterfaceAddresses(): InterfaceAddress[] {
  const result: InterfaceAddress[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
        result.push({ name, address: entry.address, netmask: entry.netmask });
      }
    }
  }
  return result;
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/g;

/** Extracts unicast private IPv4 addresses from `arp -a` or `ip neigh` output. */
export function parseNeighborTable(output: string): string[] {
  const addresses = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    // Windows `arp -a` headers ("Interface: <own address> --- 0x5", localized) name this machine.
    if (/---\s*0x[0-9a-f]+/i.test(line)) continue;
    const [first] = line.match(IPV4) ?? [];
    if (!first || !isPrivateAddress(first)) continue;
    const lastOctet = Number(first.split('.')[3]);
    if (lastOctet === 0 || lastOctet === 255) continue;
    addresses.add(first);
  }
  return [...addresses];
}

/** Reads the system neighbor table. Best effort: returns an empty list on failure. */
export async function readNeighborAddresses(): Promise<string[]> {
  const command =
    process.platform === 'win32'
      ? { command: 'arp.exe', args: ['-a'] }
      : process.platform === 'darwin'
        ? { command: 'arp', args: ['-an'] }
        : { command: 'ip', args: ['-4', 'neigh'] };
  try {
    const result = await runCommand(command, { timeoutMs: 5000 });
    return result.exitCode === 0 ? parseNeighborTable(result.stdout) : [];
  } catch {
    return [];
  }
}
