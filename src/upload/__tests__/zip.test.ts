/**
 * Reading a portal's download zip (yourphr#786). The archives are built here, byte by byte, so
 * each test says exactly what is in the file — and none of it is a real patient's export.
 */
import { describe, expect, it } from 'vitest';
import { UploadFormatError } from '../index.js';
import { isZip, readZip } from '../zip.js';
import { buildZip } from './zip-fixture.js';

const LIMITS = { maxTotalBytes: 1024 * 1024 };

function refusal(fn: () => unknown): UploadFormatError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UploadFormatError);
    return err as UploadFormatError;
  }
  throw new Error('expected a refusal');
}

describe('isZip', () => {
  it('knows a zip by its signature, and nothing else as one', () => {
    expect(isZip(buildZip([{ name: 'a.txt', data: 'x' }]))).toBe(true);
    expect(isZip(buildZip([]))).toBe(true);
    expect(isZip(Buffer.from('{"resourceType":"Bundle"}'))).toBe(false);
    expect(isZip(Buffer.from('<ClinicalDocument/>'))).toBe(false);
    expect(isZip(Buffer.from('PK'))).toBe(false);
  });
});

describe('readZip', () => {
  it('returns every file, stored or deflated, with its full path and without directories', () => {
    const zip = buildZip([
      { name: 'IHE_XDM/', data: '' },
      { name: 'IHE_XDM/Una1/DOC0001.XML', data: '<ClinicalDocument/>' },
      { name: 'README.TXT', data: 'read me', method: 0 },
    ]);
    const entries = readZip(zip, LIMITS);
    expect(entries.map((e) => e.name)).toEqual(['IHE_XDM/Una1/DOC0001.XML', 'README.TXT']);
    expect(entries.map((e) => e.bytes.toString('utf8'))).toEqual(['<ClinicalDocument/>', 'read me']);
  });

  it('refuses a password-protected zip, and says what to do', () => {
    expect(refusal(() => readZip(buildZip([{ name: 'DOC0001.XML', data: 'x', encrypted: true }]), LIMITS)).message).toContain('password-protected');
  });

  it('refuses an archive that unpacks past the upload cap — a zip bomb is bounded like any upload', () => {
    const zip = buildZip([{ name: 'big.json', data: Buffer.alloc(200_000, 0x20) }]);
    expect(zip.length).toBeLessThan(2_000);
    expect(refusal(() => readZip(zip, { maxTotalBytes: 100_000 })).message).toContain('upload limit');
  });

  it('refuses too many files', () => {
    const zip = buildZip([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }, { name: 'c', data: 'c' }]);
    expect(refusal(() => readZip(zip, { ...LIMITS, maxEntries: 2 })).message).toContain('at most 2');
  });

  it('refuses a damaged entry by its checksum', () => {
    expect(refusal(() => readZip(buildZip([{ name: 'DOC0001.XML', data: 'x', crc: 1234 }]), LIMITS)).message).toContain('checksum');
  });

  it('refuses a truncated download', () => {
    const zip = buildZip([{ name: 'DOC0001.XML', data: '<ClinicalDocument/>' }]);
    expect(refusal(() => readZip(zip.subarray(0, 20), LIMITS)).message).toContain('download it again');
  });
});
