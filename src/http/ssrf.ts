/**
 * SSRF guarding for outbound provider requests — the piece of the transition with no library
 * behind it (yourphr#539).
 *
 * A self-hosted PHR fetches URLs that a provider, or an attacker who can influence a provider's
 * response, supplies — from inside somebody's home network. The Go backend hardened this over
 * several issues; this is the TypeScript equivalent, written to earn the same protection rather
 * than to look like it.
 *
 * THE BOUNDARY IS AT CONNECT TIME, AFTER DNS RESOLUTION. A URL check cannot be the boundary, for
 * two reasons no amount of string inspection fixes:
 *
 *   1. Numeric host forms. A parser that understands only dotted-quad and IPv6 literals returns
 *      "not an IP" for every other form and skips the check, while the system resolver understands
 *      them perfectly well (yourphr#484):
 *
 *        2130706433           -> 127.0.0.1
 *        0x7f.0.0.1           -> 127.0.0.1
 *        127.1                -> 127.0.0.1
 *        2852039166           -> 169.254.169.254   (cloud metadata)
 *        0251.0376.0251.0376  -> 169.254.169.254
 *
 *   2. DNS rebinding. A name can resolve to a public address when validated and to an internal one
 *      moments later when connected. Only a check at connection time sees what was actually reached.
 *
 * So `validateUrl` below is a courtesy that produces a friendly error early. `guardedLookup` is the
 * control, and it runs for every connection — including each redirect hop, which a base-URL check
 * never sees at all.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

/** Message every refusal carries, so callers and tests can recognise the guard's own decision. */
export const REFUSAL = 'refusing to connect to an internal address';

/** No host exempted — the normal state, and what every default argument below means. */
const EMPTY_HOSTS: ReadonlySet<string> = new Set<string>();

/**
 * Hosts an OPERATOR named in configuration, exempted from the internal-address refusal.
 *
 * This exists for one shape of dependency the guard would otherwise make impossible: a service the
 * operator runs and addresses by name on their own network — the language-model endpoint that
 * yourphr#594's chat calls, say, at `http://ollama.lan:11434`. Refusing that is not security, it is
 * the guard being wrong about who chose the address.
 *
 * Three properties keep this from becoming the hole `allowInternal` would be:
 *
 *   - It is a SET OF NAMED HOSTS, not a switch. Exempting one host says nothing about
 *     169.254.169.254, and a provider whose configured URI is attacker-influenced still cannot
 *     reach anything but the host the operator wrote down.
 *   - It is supplied ONCE, when the capability is constructed from configuration, and stripped from
 *     the per-request options (see `RequestOptions` in ./index.ts). A call site cannot widen it.
 *   - It is matched on the HOSTNAME the URL carries, before resolution, so it exempts the name the
 *     operator declared rather than whatever that name currently resolves to. A redirect to a
 *     different internal host is still refused.
 */
export function isAllowedHost(host: string, allowHosts: ReadonlySet<string>): boolean {
  if (allowHosts.size === 0) return false;
  return allowHosts.has(host.toLowerCase().replace(/\.$/, ''));
}

/**
 * Hostnames that never leave the machine, refused by name before any resolution.
 *
 * Mirrors the Go guard: localhost and the suffixes that mDNS, container runtimes and cloud
 * providers use for names that are internal by definition.
 */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') {
    return true;
  }
  return ['.localhost', '.local', '.internal'].some((suffix) => h.endsWith(suffix));
}

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((p) => Number(p));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/**
 * Addresses that point inward: loopback, RFC1918 private, carrier-grade NAT, link-local (which
 * covers the 169.254.0.0/16 metadata range), the unspecified address, and IPv6 unique-local.
 *
 * Node has no equivalent of Go's ip.IsPrivate()/IsLoopback(), so the ranges are spelled out. The
 * IPv4-mapped IPv6 form (::ffff:127.0.0.1) is unwrapped first — it is a documented bypass when a
 * guard checks only the textual form.
 */
