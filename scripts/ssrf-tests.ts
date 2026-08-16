/**
 * Does the SSRF guard actually refuse? (yourphr#539)
 *
 * The gate for Phase 2 is not "an SSRF guard exists", it is "SSRF tests that fail when the guard is
 * removed". These run with no database and no patient data, so unlike every other harness here they
 * run in CI on every push.
 *
 * Mirrors the Go suite's cases, plus the ones this project learned the hard way.
 *
 *   npm run ssrf
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedHostname, isBlockedIp, validateUrl, REFUSAL } from '../src/http/ssrf.js';
import { OutboundHttp } from '../src/http/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('\nblocked addresses\n');

  // Every one of these is a way to say "the machine I am running on", or a way into the network it
  // sits in. The metadata addresses are the classic SSRF prize: credentials, with no auth.
  const mustBlock = [
    '127.0.0.1',
    '127.0.0.2',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // AWS/GCP/Azure metadata
    '169.254.1.1',
    '100.64.0.1', // carrier-grade NAT
    '::1',
    '::',
    'fd00::1',
    'fd00:ec2::254', // IPv6 metadata
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped IPv6 — a documented bypass when only the text is checked
    '::ffff:169.254.169.254',
    'fe80::1%eth0', // zone index must not defeat the parse
  ];
  for (const ip of mustBlock) {
    check(`blocks ${ip}`, isBlockedIp(ip));
  }

  console.log('\nallowed addresses (a guard that blocks everything is not a guard)\n');
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1', '11.0.0.1']) {
    check(`allows ${ip}`, !isBlockedIp(ip));
  }

  console.log('\nunparseable addresses fail closed\n');
  for (const bad of ['', 'not-an-address', '999.999.999.999', '127.0.0']) {
    check(`refuses ${bad || '(empty)'}`, isBlockedIp(bad));
  }

  console.log('\nhostnames\n');
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'printer.local', 'db.internal']) {
    check(`blocks ${h}`, isBlockedHostname(h));
  }
  for (const h of ['example.com', 'fhir.epic.com', 'localhost.example.com']) {
    check(`allows ${h}`, !isBlockedHostname(h));
  }

  console.log('\nURL validation\n');
  check('rejects a loopback URL', !validateUrl('http://127.0.0.1:8080/fhir').ok);
  check('rejects a localhost URL', !validateUrl('https://localhost/fhir').ok);
  check('rejects a bracketed IPv6 loopback', !validateUrl('http://[::1]/fhir').ok);
  check('rejects file://', !validateUrl('file:///etc/passwd').ok);
  check('rejects gopher://', !validateUrl('gopher://example.com/').ok);
  check('rejects an unparseable URL', !validateUrl('http://[').ok);
  check('allows a public URL', validateUrl('https://fhir.example.com/r4').ok);

  console.log('\nlive connections\n');

  // A real loopback server. The guard must refuse to reach it even though it is there and answering.
  const target = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"secret":"reached the internal service"}');
  });
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
  const port = (target.address() as AddressInfo).port;

  const http = new OutboundHttp();
  let refused = '';
  try {
    await http.get(`http://127.0.0.1:${port}/`);
  } catch (err) {
    refused = (err as Error).message;
  }
  check('refuses a direct loopback connection', refused.includes(REFUSAL), refused || 'NOTHING THROWN');

  // The case a base-URL check cannot see: the first URL is fine, the redirect is not.
  const redirector = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/` });
    res.end();
  });
  await new Promise<void>((done) => redirector.listen(0, '127.0.0.1', done));
  const redirectPort = (redirector.address() as AddressInfo).port;

  // allowInternal lets the FIRST hop through, so the refusal proves the redirect hop was judged on
  // its own rather than inherited from the original URL.
  const permissive = new OutboundHttp({ allowInternal: false });
  let redirectRefused = '';
  try {
    await permissive.get(`http://127.0.0.1:${redirectPort}/`);
  } catch (err) {
    redirectRefused = (err as Error).message;
  }
  check('refuses a redirect toward an internal address', redirectRefused.includes(REFUSAL), redirectRefused || 'NOTHING THROWN');

  // The obfuscated numeric form. WHICH layer refuses is platform-dependent — the BSD resolver
  // expands 2130706433 to 127.0.0.1 so the guard catches it, while glibc rejects the name outright
  // so it never reaches the guard. Both mean nothing connected, which is the property under test.
  // This exact split turned the equivalent Go test green on macOS and red on Ubuntu CI today.
  let obfuscated = '';
  try {
    await http.get(`http://2130706433:${port}/`);
  } catch (err) {
    obfuscated = (err as Error).message;
  }
  check(
    'refuses an obfuscated numeric loopback host',
    obfuscated.includes(REFUSAL) || /ENOTFOUND|getaddrinfo|no such host|EAI_AGAIN/i.test(obfuscated),
    obfuscated || 'NOTHING THROWN'
  );

  target.close();
  redirector.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
