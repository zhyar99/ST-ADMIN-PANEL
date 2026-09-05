import { describe, expect, it } from 'vitest';

import { SsrfBlockedError, assertPublicUrl, isBlockedAddress } from './ssrf';

describe('isBlockedAddress', () => {
  it('blocks every private and reserved IPv4 range', () => {
    const blocked = [
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      // The cloud metadata endpoint — the single most valuable SSRF target.
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ];

    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows public IPv4 addresses, including ones adjacent to blocked ranges', () => {
    const allowed = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '11.0.0.1', '9.255.255.255'];

    for (const address of allowed) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 addresses that wrap a private address', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats anything that is not an IP literal as blocked', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects a non-http scheme', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('gopher://example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(assertPublicUrl('http://user:pass@example.com/')).rejects.toThrow(
      /credentials/,
    );
  });

  it('rejects a literal private address without touching DNS', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:5432/')).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /non-public/,
    );
    await expect(assertPublicUrl('http://[::1]:3000/')).rejects.toThrow(/non-public/);
  });

  it('rejects a hostname that resolves to loopback', async () => {
    // localhost resolves to 127.0.0.1 and/or ::1 on every supported platform.
    await expect(assertPublicUrl('http://localhost:3000/master.m3u8')).rejects.toThrow(
      /non-public/,
    );
  });

  it('rejects a hostname that does not resolve', async () => {
    await expect(
      assertPublicUrl('https://this-host-should-not-exist.invalid/stream.m3u8'),
    ).rejects.toThrow(/resolved/);
  });

  it('never puts the URL into the error message', async () => {
    const secret = 'http://10.0.0.9/secret-token-abc123/master.m3u8';

    await expect(assertPublicUrl(secret)).rejects.toSatisfy(
      (error) => !(error as Error).message.includes('secret-token-abc123'),
    );
  });
});
