import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Engine } from '../../../framework/Engine.js';
import { ConfigurationManager } from '../../../framework/ConfigurationManager.js';
import { PolicyManager } from '../../../framework/managers/PolicyManager.js';
import { FakeConfigProvider } from '../../../framework/providers/__tests__/FakeConfigProvider.js';
import { OutboundHttp } from '../../../http/index.js';
import { DEFAULT_PUBLIC_RELAY, RelayProvider } from '../RelayProvider.js';

/** A scripted relay: /pending answers whatever the spec queued, in order. */
let answers: { status: number; body?: string }[];
let seen: { path: string; token: string | undefined }[];
let server: Server;
let base: string;

async function boot(custom: Record<string, string> = {}, env: Record<string, string> = {}): Promise<RelayProvider> {
  // The secret is env-owned (yourphr.config.env-keys), so it arrives as YOURPHR_RELAY_SECRET —
  // custom config cannot set it, by design.
  if (custom['yourphr.relay.secret'] !== undefined) {
    env['YOURPHR_RELAY_SECRET'] = custom['yourphr.relay.secret'];
    delete custom['yourphr.relay.secret'];
  }
  const engine = new Engine();
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(custom), { env })).register('policy', new PolicyManager(engine));
  await engine.initialize();
  // allowInternal: the fake relay is a loopback server, exactly the escape hatch's purpose.
  return new RelayProvider(engine, new OutboundHttp({ allowInternal: true }), { sleep: async () => undefined });
}

beforeEach(async () => {
  answers = [];
  seen = [];
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', token: req.headers['x-yourphr-token'] as string | undefined });
    const next = answers.shift() ?? { status: 404 };
    res.writeHead(next.status, { 'Content-Type': 'application/json' });
    res.end(next.body ?? '{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(() => server.close());

describe('RelayProvider — resolution', () => {
  it('nothing set: the project relay, honestly labeled default; not ready without a secret', async () => {
    const relay = await boot();
    expect(relay.resolved()).toMatchObject({
      callback_url: `${DEFAULT_PUBLIC_RELAY}/callback`,
      configured: false,
      ready: false,
      public_url: { value: DEFAULT_PUBLIC_RELAY, source: 'default' },
      poll_url: { value: DEFAULT_PUBLIC_RELAY, source: 'default' },
      secret: { value: '', source: 'unset' },
    });
  });

  it('a poll URL alone is inherited as the public one; the secret makes it ready and is never echoed', async () => {
    const relay = await boot({ 'yourphr.relay.url': 'https://relay.example.org/', 'yourphr.relay.secret': 's3cret' });
    const resolved = relay.resolved();
    expect(resolved).toMatchObject({
      callback_url: 'https://relay.example.org/callback',
      configured: true,
      ready: true,
      public_url: { value: 'https://relay.example.org/', source: 'inherited' },
      poll_url: { value: 'https://relay.example.org/', source: 'configured', config_key: 'yourphr.relay.url' },
    });
    expect(JSON.stringify(resolved)).not.toContain('s3cret');
  });

  it('both set: each labeled configured, callback from the public one', async () => {
    const relay = await boot({ 'yourphr.relay.public-url': 'https://relay.example.org', 'yourphr.relay.url': 'https://poll.example.org' });
    expect(relay.resolved()).toMatchObject({
      callback_url: 'https://relay.example.org/callback',
      public_url: { source: 'configured' },
      poll_url: { value: 'https://poll.example.org', source: 'configured' },
    });
  });
});

describe('RelayProvider — fetchCode (the product\'s #406 contract)', () => {
  it('refuses without a secret, before any network: relay_not_configured', async () => {
    const relay = await boot({ 'yourphr.relay.url': base });
    await expect(relay.fetchCode('st')).rejects.toMatchObject({ status: 501, extra: { error_code: 'relay_not_configured' } });
    expect(seen).toHaveLength(0);
  });

  it('polls with the shared secret until the code arrives, and brings it home', async () => {
    answers = [{ status: 404 }, { status: 404 }, { status: 200, body: '{"code":"auth-code-1"}' }];
    const relay = await boot({ 'yourphr.relay.url': base, 'yourphr.relay.secret': 's3cret' });
    expect(await relay.fetchCode('st-1')).toBe('auth-code-1');
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ path: '/pending?state=st-1', token: 's3cret' });
  });

  it('a rejected secret is terminal, not retried: relay_unauthorized', async () => {
    answers = [{ status: 401 }];
    const relay = await boot({ 'yourphr.relay.url': base, 'yourphr.relay.secret': 'wrong' });
    await expect(relay.fetchCode('st')).rejects.toMatchObject({ status: 502, extra: { error_code: 'relay_unauthorized' } });
    expect(seen).toHaveLength(1);
  });

  it('an unexpected answer is terminal: relay_poll_failed', async () => {
    answers = [{ status: 500 }];
    const relay = await boot({ 'yourphr.relay.url': base, 'yourphr.relay.secret': 's' });
    await expect(relay.fetchCode('st')).rejects.toMatchObject({ status: 502, extra: { error_code: 'relay_poll_failed' } });
  });

  it('a code that never arrives times out retryably: relay_poll_timeout', async () => {
    const relay = await boot({ 'yourphr.relay.url': base, 'yourphr.relay.secret': 's' });
    // pollSeconds 0: the deadline is already past after the first 404.
    await expect(relay.fetchCode('st', 0)).rejects.toMatchObject({ status: 504, extra: { error_code: 'relay_poll_timeout' } });
  });
});
