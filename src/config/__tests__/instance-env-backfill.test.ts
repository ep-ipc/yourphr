import { describe, expect, it } from 'vitest';
import { ensureInstanceEnvSecret, readEnvLine, type InstanceEnvFs } from '../instance-env-backfill.js';

/** An in-memory filesystem: what was written, and the mode a new file was created with. */
function memFs(initial: Record<string, string> = {}, opts: { failWrite?: boolean } = {}): InstanceEnvFs & { files: Record<string, string>; modes: Record<string, number> } {
  const files = { ...initial };
  const modes: Record<string, number> = {};
  return {
    files, modes,
    readFile: (p) => files[p] ?? null,
    appendFile: (p, line, mode) => {
      if (opts.failWrite) throw new Error('read-only file system');
      if (!(p in files)) modes[p] = mode;
      files[p] = (files[p] ?? '') + line;
    },
    randomSecret: () => 'GENERATED',
  };
}
const spec = { name: 'YOURPHR_SESSION_SECRET', comment: 'test', refusal: (p: string, c: Error) => new Error(`cannot write ${p}: ${c.message}`) };

describe('the session key is generated once and kept (yourphr#815, ported from ngdpbase)', () => {
  it('uses the environment when set, and writes nothing', () => {
    const io = memFs();
    expect(ensureInstanceEnvSecret(spec, { YOURPHR_SESSION_SECRET: 'from-env' }, '/data', io)).toEqual({ secret: 'from-env', origin: { kind: 'env' } });
    expect(io.files).toEqual({});
  });

  it('uses the instance .env line when the environment passes it blank', () => {
    const io = memFs({ '/data/.env': 'OTHER=1\nYOURPHR_SESSION_SECRET="kept"\n' });
    expect(ensureInstanceEnvSecret(spec, { YOURPHR_SESSION_SECRET: '' }, '/data/', io)).toEqual({ secret: 'kept', origin: { kind: 'instance-env-file', path: '/data/.env' } });
  });

  it('generates once into a new 0600 .env, and the next start reads the same key back', () => {
    const io = memFs();
    const first = ensureInstanceEnvSecret(spec, {}, '/data', io);
    expect(first).toEqual({ secret: 'GENERATED', origin: { kind: 'generated', path: '/data/.env' } });
    expect(io.modes['/data/.env']).toBe(0o600);
    const second = ensureInstanceEnvSecret(spec, {}, '/data', { ...io, randomSecret: () => 'DIFFERENT' });
    expect(second.secret).toBe('GENERATED'); // a restart keeps the key — the whole point
  });

  it('appends after an existing file without a trailing newline, never mangling its last line', () => {
    const io = memFs({ '/data/.env': 'YOURPHR_DATABASE_ENCRYPTION_KEY=k' });
    ensureInstanceEnvSecret(spec, {}, '/data', io);
    expect(io.files['/data/.env']).toBe('YOURPHR_DATABASE_ENCRYPTION_KEY=k\n# test\nYOURPHR_SESSION_SECRET=GENERATED\n');
  });

  it('a volume that cannot be written refuses, rather than fall back to a throwaway key', () => {
    expect(() => ensureInstanceEnvSecret(spec, {}, '/data', memFs({}, { failWrite: true }))).toThrow(/cannot write \/data\/\.env: read-only/);
  });

  it('reads the last assignment, unquoted, ignoring comments; blank is absent', () => {
    expect(readEnvLine('A=1\nA=2 # note\n', 'A')).toBe('2');
    expect(readEnvLine("export A='x y'\n", 'A')).toBe('x y');
    expect(readEnvLine('A=\n', 'A')).toBeNull();
  });
});
