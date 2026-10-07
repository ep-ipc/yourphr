import { describe, expect, it } from 'vitest';
import { isBlockedIp } from '../ssrf.js';

describe('the SSRF guard covers the special-purpose ranges it missed (yourphr#817)', () => {
  it('blocks 198.18.0.0/15 (benchmarking) and 192.0.0.0/24 (IETF), not their neighbours', () => {
    for (const ip of ['198.18.0.1', '198.19.255.254', '192.0.0.8']) expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['198.17.255.255', '198.20.0.1', '192.0.2.1', '192.0.1.1']) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('judges the IPv4 inside a NAT64 address — internal blocked, public allowed', () => {
    expect(isBlockedIp('64:ff9b::10.0.0.1')).toBe(true);
    expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254, the metadata endpoint
    expect(isBlockedIp('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedIp('64:ff9b::8.8.8.8')).toBe(false);
    expect(isBlockedIp('64:ff9b:1::1')).toBe(true); // local-use NAT64 prefix
  });

  it('judges the IPv4 inside a 6to4 address', () => {
    expect(isBlockedIp('2002:c0a8:0101::1')).toBe(true); // 192.168.1.1
    expect(isBlockedIp('2002:0a00:0001::')).toBe(true); // 10.0.0.1
    expect(isBlockedIp('2002:0808:0808::1')).toBe(false); // 8.8.8.8
  });

  it('still blocks what it blocked, still allows a public IPv6, and refuses what it cannot parse', () => {
    for (const ip of ['127.0.0.1', '::1', 'fd00:ec2::254', 'fe80::1%eth0', '::ffff:10.0.0.1']) expect(isBlockedIp(ip), ip).toBe(true);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('1:2:3:4:5:6:7:8:9')).toBe(true);
  });
});
