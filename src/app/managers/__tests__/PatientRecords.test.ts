/**
 * Records the PATIENT writes (yourphr#683) — the first write path in this stack that is not the
 * worker or the migration.
 *
 * The tooth is PROVENANCE and ISOLATION, not "the method returns". A hand-entered practitioner
 * that lands under a synced provider's source would make the record claim an origin it does not
 * have, and one visible to another household member would be a disclosure. Both are silent
 * failures: the write succeeds either way and the screen looks right.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStores, type Stores } from '../../../app.js';
import { ApiContext } from '../../../framework/ApiContext.js';
import { MANUAL_PLATFORM_TYPE } from '../SourcesManager.js';

const practitioner = (id: string, family: string) => ({
  resourceType: 'Practitioner' as const,
  id,
  name: [{ family, given: ['Pat'] }],
});

async function withStores(fn: (s: Stores, ctxOf: (u: string) => ApiContext) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'patient-records-'));
  const stores = await openStores(dir, {});
  try {
    await fn(stores, (u) => ApiContext.system('test', u, stores.engine));
  } finally {
    await stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('patient-authored records', () => {
  it('creates, then updates the same record rather than duplicating it', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      const first = await s.records.savePatientRecord(ctx, practitioner('p-1', 'Ashworth') as never);
      expect(first).toEqual({ id: 'p-1', outcome: 'created' });

      const second = await s.records.savePatientRecord(ctx, practitioner('p-1', 'Ashworth-Smith') as never);
      expect(second).toEqual({ id: 'p-1', outcome: 'updated' });

      const listed = await s.records.list(ctx, 'Practitioner');
      expect(listed).toHaveLength(1);
    });
  });

  it('attributes the record to the account\'s own manual source, never a provider\'s', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      await s.records.savePatientRecord(ctx, practitioner('p-2', 'Okafor') as never);

      const sources = await s.sources.list(ctx);
      const manual = sources.filter((x) => x.platformType === MANUAL_PLATFORM_TYPE);
      expect(manual).toHaveLength(1);
      expect(manual[0]?.display).toBe('Added by you');
      // It holds nothing the worker could sync with — that is what keeps it inert.
      expect(manual[0]?.fhirBaseUrl).toBe('');
      expect(manual[0]?.accessToken).toBe('');

      const stored = await s.recordsProvider.read('jim', 'Practitioner', 'p-2');
      expect(stored?.sourceId).toBe(`source-${manual[0]?.id}`);
    });
  });

  it('creates the manual source once, however many records are written', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      await s.records.savePatientRecord(ctx, practitioner('p-3', 'A') as never);
      await s.records.savePatientRecord(ctx, practitioner('p-4', 'B') as never);
      await s.records.savePatientRecord(ctx, practitioner('p-5', 'C') as never);
      expect((await s.sources.list(ctx)).filter((x) => x.platformType === MANUAL_PLATFORM_TYPE)).toHaveLength(1);
    });
  });

  it('TOOTH: one household member cannot see another\'s hand-entered records', async () => {
    await withStores(async (s, ctxOf) => {
      await s.records.savePatientRecord(ctxOf('jim'), practitioner('p-6', 'Private') as never);

      expect(await s.records.list(ctxOf('pat'), 'Practitioner')).toHaveLength(0);
      expect(await s.recordsProvider.read('pat', 'Practitioner', 'p-6')).toBeUndefined();
      // And each account gets its own manual source rather than sharing one.
      await s.records.savePatientRecord(ctxOf('pat'), practitioner('p-7', 'Other') as never);
      const jimSource = (await s.sources.list(ctxOf('jim'))).find((x) => x.platformType === MANUAL_PLATFORM_TYPE);
      const patSource = (await s.sources.list(ctxOf('pat'))).find((x) => x.platformType === MANUAL_PLATFORM_TYPE);
      expect(jimSource?.id).not.toBe(patSource?.id);
    });
  });

  it('refuses a resource with no id or no resourceType rather than inventing one', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      await expect(s.records.savePatientRecord(ctx, { resourceType: 'Practitioner' } as never)).rejects.toThrow(/needs an id/);
      await expect(s.records.savePatientRecord(ctx, { id: 'x' } as never)).rejects.toThrow(/resourceType/);
    });
  });
});

describe('what refers to a record', () => {
  it('finds the encounters that name a practitioner, and only those', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      await s.records.savePatientRecord(ctx, practitioner('doc-1', 'Ashworth') as never);

      // Written through the manual source too, so the fixture needs no worker.
      await s.records.savePatientRecord(ctx, {
        resourceType: 'Encounter', id: 'enc-1', status: 'finished',
        participant: [{ individual: { reference: 'Practitioner/doc-1' } }],
        period: { start: '2026-03-04' },
      } as never);
      await s.records.savePatientRecord(ctx, {
        resourceType: 'Encounter', id: 'enc-2', status: 'finished',
        participant: [{ individual: { reference: 'Practitioner/someone-else' } }],
      } as never);

      const related = await s.records.referencing(ctx, 'Practitioner', 'doc-1', 'Encounter');
      expect(related.map((r) => r.source_resource_id)).toEqual(['enc-1']);
      expect(related[0]?.source_resource_type).toBe('Encounter');
    });
  });

  it('answers empty for a practitioner nothing refers to, rather than failing', async () => {
    await withStores(async (s, ctxOf) => {
      const ctx = ctxOf('jim');
      await s.records.savePatientRecord(ctx, practitioner('doc-2', 'Unreferenced') as never);
      expect(await s.records.referencing(ctx, 'Practitioner', 'doc-2', 'Encounter')).toEqual([]);
    });
  });

  it('TOOTH: does not leak another account\'s references', async () => {
    await withStores(async (s, ctxOf) => {
      await s.records.savePatientRecord(ctxOf('jim'), practitioner('doc-3', 'Shared name') as never);
      await s.records.savePatientRecord(ctxOf('jim'), {
        resourceType: 'Encounter', id: 'enc-3', status: 'finished',
        participant: [{ individual: { reference: 'Practitioner/doc-3' } }],
      } as never);
      expect(await s.records.referencing(ctxOf('pat'), 'Practitioner', 'doc-3', 'Encounter')).toEqual([]);
    });
  });
});
