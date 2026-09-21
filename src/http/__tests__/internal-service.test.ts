/**
 * The single-origin capability (yourphr#735). What it must NOT do matters more than what it does:
 * leave the configured origin, follow a redirect elsewhere, or hold an unbounded answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { InternalServiceHttp } from '../internal-service.js';

let server: Server;
let base: string;
let seen: { method: string; url: string; body: string; type: string }[];
let respond: (url: string, res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  respond = (_url, res) => { res.writeHead(200); res.end('ok'); };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), type: String(req.headers['content-type']) });
      respond(req.url ?? '', res);
    });
  });
  base = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('InternalServiceHttp', () => {
  it('POSTs the body to the configured address — an internal one, which the guarded client would refuse', async () => {
    const http = new InternalServiceHttp(`${base}/prefix/`);
    const res = await http.post('/api/convert?patientId=a%20b', Buffer.from('<doc/>'), { 'content-type': 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('ok');
    expect(seen).toEqual([{ method: 'POST', url: '/prefix/api/convert?patientId=a%20b', body: '<doc/>', type: 'text/plain' }]);
  });

  it('GETs from the configured address with the given headers and no body', async () => {
    const res = await new InternalServiceHttp(`${base}/`).get('/pending?state=s1', { 'x-token': 't' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ method: 'GET', url: '/pending?state=s1', body: '', type: 'undefined' }]);
  });

  it('GET refuses a path that resolves to another origin', async () => {
    await expect(new InternalServiceHttp(base).get('//169.254.169.254/latest/meta-data')).rejects.toThrow(/leaves the configured service/);
    expect(seen).toEqual([]);
  });

  it('refuses a path that resolves to another origin', async () => {
    const http = new InternalServiceHttp(base);
    await expect(http.post('//169.254.169.254/latest/meta-data', Buffer.alloc(0))).rejects.toThrow(/leaves the configured service/);
    expect(seen).toEqual([]);
  });

  it('does not follow a redirect — the document is never bounced to a host nobody configured', async () => {
    respond = (_url, res) => { res.writeHead(302, { location: 'http://example.org/steal' }); res.end(); };
    const res = await new InternalServiceHttp(base).post('/x', Buffer.from('phi'));
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it('caps the answer', async () => {
    respond = (_url, res) => { res.writeHead(200); res.end('x'.repeat(2048)); };
    await expect(new InternalServiceHttp(base, { maxBytes: 1024 }).post('/x', Buffer.alloc(0))).rejects.toThrow(/more than 1024 bytes/);
  });

  it('gives up after the timeout', async () => {
    respond = () => { /* never answers */ };
    await expect(new InternalServiceHttp(base, { timeoutMs: 50 }).post('/x', Buffer.alloc(0))).rejects.toThrow(/no answer within/);
  });

  it.each([
    ['not a URL', 'converter:8080'],
    ['another scheme', 'file:///etc/passwd'],
    ['credentials in the address', 'http://user:pw@converter:8080'],
  ])('refuses %s at construction', (_, url) => {
    expect(() => new InternalServiceHttp(url)).toThrow();
  });
});
