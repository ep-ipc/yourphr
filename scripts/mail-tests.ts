/**
 * Outbound mail harness (yourphr#536). Real SMTP, loopback only: an smtp-server on 127.0.0.1 and a
 * certificate authority made for the run, so what is proven is the wire, not a mock of it.
 *
 * The properties that matter:
 *   - A relay that does not offer STARTTLS gets NOTHING — not the message, not the password.
 *   - A certificate that cannot be verified is refused, and again the password never leaves.
 *   - With a trusted certificate the message arrives, sender and recipient as configured, and
 *     authentication happens only on the encrypted connection.
 *   - Every failure is a sentence naming the fix, and no failure message carries the password.
 *
 *   npm run mail
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { SmtpRelay, SmtpError, type SmtpRelayConfig } from '../src/http/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const USER = 'phr-relay';
const PASS = 'Synthetic-Relay-Password-7731';

/** A throwaway CA and a server certificate for localhost / 127.0.0.1, signed by it. */
function makeCertificates(dir: string): { ca: string; key: string; cert: string } {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=YourPHR Test CA', '-keyout', 'ca.key', '-out', 'ca.pem');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr');
  writeFileSync(join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'san.ext', '-out', 'server.pem');
  return { ca: readFileSync(join(dir, 'ca.pem'), 'utf8'), key: readFileSync(join(dir, 'server.key'), 'utf8'), cert: readFileSync(join(dir, 'server.pem'), 'utf8') };
}

interface Received { from: string; to: string[]; body: string; authedSecure: boolean[] }

