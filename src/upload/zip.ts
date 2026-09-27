/**
 * Reading a portal's download zip (yourphr#786) — what a patient actually has in hand after
 * "Download my records": Epic MyChart's is an IHE XDM package, C-CDA documents under
 * `IHE_XDM/<name>/DOC000N.XML` beside a PDF, an HTML viewer and its images.
 *
 * Pure and in memory: bytes in, entries out. Nothing is written to disk, so an entry's name is only
 * ever a label and a `../` in it reaches nothing.
 *
 * Built on node:zlib rather than a zip library, because the job is small and the format settled:
 * the central directory, stored and deflated entries, a CRC check. What this does not read it
 * refuses by name — ZIP64, other compression methods, encryption — rather than guessing.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { UploadFormatError } from './index.js';

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

export interface ZipLimits {
  /** Uncompressed bytes across every entry kept — the upload size cap, so a zip bomb is bounded like any upload. */
  maxTotalBytes: number;
  maxEntries?: number;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_MARKER = 0xffffffff;
const DEFAULT_MAX_ENTRIES = 1000;

/** Whether the bytes are a zip archive: a local file header, or the end record of an empty one. */
export function isZip(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes.readUInt32LE(0);
  return sig === LOCAL_HEADER || sig === END_OF_CENTRAL_DIRECTORY;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // The end record is 22 bytes plus a comment of up to 65,535, so it starts in the last 65,557.
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (bytes.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new UploadFormatError('the file looks like a zip but is damaged or incomplete (no directory at its end) — download it again');
}

/**
 * The files in a zip archive, directories left out. Throws UploadFormatError for an archive this
 * cannot read, naming why, so the patient is told something they can act on.
 */
export function readZip(bytes: Buffer, limits: ZipLimits): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const eocd = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const dirSize = bytes.readUInt32LE(eocd + 12);
  const dirOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === ZIP64_MARKER || dirOffset === ZIP64_MARKER) {
    throw new UploadFormatError('the zip uses the ZIP64 format, which is not supported — unzip it and upload the files inside');
  }
  if (count > maxEntries) throw new UploadFormatError(`the zip holds ${count} files; at most ${maxEntries} can be read from one upload`);
  if (dirOffset + dirSize > eocd) throw new UploadFormatError('the zip is damaged (its directory points past the end of the file) — download it again');

  const entries: ZipEntry[] = [];
  let total = 0;
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || bytes.readUInt32LE(at) !== CENTRAL_HEADER) throw new UploadFormatError('the zip is damaged (a directory entry is unreadable) — download it again');
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    // Bit 11 says the name is UTF-8; without it the name is CP437, which is ASCII for every name
    // a portal writes. Only a label either way.
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) {
      throw new UploadFormatError('the zip is password-protected — open it with the password you chose when downloading, then upload the files inside');
    }
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new UploadFormatError('the zip uses the ZIP64 format, which is not supported — unzip it and upload the files inside');
    }
    if (method !== 0 && method !== 8) throw new UploadFormatError(`${name} in the zip is compressed in a way that is not supported (method ${method}) — unzip it and upload the files inside`);
    if (total + size > limits.maxTotalBytes) throw new UploadFormatError(`the zip unpacks to more than the ${limits.maxTotalBytes}-byte upload limit`);

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new UploadFormatError(`the zip is damaged (${name} cannot be found) — download it again`);
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > bytes.length) throw new UploadFormatError(`the zip is damaged (${name} is cut short) — download it again`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    try {
      // maxOutputLength bounds the inflate itself, so a size field that lies cannot unpack past the cap.
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, limits.maxTotalBytes - total) });
    } catch {
      throw new UploadFormatError(`the zip is damaged (${name} cannot be unpacked) — download it again`);
    }
    if (data.length !== size || crc32(data) !== crc) throw new UploadFormatError(`the zip is damaged (${name} does not match its checksum) — download it again`);
    total += data.length;
    entries.push({ name, bytes: data });
  }
  return entries;
}
