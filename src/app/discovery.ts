/**
 * LAN discovery for the companion QR (Go's GetServerBaseURLs).
 *
 * The iPhone tries every URL in order until one answers /account/me. Hostname, an optional
 * operator override, and the machine's non-loopback addresses cover "the phone is on the same
 * Wi-Fi as this instance" without the patient typing an IP.
 */
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export interface DiscoveryConfig {
  listenPort: number;
  /** Docker published port, when the listen port is not the one a phone on the LAN must use. */
  hostPort: string;
  hostIp: string;
  https: boolean;
}

export interface ServerDiscovery {
  server_base_urls: string[];
  sync_endpoint: string;
}

function joinHostPort(host: string, port: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

function isUsable(info: NetworkInterfaceInfo): boolean {
  if (info.internal) return false;
  if (info.family !== 'IPv4' && info.family !== 'IPv6') return false;
  const address = info.address;
  if (address.startsWith('127.') || address === '::1') return false;
  if (address.startsWith('169.254.') || address.toLowerCase().startsWith('fe80:')) return false;
  return true;
}

export function serverBaseUrls(cfg: DiscoveryConfig, ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const port = (cfg.hostPort.trim() || String(cfg.listenPort)).trim();
  const protocol = cfg.https ? 'https' : 'http';
  const add = (host: string, into: string[]): void => {
    if (!host.trim()) return;
    const url = `${protocol}://${joinHostPort(host.trim(), port)}`;
    if (!into.includes(url)) into.push(url);
  };

  const urls: string[] = [];
  try { add(hostname(), urls); } catch { /* hostname is best-effort */ }
  add(cfg.hostIp, urls);
  for (const infos of Object.values(ifaces)) {
    for (const info of infos ?? []) {
      if (isUsable(info)) add(info.address, urls);
    }
  }
  return urls;
}

export function serverDiscovery(cfg: DiscoveryConfig, ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): ServerDiscovery {
  return {
    server_base_urls: serverBaseUrls(cfg, ifaces),
    sync_endpoint: 'api/secure/resource/fhir',
  };
}
