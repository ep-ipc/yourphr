/**
 * The outbound request path for provider data (yourphr#539).
 *
 * Node's built-in `fetch` cannot be used here: it is undici, which ignores `http.Agent` and so
 * ignores the guarded DNS lookup that is the actual SSRF control. It also follows redirects
 * internally, which is precisely the step that must be inspected rather than delegated. So requests
 * go through node:http/node:https with the guarded agents, and redirects are followed by hand.
 *
 * Every hop is a fresh guarded request. That is the whole point: the validated base URL is public
 * and the server answers `302 http://169.254.169.254/…`, which no amount of checking the ORIGINAL
 * url would catch.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { guardedAgents, validateUrl, REFUSAL } from './ssrf.js';
const DEFAULTS = { maxRedirects: 5, maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 };
export async function guardedFetch(target, options = {}) {
    const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
    const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const allowInternal = options.allowInternal ?? false;
    const agents = guardedAgents(allowInternal);
    const chain = [];
    let current = target;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const checked = validateUrl(current, allowInternal);
        if (!checked.ok) {
            throw new Error(checked.reason);
        }
        chain.push(current);
        const url = checked.url;
        const secure = url.protocol === 'https:';
        const send = secure ? httpsRequest : httpRequest;
        const method = options.method ?? 'GET';
        const requestBody = options.form
            ? new URLSearchParams(options.form).toString()
            : options.json !== undefined
                ? JSON.stringify(options.json)
                : undefined;
        const requestContentType = options.form ? 'application/x-www-form-urlencoded' : 'application/json';
        const response = await new Promise((resolve, reject) => {
            const req = send(url, {
                method,
                agent: secure ? agents.https : agents.http,
                headers: {
                    accept: 'application/json',
                    ...(requestBody === undefined
                        ? {}
                        : {
                            'content-type': requestContentType,
                            'content-length': String(Buffer.byteLength(requestBody)),
                        }),
                    ...options.headers,
                },
                timeout: timeoutMs,
            }, resolve);
            req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms: ${url.href}`)));
            req.on('error', reject);
            if (requestBody !== undefined) {
                req.write(requestBody);
            }
            req.end();
        });
        const location = response.headers.location;
        // A POST is never replayed to a redirect target. The token endpoint carries a client secret and
        // an authorization code; following a redirect would hand both to wherever the response pointed.
        if (method === 'POST' && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.resume();
            throw new Error(`refusing to follow a redirect from a POST to ${url.href} — credentials would be replayed`);
        }
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
            response.resume(); // drain, so the socket is released
            // Resolved against the current URL, because a relative Location is legal and common.
            current = new URL(location, url).href;
            continue;
        }
        const body = await readCapped(response, maxBytes, url.href);
        return {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            finalUrl: url.href,
            chain,
        };
    }
    throw new Error(`too many redirects (${maxRedirects}) starting at ${target}`);
}
/**
 * Reads a body, refusing rather than truncating past the cap.
 *
 * Truncating would hand the caller a JSON document that parses to something different from what the
 * server sent, which is a worse failure than an error.
 */
function readCapped(response, maxBytes, href) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                response.destroy();
                reject(new Error(`response from ${href} exceeded ${maxBytes} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
    });
}
export { REFUSAL };
//# sourceMappingURL=guarded-fetch.js.map