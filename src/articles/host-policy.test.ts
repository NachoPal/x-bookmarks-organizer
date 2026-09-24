import type { LookupAddress, LookupOptions } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
  ALLOW_PRIVATE_FETCH_ENV,
  allowsPrivateFetch,
  createHostPolicy,
  isPrivateAddress,
  PRIVATE_ADDRESS_ERROR_CODE,
  PRIVATE_ADDRESS_REASON,
  UNSUPPORTED_SCHEME_REASON,
  type HostPolicy,
} from './host-policy';

/** Never hits DNS: every hostname resolves to whatever the test says. */
const lookupOf = (map: Record<string, string[]>) => async (hostname: string) => {
  const found = map[hostname];
  if (!found) throw new Error(`ENOTFOUND ${hostname}`);
  return found;
};

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.169.254',
  ])('refuses the IPv4 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.255.255', '1.1.1.1'])(
    'allows the public IPv4 address %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it.each([
    '::1',
    '0:0:0:0:0:0:0:1',
    '::',
    'fe80::1',
    'fe80::1%en0',
    'febf::abcd',
    'fc00::1',
    'fd12:3456::1',
  ])('refuses the IPv6 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888'])(
    'allows the public IPv6 address %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it.each(['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '::ffff:169.254.169.254', '::127.0.0.1'])(
    'refuses the IPv4-mapped form %s, which would otherwise smuggle loopback past a naive check',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  it('allows an IPv4-mapped PUBLIC address', () => {
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  // Security review 2, finding 21: the special-purpose IPv4 blocks no real
  // article is served from, and every IPv6 form that carries an IPv4 address.
  it.each([
    '192.0.0.1', // IETF protocol assignments
    '192.0.2.1', // TEST-NET-1
    '192.88.99.1', // 6to4 relay anycast
    '198.18.0.1', // benchmarking
    '198.19.255.255',
    '198.51.100.7', // TEST-NET-2
    '203.0.113.9', // TEST-NET-3
    '224.0.0.251', // multicast
    '239.255.255.250',
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
  ])('refuses the special-purpose IPv4 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['192.0.1.1', '192.88.98.1', '198.17.0.1', '198.20.0.1', '203.0.114.1', '223.255.255.255'])(
    'still allows the public IPv4 neighbour %s of a special-purpose block',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it.each([
    ['::ffff:0:127.0.0.1', 'SIIT-translated loopback'],
    ['::ffff:0:7f00:1', 'SIIT-translated loopback, hex'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::10.0.0.1', 'NAT64 LAN'],
    ['64:ff9b::a00:1', 'NAT64 LAN, hex'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 cloud metadata'],
    ['2002:7f00:1::1', '6to4 loopback'],
    ['2002:c0a8:101::1', '6to4 LAN'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['100::1', 'discard-only'],
    ['fec0::1', 'deprecated site-local'],
    ['ff02::1', 'multicast'],
  ])('refuses %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['64:ff9b::8.8.8.8', '64:ff9b::5db8:d822', '2002:5db8:d822::1', '::ffff:0:8.8.8.8'])(
    'allows the translated form %s of a PUBLIC IPv4 address, which is how an IPv6-only network reaches one',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('is not confused by a non-address string', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('allowsPrivateFetch', () => {
  it('is off by default', () => {
    expect(allowsPrivateFetch({})).toBe(false);
    expect(allowsPrivateFetch({ [ALLOW_PRIVATE_FETCH_ENV]: '' })).toBe(false);
    expect(allowsPrivateFetch({ [ALLOW_PRIVATE_FETCH_ENV]: '0' })).toBe(false);
    expect(allowsPrivateFetch({ [ALLOW_PRIVATE_FETCH_ENV]: 'false' })).toBe(false);
  });

  it('is on for the documented opt-in values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(allowsPrivateFetch({ [ALLOW_PRIVATE_FETCH_ENV]: value })).toBe(true);
    }
  });
});

/** Run the policy's connect-time lookup the way `net.connect` does. */
function connectLookup(
  policy: HostPolicy,
  hostname: string,
  options: LookupOptions = { all: true },
): Promise<LookupAddress[] | { address: string; family: number | undefined }> {
  return new Promise((resolve, reject) => {
    policy.lookup(hostname, options, (err, address, family) => {
      if (err) reject(err);
      else resolve(typeof address === 'string' ? { address, family } : address);
    });
  });
}

describe('createHostPolicy: check (before the request)', () => {
  it('refuses a literal loopback/private address without any lookup', () => {
    let queried = false;
    const policy = createHostPolicy({
      env: {},
      lookup: async () => {
        queried = true;
        return [];
      },
    });
    expect(policy.check('http://127.0.0.1:9911/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(policy.check('http://[::1]:9911/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(policy.check('http://[::ffff:127.0.0.1]/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(policy.check('http://[64:ff9b::7f00:1]:9921/')).toBe(PRIVATE_ADDRESS_REASON);
    expect(policy.check('http://224.0.0.251/')).toBe(PRIVATE_ADDRESS_REASON);
    expect(queried).toBe(false);
  });

  it('allows a public literal address', () => {
    const policy = createHostPolicy({ env: {} });
    expect(policy.check('http://93.184.216.34/post')).toBeNull();
    expect(policy.check('http://[2606:4700:4700::1111]/post')).toBeNull();
  });

  it('never resolves a hostname itself - that is the connect-time half, so there is no second answer to race', () => {
    let queried = 0;
    const policy = createHostPolicy({
      env: {},
      lookup: async () => {
        queried++;
        return ['127.0.0.1'];
      },
    });
    expect(policy.check('http://rebind.attacker.test/admin')).toBeNull();
    expect(queried).toBe(0);
  });

  it('refuses a non-http(s) scheme even when private addresses are allowed', () => {
    const policy = createHostPolicy({ allowPrivateAddresses: true });
    expect(policy.check('file:///etc/passwd')).toBe(UNSUPPORTED_SCHEME_REASON);
    expect(policy.check('not a url')).toBe(UNSUPPORTED_SCHEME_REASON);
  });

  it('is disabled by the opt-in env var', () => {
    const policy = createHostPolicy({ env: { [ALLOW_PRIVATE_FETCH_ENV]: '1' } });
    expect(policy.check('http://127.0.0.1:9911/admin')).toBeNull();
  });
});

describe('createHostPolicy: lookup (when the connection is made)', () => {
  const lookup = lookupOf({
    'public.example': ['93.184.216.34'],
    'dual.example': ['93.184.216.34', '2606:4700:4700::1111'],
    'internal.example': ['192.168.1.10'],
    'mixed.example': ['93.184.216.34', '127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
    'nat64.example': ['64:ff9b::a00:1'],
  });
  const policy = createHostPolicy({ lookup, env: {} });

  it('hands the connection exactly the public records it checked', async () => {
    expect(await connectLookup(policy, 'dual.example')).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(await connectLookup(policy, 'public.example', {})).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('honours the address family the connection asked for', async () => {
    expect(await connectLookup(policy, 'dual.example', { family: 6 })).toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
    await expect(connectLookup(policy, 'public.example', { family: 6 })).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it.each(['internal.example', 'metadata.example', 'nat64.example'])(
    'fails the connection to %s, which resolves into private space',
    async (hostname) => {
      await expect(connectLookup(policy, hostname)).rejects.toMatchObject({ code: PRIVATE_ADDRESS_ERROR_CODE });
    },
  );

  it('refuses when ANY record is private, so one public record is not a way in', async () => {
    await expect(connectLookup(policy, 'mixed.example')).rejects.toMatchObject({ code: PRIVATE_ADDRESS_ERROR_CODE });
  });

  it('fails the connection when the name does not resolve - it never lets an unresolved name through', async () => {
    await expect(connectLookup(policy, 'nonexistent.invalid')).rejects.toThrow(/ENOTFOUND/);
  });

  it('resolves once per connection: a rebinding DNS server gets no second question to answer differently', async () => {
    let queries = 0;
    const rebinding = createHostPolicy({
      env: {},
      lookup: async () => (++queries === 1 ? ['127.0.0.1'] : ['93.184.216.34']),
    });
    await expect(connectLookup(rebinding, 'rebind.attacker.test')).rejects.toMatchObject({
      code: PRIVATE_ADDRESS_ERROR_CODE,
    });
    expect(queries).toBe(1);
  });

  it('passes every record through when the owner opted in', async () => {
    const optedIn = createHostPolicy({ lookup, env: { [ALLOW_PRIVATE_FETCH_ENV]: '1' } });
    expect(await connectLookup(optedIn, 'internal.example')).toEqual([{ address: '192.168.1.10', family: 4 }]);
  });
});
