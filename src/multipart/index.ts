/**
 * Reading a `multipart/form-data` upload (yourphr#654).
 *
 * Written here rather than pulled in, because the only upload this stack accepts is one file on one
 * endpoint, and a general-purpose parser is a large dependency and a large attack surface for that.
 * What is here is deliberately narrow, and refuses anything it does not fully understand rather than
 * guessing — a parser that guesses about a boundary is a parser that can be walked past.
 *
 * It is NOT in `src/http`. That directory is the OUTBOUND capability and the SSRF guard; this reads
 * a body off a request that has already arrived. Putting it there would blur the one rule that
 * directory exists to enforce.
 *
 * What it refuses:
 *   - a body larger than the cap, checked as it arrives rather than after
 *   - a content-type that is not multipart/form-data, or one with no boundary
 *   - more parts than expected, so a request cannot make the server hold an unbounded list
 *   - a part with no name
 */
import type { IncomingMessage } from 'node:http';

export interface UploadedPart {
  /** The form field name — `file` for the upload this serves. */
  name: string;
  /** The client's filename, '' when it sent none. Never used as a path; see the manager. */
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartLimits {
  /** Total bytes accepted off the wire before the request is refused. */
  maxBytes: number;
  /** Most parts a body may carry. */
  maxParts: number;
}

export const DEFAULT_LIMITS: MultipartLimits = { maxBytes: 64 * 1024 * 1024, maxParts: 8 };

export class UploadError extends Error {}

/** The boundary from a `multipart/form-data` content-type, or null when this is not one. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const [type, ...rest] = contentType.split(';');
  if ((type ?? '').trim().toLowerCase() !== 'multipart/form-data') return null;
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    // Quoted per RFC 2046, and commonly unquoted in practice; accept either, reject empty.
    const raw = param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    return raw === '' ? null : raw;
  }
  return null;
}

/** Read the whole body, refusing as soon as it passes the cap rather than after buffering it all. */
function readCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Destroying the socket is the point: without it the client keeps sending and the process
        // keeps reading, and the cap protects nothing.
        req.destroy();
        reject(new UploadError(`the upload is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(new UploadError(`the upload did not finish: ${err.message}`)));
  });
}

/** `name` and `filename` out of a Content-Disposition header. */
function disposition(header: string): { name: string; filename: string } {
  const pick = (key: string): string => {
    // Quoted form first — a filename may legitimately contain a semicolon.
    const quoted = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i').exec(header);
    if (quoted) return quoted[1] ?? '';
    const bare = new RegExp(`${key}\\s*=\\s*([^;]+)`, 'i').exec(header);
    return (bare?.[1] ?? '').trim();
  };
  return { name: pick('name'), filename: pick('filename') };
}

/**
 * Parse one `multipart/form-data` request into its parts.
 *
 * Splits on the boundary rather than scanning byte by byte: the bodies here are whole files already
 * in memory, so the simple form is both correct and easier to be sure of than a streaming state
 * machine would be.
 */
export async function readMultipart(req: IncomingMessage, limits: MultipartLimits = DEFAULT_LIMITS): Promise<UploadedPart[]> {
  const boundary = boundaryOf(req.headers['content-type']);
  if (boundary === null) throw new UploadError('expected a multipart/form-data upload');

  const body = await readCapped(req, limits.maxBytes);
  // A delimiter is CRLF + "--boundary". The CRLF is part of it, not part of the content before it —
  // which is also what stops a payload that happens to contain "--boundary" from splitting the part
  // early and truncating the file. Only the OPENING delimiter may appear without a leading CRLF.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const opening = Buffer.from(`--${boundary}`);
  const parts: UploadedPart[] = [];

  let cursor: number;
  let cursorLength: number;
  if (body.subarray(0, opening.length).equals(opening)) {
    cursor = 0;
    cursorLength = opening.length;
  } else {
    cursor = body.indexOf(delimiter);
    cursorLength = delimiter.length;
    if (cursor === -1) throw new UploadError('the upload is malformed: its boundary never appears');
  }

  while (cursor !== -1) {
    let start = cursor + cursorLength;
    // "--" after the delimiter closes the body; anything past it is epilogue and ignored.
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() === '\r\n') start += 2;

    const next = body.indexOf(delimiter, start);
    if (next === -1) throw new UploadError('the upload is malformed: a part has no closing boundary');

    const chunk = body.subarray(start, next);
    const split = chunk.indexOf('\r\n\r\n');
    if (split === -1) throw new UploadError('the upload is malformed: a part has no header block');

    const headers = chunk.subarray(0, split).toString('utf8');
    const data = chunk.subarray(split + 4);

    let name = '';
    let filename = '';
    let contentType = '';
    for (const line of headers.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'content-disposition') ({ name, filename } = disposition(value));
      else if (key === 'content-type') contentType = value;
    }
    if (name === '') throw new UploadError('the upload is malformed: a part has no name');

    parts.push({ name, filename, contentType, data });
    if (parts.length > limits.maxParts) throw new UploadError(`the upload carries more than ${limits.maxParts} parts`);

    cursor = next;
    cursorLength = delimiter.length;
  }

  return parts;
}
