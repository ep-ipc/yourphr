/**
 * The upload parser (yourphr#654). It reads bytes a client chose, so the cases that matter are the
 * malformed ones: this asserts what it REFUSES at least as hard as what it accepts.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { boundaryOf, readMultipart, UploadError, type MultipartLimits } from '../index.js';

const LIMITS: MultipartLimits = { maxBytes: 1024 * 1024, maxParts: 4 };

/** A request carrying `body`, as the server would see it. */
const NO_TYPE = Symbol('no content-type');
function request(body: Buffer | string, contentType: string | typeof NO_TYPE = 'multipart/form-data; boundary=X'): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  // A default parameter treats an explicit `undefined` as "not passed", which quietly gave the
  // no-content-type case a valid multipart header and made the test assert nothing.
  stream.headers = contentType === NO_TYPE ? {} : { 'content-type': contentType as string };
  (stream as unknown as PassThrough).end(Buffer.isBuffer(body) ? body : Buffer.from(body));
  return stream;
}

const form = (parts: { name: string; filename?: string; type?: string; body: string }[], boundary = 'X'): string =>
  parts
    .map((p) => `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename === undefined ? '' : `; filename="${p.filename}"`}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n${p.body}\r\n`)
    .join('') + `--${boundary}--\r\n`;

describe('boundaryOf', () => {
  it('reads a bare and a quoted boundary', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc')).toBe('abc');
    expect(boundaryOf('multipart/form-data; boundary="a b c"')).toBe('a b c');
    expect(boundaryOf('MULTIPART/FORM-DATA; BOUNDARY=abc')).toBe('abc');
  });

  it('refuses anything that is not a multipart form, or has no boundary', () => {
    expect(boundaryOf('application/json')).toBeNull();
    expect(boundaryOf('multipart/form-data')).toBeNull();
    expect(boundaryOf('multipart/form-data; boundary=')).toBeNull();
    expect(boundaryOf(undefined)).toBeNull();
  });
});

describe('readMultipart', () => {
  it('reads a single file part whole', async () => {
    const parts = await readMultipart(request(form([{ name: 'file', filename: 'bundle.json', type: 'application/json', body: '{"a":1}' }])), LIMITS);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ name: 'file', filename: 'bundle.json', contentType: 'application/json' });
    expect(parts[0]!.data.toString()).toBe('{"a":1}');
  });

  it('keeps binary content byte-exact', async () => {
    const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x2d, 0x2d, 0x58]); // NULs, CRLF and "--X" inside the payload
    const body = Buffer.concat([
      Buffer.from('--X\r\nContent-Disposition: form-data; name="file"; filename="b.bin"\r\n\r\n'),
      bytes,
      Buffer.from('\r\n--X--\r\n'),
    ]);
    const parts = await readMultipart(request(body), LIMITS);
    expect(parts[0]!.data.equals(bytes)).toBe(true);
  });

  it('reads several parts and keeps their names', async () => {
    const parts = await readMultipart(request(form([{ name: 'a', body: '1' }, { name: 'file', filename: 'x.json', body: '2' }])), LIMITS);
    expect(parts.map((p) => p.name)).toEqual(['a', 'file']);
  });

  it('handles a filename containing a semicolon, which the quoted form allows', async () => {
    const parts = await readMultipart(request(form([{ name: 'file', filename: 'a;b.json', body: '{}' }])), LIMITS);
    expect(parts[0]!.filename).toBe('a;b.json');
  });

  it('REFUSES a body past the cap, and does not buffer it all first', async () => {
    const big = 'x'.repeat(4096);
    await expect(readMultipart(request(form([{ name: 'file', body: big }])), { maxBytes: 512, maxParts: 4 }))
      .rejects.toThrow(UploadError);
  });

  it('refuses a content-type that is not a multipart form', async () => {
    await expect(readMultipart(request('{}', 'application/json'), LIMITS)).rejects.toThrow(/multipart\/form-data/);
    await expect(readMultipart(request('{}', NO_TYPE), LIMITS)).rejects.toThrow(/multipart\/form-data/);
  });

  it('refuses a body whose boundary never appears', async () => {
    await expect(readMultipart(request('not a multipart body at all'), LIMITS)).rejects.toThrow(/boundary never appears/);
  });

  it('refuses a part with no header block', async () => {
    await expect(readMultipart(request('--X\r\nnot-a-header-block--X--\r\n'), LIMITS)).rejects.toThrow(/no closing boundary|no header block/);
  });

  it('refuses a part with no name', async () => {
    await expect(readMultipart(request('--X\r\nContent-Disposition: form-data\r\n\r\nbody\r\n--X--\r\n'), LIMITS)).rejects.toThrow(/no name/);
  });

  it('refuses more parts than the limit, so a body cannot make us hold an unbounded list', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, body: 'x' }));
    await expect(readMultipart(request(form(many)), { maxBytes: 1024 * 1024, maxParts: 4 })).rejects.toThrow(/more than 4 parts/);
  });

  it('ignores anything after the closing delimiter', async () => {
    const parts = await readMultipart(request(form([{ name: 'file', body: 'ok' }]) + 'trailing junk\r\n'), LIMITS);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.data.toString()).toBe('ok');
  });
});
