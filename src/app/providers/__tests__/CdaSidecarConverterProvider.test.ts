/**
 * The C-CDA converter (yourphr#735): the sidecar call, and — the #397 lesson — errors an operator
 * can act on, which never hand the member's browser the sidecar's internal address.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../framework/ApiContext.js';
import { CdaSidecarConverterProvider, type CdaConverterSettings, type ConverterTransport } from '../CdaSidecarConverterProvider.js';
import { cdaPatientId } from '../../../upload/index.js';
import { InternalServiceHttp } from '../../../http/index.js';

const CCD = '<?xml version="1.0"?><ClinicalDocument><recordTarget><patientRole><id root="1.2" extension="abc"/></patientRole></recordTarget></ClinicalDocument>';

class ScriptedTransport implements ConverterTransport {
  calls: { path: string; body: string; headers: Record<string, string> }[] = [];
  constructor(private readonly answer: () => Promise<{ status: number; body: Buffer }>) {}
  async post(path: string, body: Buffer, headers: Record<string, string>) {
    this.calls.push({ path, body: body.toString(), headers });
    return this.answer();
  }
}

const ok = (fhirResource: unknown) => async () => ({ status: 200, body: Buffer.from(JSON.stringify({ fhirResource })) });

function build(settings: Partial<CdaConverterSettings>, answer = ok({ resourceType: 'Bundle', entry: [] })) {
  const current: CdaConverterSettings = { enabled: true, url: 'http://yourphr-cda-converter.internal:8080', timeoutSeconds: 60, ...settings };
  const built: { url: string; timeoutMs?: number }[] = [];
  const transport = new ScriptedTransport(answer);
  const provider = new CdaSidecarConverterProvider(() => current, (url, limits) => {
    built.push({ url, timeoutMs: limits.timeoutMs });
    return transport;
  });
  return { provider, transport, built, current };
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a refusal');
}

describe('CdaSidecarConverterProvider', () => {
  it('claims C-CDA and nothing else', () => {
    const { provider } = build({});
    expect(provider.canHandle(Buffer.from(CCD))).toBe(true);
    expect(provider.canHandle(Buffer.from('{"resourceType":"Bundle"}'))).toBe(false);
  });

  it('is ready only when enabled AND an address is set — either alone still fails (yourphr#397)', () => {
    expect(build({}).provider.status()).toMatchObject({ enabled: true, ready: true });
    expect(build({ url: '  ' }).provider.status()).toMatchObject({ enabled: true, ready: false });
    expect(build({ enabled: false }).provider.status()).toMatchObject({ enabled: false, ready: false });
    expect(build({}).provider.status().setup_hint).toContain('yourphr.cda-converter.url');
    expect(build({}).provider.status().setup_hint).not.toContain('yourphr-cda-converter.internal'); // no address to the browser
  });

  it('posts the document with Go\'s path and a stable patient id, and unwraps fhirResource', async () => {
    const bundle = { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'x' } }] };
    const { provider, transport } = build({}, ok(bundle));
    const out = await provider.convert(Buffer.from(CCD));
    expect(JSON.parse(out.toString())).toEqual(bundle);
    expect(transport.calls).toEqual([{ path: `/api/convert/cda/ccd.hbs?patientId=${cdaPatientId(CCD)}`, body: CCD, headers: { 'content-type': 'text/plain' } }]);
  });

  it('reads its settings on every call: an address set on Admin -> Configuration works without a restart', async () => {
    const { provider, built, current } = build({ url: '' });
    expect((await refusal(provider.convert(Buffer.from(CCD)))).extra['error_code']).toBe('cda_converter_not_configured');
    current.url = 'http://converter-a:8080';
    await provider.convert(Buffer.from(CCD));
    await provider.convert(Buffer.from(CCD));
    current.url = 'http://converter-b:8080';
    current.timeoutSeconds = 0; // not a real timeout: falls back to 60
    await provider.convert(Buffer.from(CCD));
    expect(built).toEqual([{ url: 'http://converter-a:8080', timeoutMs: 60_000 }, { url: 'http://converter-b:8080', timeoutMs: 60_000 }]); // rebuilt on change only
  });

  it('turned off: says so, and how to turn it on', async () => {
    const err = await refusal(build({ enabled: false }).provider.convert(Buffer.from(CCD)));
    expect(err.status).toBe(400);
    expect(err.extra['error_code']).toBe('cda_converter_disabled');
    expect(err.message).toContain('yourphr.cda-converter.enabled');
  });

  it('an address the capability refuses is a configuration error, not a crash', async () => {
    const provider = new CdaSidecarConverterProvider(() => ({ enabled: true, url: 'file:///etc/passwd', timeoutSeconds: 60 }));
    const err = await refusal(provider.convert(Buffer.from(CCD)));
    expect(err.status).toBe(400);
    expect(err.extra['error_code']).toBe('cda_converter_not_configured');
  });

  it('unreachable: tells the operator to start the service — with the error code, never the address', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 10.43.0.17:8080'), { code: 'ECONNREFUSED' });
    const { provider } = build({}, async () => { throw down; });
    const err = await refusal(provider.convert(Buffer.from(CCD)));
    expect(err.status).toBe(502);
    expect(err.extra['error_code']).toBe('cda_converter_unreachable');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('10.43.0.17');
    expect(err.message).not.toContain('yourphr-cda-converter.internal');
  });

  it('the capability\'s own refusal reaches the browser without an address either', async () => {
    const provider = new CdaSidecarConverterProvider(() => ({ enabled: true, url: 'http://10.43.0.17:8080', timeoutSeconds: 60 }), (url, limits) => {
      const real = new InternalServiceHttp(url, limits);
      return { post: (_path, body, headers) => real.post('//169.254.169.254/x', body, headers) };
    });
    const err = await refusal(provider.convert(Buffer.from(CCD)));
    expect(err.message).toContain('leaves the configured service');
    expect(err.message).not.toMatch(/10\.43\.0\.17|169\.254/);
  });

  it.each([
    ['a non-200', async () => ({ status: 500, body: Buffer.from('template error') }), /\(HTTP 500\): template error/],
    ['not JSON', async () => ({ status: 200, body: Buffer.from('<html>') }), /not JSON/],
    ['no fhirResource', async () => ({ status: 200, body: Buffer.from('{"other":1}') }), /without a fhirResource/],
  ])('a converter answer that is %s is a conversion failure', async (_, answer, message) => {
    const err = await refusal(build({}, answer).provider.convert(Buffer.from(CCD)));
    expect(err.status).toBe(502);
    expect(err.extra['error_code']).toBe('cda_conversion_failed');
    expect(err.message).toMatch(message);
  });
});