/** An SMTP server that records what it received and whether AUTH arrived over TLS. */
async function relayServer(options: SMTPServerOptions & { rejectRcpt?: boolean }): Promise<{ port: number; got: Received; authAttempts: number; close: () => Promise<void> }> {
  const got: Received = { from: '', to: [], body: '', authedSecure: [] };
  const state = { authAttempts: 0 };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: [],
    authOptional: false,
    ...options,
    onAuth(auth, session, cb) {
      state.authAttempts++;
      got.authedSecure.push(Boolean(session.secure));
      if (auth.username === USER && auth.password === PASS) cb(null, { user: USER });
      else cb(new Error('Invalid username or password'));
    },
    onRcptTo(address, _session, cb) {
      if (options.rejectRcpt) {
        const err = new Error('No such user here') as Error & { responseCode: number };
        err.responseCode = 550;
        cb(err);
        return;
      }
      cb();
    },
    onData(stream, session, cb) {
      let body = '';
      stream.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      stream.on('end', () => {
        got.from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
        got.to = session.envelope.rcptTo.map((r) => r.address);
        got.body = body;
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    got,
    get authAttempts() { return state.authAttempts; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function attempt(config: SmtpRelayConfig): Promise<SmtpError | undefined> {
  try {
    await new SmtpRelay(config).send({ from: 'YourPHR <phr@example.org>', to: 'admin@example.org', subject: 'Synthetic test', text: 'Synthetic body — no PHI.' });
    return undefined;
  } catch (err) {
    return err as SmtpError;
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'yourphr-mail-'));
  const { ca, key, cert } = makeCertificates(dir);
  const base = { host: 'localhost', user: USER, pass: PASS, timeoutMs: 3000 };

  // 1. STARTTLS relay with a certificate from a trusted authority: delivered, AUTH only over TLS.
  {
    const s = await relayServer({ key, cert });
    const err = await attempt({ ...base, port: s.port, secure: false, ca });
    check('STARTTLS relay, trusted certificate: the message is delivered', err === undefined, err?.message ?? '');
    check('  sender and recipient are the ones configured', s.got.from === 'phr@example.org' && s.got.to.join() === 'admin@example.org', `${s.got.from} -> ${s.got.to.join()}`);
    check('  subject and body arrive', /Subject: Synthetic test/.test(s.got.body) && s.got.body.includes('Synthetic body'));
    check('  authentication happened only on the encrypted connection', s.got.authedSecure.length === 1 && s.got.authedSecure[0] === true, JSON.stringify(s.got.authedSecure));
    await s.close();
  }

  // 2. The same relay, but its certificate's authority is not trusted: refused, password never sent.
  {
    const s = await relayServer({ key, cert });
    const err = await attempt({ ...base, port: s.port, secure: false });
    check('an unverifiable certificate is refused', err?.code === 'CERT', err?.message ?? 'sent');
    check('  and the password was never offered', s.authAttempts === 0, `auth attempts: ${s.authAttempts}`);
    check('  and nothing was delivered', s.got.to.length === 0);
    await s.close();
  }

  // 3. A relay that offers no STARTTLS at all: nothing sent, not even the password.
  {
    const s = await relayServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true });
    const err = await attempt({ ...base, port: s.port, secure: false, ca });
    check('a relay without STARTTLS gets nothing', err?.code === 'ETLS', err?.message ?? 'sent');
    check('  the error says to use a relay with STARTTLS or port 465', /STARTTLS/.test(err?.message ?? '') && /465/.test(err?.message ?? ''));
    check('  the password was never offered', s.authAttempts === 0, `auth attempts: ${s.authAttempts}`);
    check('  nothing was delivered', s.got.to.length === 0);
    await s.close();
  }

  // 4. Wrong password: named as the credentials, and the password is not in the message.
  {
    const s = await relayServer({ key, cert });
    const err = await attempt({ ...base, pass: 'wrong-password', port: s.port, secure: false, ca });
    check('a refused password is named as the username or password', err?.code === 'EAUTH', err?.message ?? 'sent');
    check('  the error names the settings to fix', /smtp\.user \/ \.pass/.test(err?.message ?? ''));
    check('  and does not contain the password', !(err?.message ?? '').includes('wrong-password'));
    await s.close();
  }

  // 5. Implicit TLS (port 465 style, secure on): delivered.
  {
    const s = await relayServer({ secure: true, key, cert });
    const err = await attempt({ ...base, port: s.port, secure: true, ca });
    check('implicit TLS relay (secure on): the message is delivered', err === undefined && s.got.to.join() === 'admin@example.org', err?.message ?? '');
    await s.close();
  }

  // 6. secure on against a STARTTLS relay: the mismatch is named, not a hang.
  {
    const s = await relayServer({ key, cert });
    const err = await attempt({ ...base, host: '127.0.0.1', port: s.port, secure: true, ca });
    check('secure on against a STARTTLS relay is named as a TLS mismatch', err !== undefined && /TLS/.test(err.message), err?.message ?? 'sent');
    await s.close();
  }

  // 7. The relay refuses the recipient: the envelope is named.
  {
    const s = await relayServer({ key, cert, rejectRcpt: true });
    const err = await attempt({ ...base, port: s.port, secure: false, ca });
    check('a refused recipient is named as the sender or recipient address', err?.code === 'EENVELOPE', err?.message ?? 'sent');
    await s.close();
  }

  // 8. A host that accepts the connection and never speaks: a timeout, not a hang.
  {
    const silent: TcpServer = createTcpServer(() => { /* never greet */ });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const port = (silent.address() as AddressInfo).port;
    const started = Date.now();
    const err = await attempt({ ...base, port, secure: false, ca, timeoutMs: 1000 });
    check('a relay that never answers times out', err?.code === 'ETIMEDOUT' && Date.now() - started < 10_000, `${err?.code ?? 'sent'} after ${Date.now() - started} ms`);
    silent.close();
  }

  // 9. Nothing listening: a connection error that names the host and port.
  {
    const probe: TcpServer = createTcpServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const err = await attempt({ ...base, port, secure: false, ca });
    check('nothing listening: the error names the relay host and port', err !== undefined && err.message.includes(`localhost:${port}`), err?.message ?? 'sent');
  }

  // 10. Refusals before any connection.
  {
    let noHost = '';
    try { new SmtpRelay({ host: ' ', port: 587, secure: false }); } catch (err) { noHost = (err as SmtpError).code; }
    check('no host configured is refused before connecting', noHost === 'NOHOST');
    let badPort = '';
    try { new SmtpRelay({ host: 'localhost', port: 70000, secure: false }); } catch (err) { badPort = (err as SmtpError).code; }
    check('a port that is not a port is refused before connecting', badPort === 'BADPORT');
  }

  check('no failure message anywhere carried the relay password', !results.some((r) => r.detail.includes(PASS)));

  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`mail harness failed: ${(err as Error).message}`);
  process.exit(1);
});
