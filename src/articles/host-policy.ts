/**
 * Outbound host policy for the article fetcher (security review finding 1).
 *
 * Every link the app fetches comes from a bookmarked post, i.e. from content an
 * attacker chooses and the owner merely saves. Without a policy that fetch is
 * an unrestricted GET issued from inside the owner's network on every sync, so
 * a bookmarked link can point the server at loopback services, LAN admin
 * consoles or a cloud metadata endpoint and have the response cached, fed to
 * the categorization/summary prompts and displayed.
 *
 * The policy refuses any URL whose destination resolves to a non-public
 * address. It is applied on EVERY hop - the requested URL, each HTTP redirect
 * target and each HTML interstitial target - which is why
 * {@link HttpArticleFetcher} walks redirects itself (`redirect: 'manual'`)
 * instead of letting `fetch` follow them invisibly.
 *
 * {@link ALLOW_PRIVATE_FETCH_ENV} is the single, explicit opt-out for an owner
 * who genuinely wants to index an intranet. It defaults to OFF.
 */
import dns from 'node:dns';
import net from 'node:net';

/** The one opt-in that disables the policy. Anything falsy leaves it ON. */
export const ALLOW_PRIVATE_FETCH_ENV = 'XBOOKMARKS_ALLOW_PRIVATE_FETCH';

/** Shown (and cached) as the failure reason for a refused link. */
export const PRIVATE_ADDRESS_REASON =
  `This link points at a private or local network address, which is not fetched. ` +
  `Set ${ALLOW_PRIVATE_FETCH_ENV}=1 to allow it.`;

/** A redirect target that is not http(s) - `data:`, `file:`, `javascript:`. */
export const UNSUPPORTED_SCHEME_REASON = 'This link does not point to a web page.';

/** Resolves a hostname to every address it maps to. Injectable for tests. */
export type AddressLookup = (hostname: string) => Promise<string[]>;

export interface HostPolicy {
  /** `null` when the URL may be fetched, else the owner-facing refusal reason. */
  check(url: string): Promise<string | null>;
}

export interface HostPolicyOptions {
  /** Force the policy off (the env var's effect), for tests and the opt-in. */
  allowPrivateAddresses?: boolean;
  /** Stubbed in tests so no DNS query ever leaves the machine. */
  lookup?: AddressLookup;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function parseIPv4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * Expand any valid IPv6 literal (compressed, zone-suffixed, or with a trailing
 * dotted-quad) into its eight 16-bit groups, so the range tests below can be
 * plain numeric comparisons rather than string matching.
 */
function expandIPv6(ip: string): number[] | null {
  let text = ip.split('%')[0] ?? '';
  let embeddedV4: number[] | null = null;

  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const quad = parseIPv4(text.slice(lastColon + 1));
    if (!quad) return null;
    embeddedV4 = [(quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!];
    // Keep the separating colon: cutting it would destroy a leading `::`.
    text = text.slice(0, lastColon + 1);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] =>
    part
      .split(':')
      .filter((chunk) => chunk !== '')
      .map((chunk) => Number.parseInt(chunk, 16));

  const head = groupsOf(halves[0] ?? '');
  const rest = [...groupsOf(halves[1] ?? ''), ...(embeddedV4 ?? [])];
  const missing = 8 - head.length - rest.length;
  const groups =
    halves.length === 2
      ? missing < 0
        ? null
        : [...head, ...Array<number>(missing).fill(0), ...rest]
      : missing === 0
        ? [...head, ...rest]
        : null;

  if (!groups) return null;
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateIPv4(quad: number[]): boolean {
  const [a, b] = quad as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 - "this network"
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) // link-local, incl. cloud metadata
  );
}

/**
 * True for any address the fetcher must refuse: loopback, private, link-local,
 * unique-local and carrier-grade-NAT space, in IPv4, IPv6 and the
 * IPv4-mapped/compatible IPv6 forms of the same (`::ffff:127.0.0.1`), which are
 * otherwise an easy way to smuggle a loopback address past a naive check.
 */
export function isPrivateAddress(ip: string): boolean {
  const quad = parseIPv4(ip);
  if (quad) return isPrivateIPv4(quad);
  if (!net.isIPv6(ip)) return false;
  const groups = expandIPv6(ip);
  if (!groups) return false;

  // `::ffff:a.b.c.d` (mapped) and `::a.b.c.d` (compatible, which also covers
  // `::1` and `::`) carry an IPv4 address in the low 32 bits.
  const topIsZero = groups.slice(0, 5).every((g) => g === 0);
  if (topIsZero && (groups[5] === 0 || groups[5] === 0xffff)) {
    const high = groups[6]!;
    const low = groups[7]!;
    return isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  const first = groups[0]!;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Whether the owner explicitly opted into fetching private addresses. */
export function allowsPrivateFetch(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY.has((env[ALLOW_PRIVATE_FETCH_ENV] ?? '').trim().toLowerCase());
}

const defaultLookup: AddressLookup = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/** The policy the fetcher applies before every hop. */
export function createHostPolicy(options: HostPolicyOptions = {}): HostPolicy {
  const allowPrivate = options.allowPrivateAddresses ?? allowsPrivateFetch(options.env ?? process.env);
  const lookup = options.lookup ?? defaultLookup;

  return {
    async check(url: string): Promise<string | null> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return UNSUPPORTED_SCHEME_REASON;
      }
      // Enforced even when private addresses are allowed: a redirect into
      // `file:`/`data:` space is never a page this app should read.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return UNSUPPORTED_SCHEME_REASON;
      if (allowPrivate) return null;

      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host)) return isPrivateAddress(host) ? PRIVATE_ADDRESS_REASON : null;

      let addresses: string[];
      try {
        addresses = await lookup(host);
      } catch {
        // An unresolvable name is not a policy violation - let the fetch fail
        // on its own and report its usual network-error reason.
        return null;
      }
      // ANY disallowed record refuses the whole name: a hostname with one
      // public and one loopback record must not be a way in.
      return addresses.some(isPrivateAddress) ? PRIVATE_ADDRESS_REASON : null;
    },
  };
}
