/**
 * A minimal zip writer for tests (yourphr#786): local headers and data, then the central directory
 * and its end record. Shared by the unit tests and scripts/app-tests.ts, so each test builds exactly
 * the archive it describes — never a real patient's export.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipSpec {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  encrypted?: boolean;
  /** Overrides the CRC written to the directory — a damaged entry. */
  crc?: number;
}

/** A minimal zip: local headers and data, then the central directory and its end record. */
export function buildZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, 'utf8');
    const data = typeof s.data === 'string' ? Buffer.from(s.data, 'utf8') : (s.data ?? Buffer.alloc(0));
    const method = s.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = s.crc ?? crc32(data);
    const flags = 0x800 | (s.encrypted ? 0x1 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
