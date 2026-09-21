/**
 * A capability to reach ONE operator-configured internal service (yourphr#735) — the C-CDA
 * converter sidecar, and the operator's own SMART relay when it sits on their network
 * (yourphr#749).
 *
 * Why this exists beside the guarded client rather than as an option on it. The guard refuses
 * internal addresses, and the converter MUST be internal: it receives raw C-CDA documents, which
 * are a patient's whole record in the clear (deploy/yourphr-cda-converter.example.yaml: "It must
 * have NO Ingress"). The guarded client's only way past that is `allowInternal`, which is
 * test-only and switches the SSRF guard off for EVERY destination. Using it here would trade a
 * PHI-egress rule for an SSRF hole.
 *
 * So the widening is made as narrow as the need:
 *
 *   - Bound to one origin at construction, taken from configuration an admin set. Every request
 *     is resolved against it and refused if it resolves anywhere else. Nothing that arrives in a
 *     request — an uploaded file, a provider response — can choose the destination.
 *   - Redirects are NOT followed. A 3xx is returned as a status like any other, so the service
 *     cannot bounce the document to a host the operator never named.
 *   - POST with a body or a plain GET, a timeout and a response cap. No agent pooling tricks, no
 *     DNS rewriting.
 *
 * It lives in src/http because this directory is the network's single door
 * (scripts/check-http-boundary.sh). A second way out of the process belongs where the first one
 * is, so both are reviewed together.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface InternalServiceResponse {
  status: number;
  body: Buffer;
}

export interface InternalServiceLimits {
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULTS = { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 };

export class InternalServiceHttp {
  /** Scheme, host and port — the only place requests from this capability can go. */
  readonly origin: string;
  private readonly basePath: string;

  constructor(baseUrl: string, private readonly limits: InternalServiceLimits = {}) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('not a usable service address');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`a service address must be http or https, not ${parsed.protocol}`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      // Credentials in the URL would be logged wherever the URL is.
      throw new Error('a service address must not carry credentials');
    }
    this.origin = parsed.origin;
    this.basePath = parsed.pathname.replace(/\/+$/, '');
  }

  /** `path` is appended to the configured address (its query string included) and must stay on its origin. */
  async post(path: string, body: Buffer, headers: Record<string, string> = {}): Promise<InternalServiceResponse> {
    return this.send('POST', path, body, headers);
  }

  /** As post(), with no body. */
  async get(path: string, headers: Record<string, string> = {}): Promise<InternalServiceResponse> {
    return this.send('GET', path, undefined, headers);
  }

  private async send(method: 'GET' | 'POST', path: string, body: Buffer | undefined, headers: Record<string, string>): Promise<InternalServiceResponse> {
    const target = new URL(this.basePath + (path.startsWith('/') ? path : `/${path}`), this.origin);
    if (target.origin !== this.origin) {
      // No addresses in this or any other message raised here: a caller may forward them to a
      // member's browser, and the configured origin is internal infrastructure.
      throw new Error('refusing a request that leaves the configured service');
    }
    const timeoutMs = this.limits.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxBytes = this.limits.maxBytes ?? DEFAULTS.maxBytes;
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      // Settled once, by whichever comes first. Destroying a request mid-response does not reject
      // on its own — without this an over-size answer resolved as a truncated success.
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const req = request(target, { method, headers: body ? { ...headers, 'content-length': String(body.length) } : headers }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new Error(`the service answered with more than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        res.on('error', fail);
      });
      req.setTimeout(timeoutMs, () => fail(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)));
      req.on('error', fail);
      req.end(body);
    });
  }
}
