import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Guard for every outbound request the server makes to an operator-supplied
 * URL. Nothing in a feature should call `fetch(url)` directly — go through
 * {@link safeFetch}, or at minimum {@link assertPublicUrl}.
 *
 * The threat: stream source URLs are typed in by admins, so a hostile or
 * careless one can point the server at 169.254.169.254, at a database on
 * localhost, or at anything else reachable from inside the network but not
 * from the internet. Checking the hostname string is not enough — a public
 * name can resolve to a private address — so the hostname is resolved and
 * every returned address is checked.
 */

export class SsrfBlockedError extends Error {
  constructor(readonly reason: string) {
    // The URL itself is never interpolated into the message: these bubble up
    // into logs, and stream URLs must not be logged.
    super(`Blocked outbound request: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

/** Redirect chains are followed manually so each hop can be re-validated. */
const MAX_REDIRECTS = 5;

const DEFAULT_TIMEOUT_MS = 10_000;

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the 169.254.169.254 metadata endpoint
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);

  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIpv6(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0]!;

  // ::ffff:10.0.0.1 and friends are IPv4 wearing a hat — unwrap and re-check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped) return isBlockedIpv4(mapped[1]!);

  if (normalised === '::1' || normalised === '::') return true;

  const head = normalised.split(':')[0] ?? '';

  // fc00::/7 unique-local: first byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;

  // fe80::/10 link-local: fe80 through febf.
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;

  return false;
}

/** True when an IP literal is in a range a user-supplied URL must not reach. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  // Not an IP literal at all — the caller resolves names before getting here.
  return true;
}

export interface SafeUrl {
  url: URL;
  /** Every address the hostname resolved to. All of them passed the check. */
  addresses: string[];
}

/**
 * Validates a URL and resolves its hostname, rejecting anything that points at
 * a non-public address.
 *
 * Known limitation — DNS rebinding: the name is resolved here, and Node
 * resolves it again when the request is actually made, so a hostile server
 * controlling a very short TTL could return a public address to this check and
 * a private one to the connection. Closing that hole means pinning the socket
 * to a validated IP via a custom agent/`lookup`. Accepted for a manual,
 * admin-triggered health check; revisit before any automated or user-triggered
 * fetching (Section 25).
 */
export async function assertPublicUrl(rawUrl: string): Promise<SafeUrl> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('malformed URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`unsupported protocol ${url.protocol}`);
  }

  // Credentials in the URL are a redirect-laundering trick and never legitimate
  // for a stream source.
  if (url.username || url.password) {
    throw new SsrfBlockedError('URL must not contain credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (!hostname) throw new SsrfBlockedError('URL has no host');

  // An IP literal needs no resolution — check it directly.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new SsrfBlockedError('host is a non-public address');
    return { url, addresses: [hostname] };
  }

  let resolved: LookupAddress[];

  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError('host could not be resolved');
  }

  if (resolved.length === 0) throw new SsrfBlockedError('host resolved to no addresses');

  // Every address must pass: a name that resolves to both a public and a
  // private address is exactly the attack, not a partial success.
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      throw new SsrfBlockedError('host resolves to a non-public address');
    }
  }

  return { url, addresses: resolved.map((entry) => entry.address) };
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Performs an outbound request to an operator-supplied URL with the SSRF guard
 * applied to the initial URL and to every redirect hop.
 *
 * Redirects are followed manually (`redirect: 'manual'`) because the built-in
 * follower would happily chase a 302 into 127.0.0.1 without re-checking.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  let target = rawUrl;

  // The whole chain shares one deadline, so a redirect loop cannot extend it.
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { url } = await assertPublicUrl(target);

    const response = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // Relative redirects are legal and common on CDNs.
    target = new URL(location, url).toString();
  }

  throw new SsrfBlockedError('too many redirects');
}
