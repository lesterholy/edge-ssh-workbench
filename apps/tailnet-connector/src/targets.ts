import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

const TAILSCALE_IPV4 = ipaddr.parseCIDR("100.64.0.0/10");
const TAILSCALE_IPV6 = ipaddr.parseCIDR("fd7a:115c:a1e0::/48");
const DNS_NAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface VerifiedTailnetTarget {
  host: string;
  addresses: readonly { address: string; family: 4 | 6 }[];
}

export type LookupAll = (host: string) => Promise<readonly { address: string; family: number }[]>;

export async function resolveTailnetTarget(
  host: string,
  port: number,
  allowedPorts: ReadonlySet<number>,
  allowedSuffix: string,
  lookupAll: LookupAll = defaultLookup,
): Promise<VerifiedTailnetTarget> {
  if (!allowedPorts.has(port)) throw new Error("Target port is not allowed");
  if (host !== host.trim() || host !== host.toLowerCase()) throw new Error("Target host must be normalized lowercase ASCII");

  if (ipaddr.isValid(host)) {
    throw new Error("Literal target IPs are disabled; use a full MagicDNS hostname");
  }

  if (!DNS_NAME_PATTERN.test(host) || !host.endsWith(`.${allowedSuffix}`)) {
    throw new Error("Target hostname is outside the allowed MagicDNS suffix");
  }
  const resolved = await lookupAll(host);
  if (resolved.length < 1 || resolved.length > 16) throw new Error("MagicDNS returned an invalid address set");
  const addresses = resolved.map((entry) => {
    if (entry.family !== 4 && entry.family !== 6) throw new Error("MagicDNS returned an unsupported address family");
    const parsed = ipaddr.parse(entry.address);
    if (!isTailnetAddress(parsed)) throw new Error("MagicDNS returned a non-Tailscale address");
    return { address: parsed.toString(), family: entry.family } as const;
  });
  const unique = [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  return { host, addresses: unique };
}

export function isTailnetAddress(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() === "ipv4") return address.match(TAILSCALE_IPV4);
  return address.match(TAILSCALE_IPV6);
}

async function defaultLookup(host: string): Promise<readonly { address: string; family: number }[]> {
  return dns.lookup(host, { all: true, verbatim: true });
}
