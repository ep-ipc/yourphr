/**
 * C-CDA -> FHIR through the fhir-converter sidecar (yourphr#735), ported from the Go stack's
 * `handler/cda_converter.go` (#254, #397, #404).
 *
 * What carried over unchanged, because each was learned the hard way:
 *
 *   - The call: `POST {url}/api/convert/cda/ccd.hbs?patientId=<id>`, the document as text/plain,
 *     the Bundle unwrapped from `{"fhirResource": ...}`.
 *   - The patient id is derived, deterministically, from the document (see `cdaPatientId`), so a
 *     re-import lands on the same Patient instead of minting another.
 *   - Errors name the setting to change and the service to start (#397): a self-hoster was sent
 *     down a dead end by "set cda_converter.enabled" when the real problem was a prefix and a
 *     missing container. An error nobody can act on is a bug in the error.
 *
 * What changed. The settings are read on every call, not frozen at boot, so an operator who sets
 * the address on Admin -> Configuration does not need a restart to find out whether it works —
 * the rate limiter's precedent (server.ts, ngdpbase's `configure()` seam). The HTTP capability is
 * rebuilt only when the address changes, and it can reach that one address and nothing else
 * (src/http/internal-service.ts).
 */
import { ApiError } from '../../framework/ApiContext.js';
import { InternalServiceHttp, type InternalServiceLimits, type InternalServiceResponse } from '../../http/index.js';
import { cdaPatientId, looksLikeCda } from '../../upload/index.js';
import { BaseDocumentConverterProvider, type ConverterStatus } from './BaseDocumentConverterProvider.js';

export interface CdaConverterSettings {
  enabled: boolean;
  url: string;
  timeoutSeconds: number;
}

/** The one method this needs from the capability — so a spec can hand in a scripted service. */
export interface ConverterTransport {
  post(path: string, body: Buffer, headers: Record<string, string>): Promise<InternalServiceResponse>;
}

export const CDA_SETTING_KEYS = {
  enabled: 'yourphr.cda-converter.enabled',
  url: 'yourphr.cda-converter.url',
  timeoutSeconds: 'yourphr.cda-converter.timeout-seconds',
} as const;

const DOCS = 'See docs/import/c-cda.md.';

function setupHint(problem: string): string {
  return `${problem} C-CDA import needs the fhir-converter service running beside this instance, and its address set on Admin -> Configuration:\n` +
    `  - ${CDA_SETTING_KEYS.url} = http://<converter-host>:8080\n` +
    `  - ${CDA_SETTING_KEYS.enabled} = true\n` +
    'The converter image is ghcr.io/jwilleke/yourphr-cda-converter. Keep it internal — it receives whole medical records — so give it no published port or ingress; on Kubernetes see deploy/yourphr-cda-converter.example.yaml. ' +
    DOCS;
}

/** No address in it: this text reaches the member's browser, and the sidecar's address is internal infrastructure. */
function unreachableHint(detail: string): string {
  return `The C-CDA converter did not answer at the configured address (${detail}). C-CDA import is configured, so the settings are not the problem: start the converter service, ` +
    `point ${CDA_SETTING_KEYS.url} at one that is running, or set ${CDA_SETTING_KEYS.enabled} = false to turn C-CDA import off. ${DOCS}`;
}

export class CdaSidecarConverterProvider extends BaseDocumentConverterProvider {
  readonly formatId = 'ccda';
  readonly formatName = 'C-CDA';
  private transport?: { key: string; http: ConverterTransport };

  constructor(
    private readonly settings: () => CdaConverterSettings,
    private readonly transportFor: (url: string, limits: InternalServiceLimits) => ConverterTransport = (url, limits) => new InternalServiceHttp(url, limits)
  ) {
    super();
  }

  canHandle(bytes: Buffer): boolean {
    return looksLikeCda(bytes);
  }

  status(): ConverterStatus {
    const s = this.settings();
    const configured = s.url.trim() !== '';
    return {
      enabled: s.enabled,
      // Both, because either alone still fails the upload — the half-configured case is exactly
      // what made #397 hard to diagnose.
      ready: s.enabled && configured,
      setup_hint: setupHint('C-CDA import is not available on this server.'),
    };
  }

  async convert(bytes: Buffer): Promise<Buffer> {
    const s = this.settings();
    if (!s.enabled) throw new ApiError(400, setupHint(`C-CDA import is turned off on this server (${CDA_SETTING_KEYS.enabled} = false).`), { error_code: 'cda_converter_disabled' });
    const url = s.url.trim();
    if (url === '') throw new ApiError(400, setupHint('C-CDA import is enabled but no converter address is configured.'), { error_code: 'cda_converter_not_configured' });

    const timeoutSeconds = s.timeoutSeconds > 0 ? s.timeoutSeconds : 60;
    const key = `${url}|${timeoutSeconds}`;
    if (this.transport?.key !== key) {
      let http: ConverterTransport;
      try {
        http = this.transportFor(url, { timeoutMs: timeoutSeconds * 1000 });
      } catch (err) {
        throw new ApiError(400, setupHint(`The converter address ${CDA_SETTING_KEYS.url} is not usable: ${(err as Error).message}.`), { error_code: 'cda_converter_not_configured' });
      }
      this.transport = { key, http };
    }

    const xml = bytes.toString('utf8');
    const patientId = cdaPatientId(xml);
    let response: InternalServiceResponse;
    try {
      response = await this.transport.http.post(`/api/convert/cda/ccd.hbs?patientId=${encodeURIComponent(patientId)}`, bytes, { 'content-type': 'text/plain' });
    } catch (err) {
      // The code alone ("ECONNREFUSED"): Node's message carries the resolved address.
      throw new ApiError(502, unreachableHint((err as NodeJS.ErrnoException).code ?? (err as Error).message), { error_code: 'cda_converter_unreachable' });
    }
    if (response.status !== 200) {
      const detail = response.body.toString('utf8').slice(0, 300);
      throw new ApiError(502, `The C-CDA converter could not convert this document (HTTP ${response.status}): ${detail}`, { error_code: 'cda_conversion_failed' });
    }

    let envelope: { fhirResource?: unknown };
    try {
      envelope = JSON.parse(response.body.toString('utf8')) as { fhirResource?: unknown };
    } catch (err) {
      throw new ApiError(502, `The C-CDA converter answered with something that is not JSON (${(err as Error).message}).`, { error_code: 'cda_conversion_failed' });
    }
    if (!envelope.fhirResource || typeof envelope.fhirResource !== 'object') {
      throw new ApiError(502, 'The C-CDA converter answered without a fhirResource.', { error_code: 'cda_conversion_failed' });
    }
    return Buffer.from(JSON.stringify(envelope.fhirResource), 'utf8');
  }
}