export function isBlockedIp(address: string): boolean {
  let ip = address.trim().toLowerCase();

  // Strip a zone index (fe80::1%eth0) before parsing.
  const zone = ip.indexOf('%');
  if (zone !== -1) {
    ip = ip.slice(0, zone);
  }

  // IPv4-mapped and IPv4-compatible IPv6 — judge the embedded IPv4, not the wrapper.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1]) {
    ip = mapped[1];
  }

  const v4 = ipv4ToParts(ip);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8, includes the unspecified address
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier-grade NAT
    if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (isIP(ip) !== 6) {
    // Not a form this function can judge. Refuse rather than allow: an address we cannot parse is
    // not an address we can vouch for, and the caller's alternative is connecting blind.
    return true;
  }

  if (ip === '::' || ip === '::1') return true; // unspecified, loopback
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique-local, includes fd00:ec2::254 metadata
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (ip.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * A DNS lookup that refuses to hand back an internal address.
 *
 * Passed as the `lookup` option to an http.Agent, so Node calls it for every connection the agent
 * makes. Resolution happens first and every returned address is judged — `all: true` matters,
 * because a name with several A records must not pass on the strength of one public answer while
 * another points inward.
 */
export function guardedLookup(allowInternal = false, allowHosts: ReadonlySet<string> = EMPTY_HOSTS): typeof dnsLookup {
  const guarded = (hostname: string, options: unknown, callback: unknown): void => {
    // Node calls lookup(hostname, options, cb) or lookup(hostname, cb).
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | LookupAddress[],
      family?: number
    ) => void;
    const opts = (typeof options === 'function' ? {} : options ?? {}) as Record<string, unknown>;

    const exempt = allowInternal || isAllowedHost(hostname, allowHosts);

    if (!exempt && isBlockedHostname(hostname)) {
      cb(Object.assign(new Error(`${REFUSAL}: ${hostname}`), { code: 'ESSRFBLOCKED' }));
      return;
    }

    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) {
        cb(err);
        return;
      }
      const resolved = addresses as LookupAddress[];
      if (!exempt) {
        const blocked = resolved.find((a) => isBlockedIp(a.address));
        if (blocked) {
          cb(
            Object.assign(new Error(`${REFUSAL}: ${hostname} resolved to ${blocked.address}`), {
              code: 'ESSRFBLOCKED',
            })
          );
          return;
        }
      }
      if (opts['all'] === true) {
        cb(null, resolved);
      } else {
        const first = resolved[0];
        if (!first) {
          cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }));
          return;
        }
        cb(null, first.address, first.family);
      }
    });
  };
  return guarded as unknown as typeof dnsLookup;
}

export interface GuardedAgents {
  http: HttpAgent;
  https: HttpsAgent;
}

/** Agents whose every connection goes through the guarded lookup. */
export function guardedAgents(allowInternal = false, allowHosts: ReadonlySet<string> = EMPTY_HOSTS): GuardedAgents {
  const options = { lookup: guardedLookup(allowInternal, allowHosts), keepAlive: false };
  return { http: new HttpAgent(options), https: new HttpsAgent(options) };
}

/**
 * An early, friendly check on a base URL. NOT the boundary — see the header. It exists so an
 * operator typing a bad address gets a clear message instead of a connection error, and it
 * deliberately refuses an unparseable URL rather than passing it along.
 */
export function validateUrl(raw: string, allowInternal = false, allowHosts: ReadonlySet<string> = EMPTY_HOSTS): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `unsupported scheme ${url.protocol}` };
  }
  if (allowInternal) {
    return { ok: true, url };
  }
  // URL puts IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isAllowedHost(host, allowHosts)) {
    return { ok: true, url };
  }
  if (isBlockedHostname(host)) {
    return { ok: false, reason: `${REFUSAL}: ${host}` };
  }
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    return { ok: false, reason: `${REFUSAL}: ${host}` };
  }
  return { ok: true, url };
}
