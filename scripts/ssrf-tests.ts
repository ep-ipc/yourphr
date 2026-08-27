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

  // --- the operator-declared exemption (yourphr#594) ---
  //
  // A sidecar an operator deploys and names is reachable; everything else internal still is not.
  // The risk this must not become is `allowInternal` by another name, so the checks below are as
  // much about what STAYS refused as about what is now permitted.
  console.log('\nnamed-host exemption\n');

  const sidecar = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const sidecarPort = (sidecar.address() as AddressInfo).port;

  check('an exempted host passes URL validation', validateUrl('http://127.0.0.1:1234/x', false, new Set(['127.0.0.1'])).ok);
  check('exemption is case-insensitive on the host', validateUrl('http://LocalHost:1234/x', false, new Set(['localhost'])).ok);
  check('a DIFFERENT internal host is still refused', !validateUrl('http://10.0.0.5/x', false, new Set(['127.0.0.1'])).ok);
  check('cloud metadata is still refused when something else was exempted', !validateUrl('http://169.254.169.254/latest/meta-data/', false, new Set(['ollama.lan'])).ok);
  check('an empty exemption set changes nothing', !validateUrl('http://127.0.0.1/x', false, new Set()).ok);

  const exempted = new OutboundHttp({ allowHosts: ['127.0.0.1'] });
  let reached = '';
  try {
    const response = await exempted.get(`http://127.0.0.1:${sidecarPort}/health`);
    reached = `HTTP ${response.status}`;
  } catch (err) {
    reached = (err as Error).message;
  }
  check('a request to the exempted host actually connects', reached === 'HTTP 200', reached);

  // The exemption names one host. Another loopback FORM is a different name, and must not inherit it.
  let neighbour = '';
  try {
    await exempted.get(`http://[::1]:${sidecarPort}/health`);
  } catch (err) {
    neighbour = (err as Error).message;
  }
  check('a host that was NOT named stays refused on the same client', neighbour.includes(REFUSAL), neighbour || 'NOTHING THROWN');

  // The guard is still on for everyone else: a default client cannot reach the same sidecar.
  let unexempted = '';
  try {
    await new OutboundHttp().get(`http://127.0.0.1:${sidecarPort}/health`);
  } catch (err) {
    unexempted = (err as Error).message;
  }
  check('a client with no exemption cannot reach it', unexempted.includes(REFUSAL), unexempted || 'NOTHING THROWN');

  sidecar.close();
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
