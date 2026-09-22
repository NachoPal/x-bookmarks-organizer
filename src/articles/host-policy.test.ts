import { describe, it, expect } from 'vitest';
import {
  ALLOW_PRIVATE_FETCH_ENV,
  allowsPrivateFetch,
  createHostPolicy,
  isPrivateAddress,
  PRIVATE_ADDRESS_REASON,
  UNSUPPORTED_SCHEME_REASON,
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

  it.each(['2606:4700:4700::1111', '2001:db8::1', 'fec0::1'])('allows the public IPv6 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each(['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '::ffff:169.254.169.254', '::127.0.0.1'])(
    'refuses the IPv4-mapped form %s, which would otherwise smuggle loopback past a naive check',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  it('allows an IPv4-mapped PUBLIC address', () => {
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

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

describe('createHostPolicy', () => {
  const lookup = lookupOf({
    'public.example': ['93.184.216.34'],
    'internal.example': ['192.168.1.10'],
    'rebind.example': ['93.184.216.34', '127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
  });

  it('allows a public host', async () => {
    const policy = createHostPolicy({ lookup, env: {} });
    expect(await policy.check('https://public.example/post')).toBeNull();
  });

  it('refuses a host that resolves into private space', async () => {
    const policy = createHostPolicy({ lookup, env: {} });
    expect(await policy.check('http://internal.example/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(await policy.check('http://metadata.example/latest/meta-data/')).toBe(PRIVATE_ADDRESS_REASON);
  });

  it('refuses when ANY record is private, so one public record is not a way in', async () => {
    const policy = createHostPolicy({ lookup, env: {} });
    expect(await policy.check('http://rebind.example/')).toBe(PRIVATE_ADDRESS_REASON);
  });

  it('refuses a literal loopback/private address without any lookup', async () => {
    let queried = false;
    const policy = createHostPolicy({
      env: {},
      lookup: async () => {
        queried = true;
        return [];
      },
    });
    expect(await policy.check('http://127.0.0.1:9911/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(await policy.check('http://[::1]:9911/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(await policy.check('http://[::ffff:127.0.0.1]/admin')).toBe(PRIVATE_ADDRESS_REASON);
    expect(queried).toBe(false);
  });

  it('refuses a non-http(s) scheme even when private addresses are allowed', async () => {
    const policy = createHostPolicy({ allowPrivateAddresses: true });
    expect(await policy.check('file:///etc/passwd')).toBe(UNSUPPORTED_SCHEME_REASON);
    expect(await policy.check('not a url')).toBe(UNSUPPORTED_SCHEME_REASON);
  });

  it('lets an unresolvable name through so the fetch reports its own network error', async () => {
    const policy = createHostPolicy({ lookup, env: {} });
    expect(await policy.check('https://nonexistent.invalid/post')).toBeNull();
  });

  it('is disabled by the opt-in env var, which also skips the lookup entirely', async () => {
    let queried = false;
    const policy = createHostPolicy({
      env: { [ALLOW_PRIVATE_FETCH_ENV]: '1' },
      lookup: async () => {
        queried = true;
        return ['127.0.0.1'];
      },
    });
    expect(await policy.check('http://127.0.0.1:9911/admin')).toBeNull();
    expect(await policy.check('http://internal.example/admin')).toBeNull();
    expect(queried).toBe(false);
  });
});
