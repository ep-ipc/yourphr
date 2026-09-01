import { describe, expect, it } from 'vitest';
import { serverBaseUrls, serverDiscovery } from '../discovery.js';
import type { NetworkInterfaceInfo } from 'node:os';

const cfg = { listenPort: 8080, hostPort: '', hostIp: '', https: false };

describe('serverBaseUrls', () => {
  it('includes hostname, an operator override, and non-loopback interface addresses', () => {
    const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      eth0: [
        { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: 'fe80::1', netmask: '', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 1 },
      ],
    };
    const urls = serverBaseUrls({ ...cfg, hostIp: '10.0.0.5', hostPort: '9099' }, ifaces);
    expect(urls.some((u) => u.endsWith(':9099'))).toBe(true);
    expect(urls).toContain('http://10.0.0.5:9099');
    expect(urls).toContain('http://192.168.1.20:9099');
    expect(urls.some((u) => u.includes('127.0.0.1'))).toBe(false);
    expect(urls.some((u) => u.includes('fe80'))).toBe(false);
  });

  it('uses https when asked, and discovery still points at the FHIR sync path the QR historically carried', () => {
    const found = serverDiscovery({ ...cfg, https: true }, {
      eth0: [{ address: '10.1.2.3', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
    });
    expect(found.sync_endpoint).toBe('api/secure/resource/fhir');
    expect(found.server_base_urls.every((u) => u.startsWith('https://'))).toBe(true);
  });
});
