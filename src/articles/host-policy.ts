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
 * The policy refuses any destination that is not a public address. It has two
 * halves, and both are applied on EVERY hop - the requested URL, each HTTP
 * redirect target and each HTML interstitial target - which is why
 * {@link HttpArticleFetcher} walks redirects itself (`redirect: 'manual'`)
 * instead of letting `fetch` follow them invisibly:
 *
 * - {@link HostPolicy.check}, before the request: the scheme, and a host that
 *   is a literal address. The OS never resolves a literal, so this is the only
 *   place one can be judged.
 * - {@link HostPolicy.lookup}, AT CONNECT TIME: the resolver the connection
 *   itself uses for a hostname. It refuses the name when any record is not
 *   public, and otherwise hands back exactly the records it checked, so the
 *   socket can only ever reach an address this policy saw (security review 2,
 *   finding 18). A separate check-then-fetch lookup is two resolutions, and a
 *   TTL-0 DNS server can answer them differently - that was the bypass.
 *
 * {@link ALLOW_PRIVATE_FETCH_ENV} is the single, explicit opt-out for an owner
 * who genuinely wants to index an intranet. It defaults to OFF.
 */
import dns from 'node:dns';
import net, { type LookupFunction } from 'node:net';

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

/**
 * The `code` of the error {@link HostPolicy.lookup} fails a connection with
 * when a name resolves into non-public space, so the fetcher can tell the
 * refusal apart from an ordinary network error and report it as one.
 */
export const PRIVATE_ADDRESS_ERROR_CODE = 'EPRIVATEADDRESS';

export interface HostPolicy {
  /**
   * The pre-request half: `null` when the URL may be requested, else the
   * owner-facing refusal reason. Judges the scheme and a literal-address host;
   * a hostname passes here and is judged by {@link lookup} when it connects.
   */
  check(url: string): string | null;
  /**
   * The connect-time half, in the `lookup` shape `net.connect`/`tls.connect`
   * take. It is the ONLY resolution a fetched hostname gets: it fails with
   * {@link PRIVATE_ADDRESS_ERROR_CODE} when any record is not public, fails when
   * the name does not resolve, and otherwise returns exactly what it checked.
   */
  lookup: LookupFunction;
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
  const [a, b, c] = quad as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 - "this network"
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    // Special-purpose space no real article is served from (finding 21).
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  );
}

/** The IPv4 address carried in two 16-bit groups of an IPv6 address. */
function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

const allZero = (groups: number[]): boolean => groups.every((g) => g === 0);

/**
 * True for any address the fetcher must refuse: loopback, private, link-local,
 * unique-local, carrier-grade-NAT and special-purpose space, in IPv4 and IPv6.
 *
 * Every IPv6 form that CARRIES an IPv4 address - mapped (`::ffff:a.b.c.d`),
 * compatible (`::a.b.c.d`), SIIT-translated (`::ffff:0:a.b.c.d`), NAT64
 * (`64:ff9b::a.b.c.d`) and 6to4 (`2002:AABB:CCDD::`) - is judged by the IPv4
 * address inside it, since on a network that translates it that IS where the
 * connection lands; otherwise each is an easy way to smuggle a loopback or LAN
 * address past a naive check (finding 21).
 */
export function isPrivateAddress(ip: string): boolean {
  const quad = parseIPv4(ip);
  if (quad) return isPrivateIPv4(quad);
  if (!net.isIPv6(ip)) return false;
  const g = expandIPv6(ip);
  if (!g) return false;

  // `::a.b.c.d` (compatible, which also covers `::1` and `::`), `::ffff:a.b.c.d`
  // (mapped) and `::ffff:0:a.b.c.d` (SIIT) carry an IPv4 address in the low 32
  // bits, as does NAT64's well-known prefix `64:ff9b::/96`.
  const mappedOrCompatible = allZero(g.slice(0, 5)) && (g[5] === 0 || g[5] === 0xffff);
  const siit = allZero(g.slice(0, 4)) && g[4] === 0xffff && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && allZero(g.slice(2, 6));
  if (mappedOrCompatible || siit || nat64) return isPrivateIPv4(embeddedIPv4(g[6]!, g[7]!));
  // 6to4 `2002::/16` carries its IPv4 address in the second and third groups.
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(g[1]!, g[2]!));

  const [first, second] = g as [number, number];
  if (first === 0x64 && second === 0xff9b) return true; // 64:ff9b:1::/48 local-use NAT64
  if (first === 0x2001 && second === 0) return true; // 2001::/32 Teredo (an obfuscated IPv4 tunnel)
  if (first === 0x2001 && second === 0xdb8) return true; // 2001:db8::/32 documentation
  if (first === 0x3fff && second <= 0x0fff) return true; // 3fff::/20 documentation
  if (first === 0x100 && allZero(g.slice(1, 4))) return true; // 100::/64 discard-only
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
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

/** What {@link HostPolicy.lookup} fails a connection with for a refused name. */
export class PrivateAddressError extends Error {
  readonly code = PRIVATE_ADDRESS_ERROR_CODE;

  constructor(hostname: string) {
    super(`${hostname} resolves to a private or local network address`);
    this.name = 'PrivateAddressError';
  }
}

/** The address family a `net` lookup asked for, or 0 for "either". */
function requestedFamily(family: number | string | undefined): 0 | 4 | 6 {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

/**
 * Build the connect-time lookup: resolve once, judge every record, and hand
 * the connection only the records that were judged. A resolver failure is
 * passed straight to the connection, which then fails - there is no second
 * resolution for a flaky or hostile DNS server to answer differently.
 */
function connectTimeLookup(resolve: AddressLookup, allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    const settle = (addresses: string[]): void => {
      // ANY disallowed record refuses the whole name: a hostname with one
      // public and one loopback record must not be a way in.
      if (!allowPrivate && addresses.some(isPrivateAddress)) {
        callback(new PrivateAddressError(hostname), '');
        return;
      }
      const family = requestedFamily(options.family);
      const records = addresses
        .map((address) => ({ address, family: net.isIP(address) }))
        .filter((record) => record.family !== 0 && (family === 0 || record.family === family));
      const first = records[0];
      if (!first) {
        const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = 'ENOTFOUND';
        callback(err, '');
        return;
      }
      if (options.all) callback(null, records);
      else callback(null, first.address, first.family);
    };
    resolve(hostname).then(settle, (err: unknown) => {
      callback(err instanceof Error ? err : new Error(String(err)), '');
    });
  };
}

/** The policy the fetcher applies on every hop. */
export function createHostPolicy(options: HostPolicyOptions = {}): HostPolicy {
  const allowPrivate = options.allowPrivateAddresses ?? allowsPrivateFetch(options.env ?? process.env);
  const lookup = connectTimeLookup(options.lookup ?? defaultLookup, allowPrivate);

  return {
    lookup,
    check(url: string): string | null {
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

      // A literal is never resolved, so it never reaches `lookup`: judge it
      // here. A hostname is judged by `lookup`, on the connection itself.
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host)) return isPrivateAddress(host) ? PRIVATE_ADDRESS_REASON : null;
      return null;
    },
  };
}
