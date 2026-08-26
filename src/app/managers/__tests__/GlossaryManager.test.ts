import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../../framework/Engine.js';
import { ApiContext, ApiError } from '../../../framework/ApiContext.js';
import { GlossaryManager } from '../GlossaryManager.js';
import { FakeGlossaryCacheProvider } from '../../providers/__tests__/FakeGlossaryCacheProvider.js';
import { BaseGlossaryProvider, NullGlossaryProvider, type GlossaryEntry } from '../../providers/BaseGlossaryProvider.js';

const CREATININE: GlossaryEntry = {
  title: 'Creatinine (Blood)',
  description: 'A waste product filtered by your kidneys.',
  url: 'https://medlineplus.gov/lab-tests/creatinine-test/',
  publisher: 'MedlinePlus',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** A scripted lookup: counts calls, so "cache first" can be asserted rather than assumed. */
class ScriptedLookup extends BaseGlossaryProvider {
  readonly name = 'scripted';
  readonly available = true;
  readonly unavailableReason = '';
  calls: string[] = [];
  answer: GlossaryEntry | undefined = CREATININE;
  fail = false;
  async explain(code: string, oid: string): Promise<GlossaryEntry | undefined> {
    this.calls.push(`${code}|${oid}`);
    if (this.fail) throw new Error('MedlinePlus is unreachable');
    return this.answer;
  }
}

const LOINC = 'http://loinc.org';
const LOINC_OID = '2.16.840.1.113883.6.1';

let engine: Engine;
let lookup: ScriptedLookup;
let cache: FakeGlossaryCacheProvider;
let glossary: GlossaryManager;
let alice: ApiContext;
let lines: string[];

function boot(provider: BaseGlossaryProvider = lookup): GlossaryManager {
  const m = new GlossaryManager(engine, provider, cache, (l) => lines.push(l));
  engine.register('glossary', m);
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  return m;
}

beforeEach(() => {
  engine = new Engine();
  lookup = new ScriptedLookup();
  cache = new FakeGlossaryCacheProvider();
  lines = [];
  glossary = boot();
});

describe('GlossaryManager — what a code actually means (yourphr#640)', () => {
  it('explains a code and caches it', async () => {
    const first = await glossary.explain(alice, '2160-0', LOINC);
    expect(first).toMatchObject({ title: 'Creatinine (Blood)', code: '2160-0', codeSystem: LOINC_OID, source: 'lookup' });
    expect(first?.description).toContain('kidneys');
    expect(cache.count()).toBe(1);
  });

  it('CACHE FIRST: a code already explained never causes another request', async () => {
    await glossary.explain(alice, '2160-0', LOINC);
    const second = await glossary.explain(alice, '2160-0', LOINC);
    expect(second).toMatchObject({ source: 'cache', title: 'Creatinine (Blood)' });
    // The whole reason the cache exists: MedlinePlus allows 100 requests a minute and one lab
    // page can carry dozens of codes.
    expect(lookup.calls).toEqual(['2160-0|' + LOINC_OID]);
  });

  it('maps every FHIR code system Go mapped, and passes an OID straight through', async () => {
    expect(glossary.codeSystemOid(LOINC)).toBe(LOINC_OID);
    expect(glossary.codeSystemOid('http://snomed.info/sct')).toBe('2.16.840.1.113883.6.96');
    expect(glossary.codeSystemOid('http://www.nlm.nih.gov/research/umls/rxnorm')).toBe('2.16.840.1.113883.6.88');
    expect(glossary.codeSystemOid('2.16.840.1.113883.6.1')).toBe('2.16.840.1.113883.6.1');
    expect(glossary.supportedSystems()).toHaveLength(8);
  });

  it('an unknown code system is 400, and an empty code is 400', async () => {
    await expect(glossary.explain(alice, '2160-0', 'http://example.org/codes')).rejects.toMatchObject({ status: 400 });
    await expect(glossary.explain(alice, '   ', LOINC)).rejects.toMatchObject({ status: 400 });
  });

  it('a code nobody explains is a NORMAL answer, not an error', async () => {
    lookup.answer = undefined;
    expect(await glossary.explain(alice, '99999-9', LOINC)).toBeUndefined();
    expect(cache.count()).toBe(0);   // nothing to cache; the next page may get lucky
  });

  it('a failed lookup leaves the record readable — the explanation is missing, not the page', async () => {
    lookup.fail = true;
    expect(await glossary.explain(alice, '2160-0', LOINC)).toBeUndefined();
    expect(lines.some((l) => l.includes('lookup failed'))).toBe(true);
  });

  it('an instance with no lookup serves what it has cached and says why it can do no more', async () => {
    await glossary.explain(alice, '2160-0', LOINC);              // cached while a lookup existed
    // A separate engine over the SAME cache: the instance rebooted bound to 'null'.
    const offlineEngine = new Engine();
    const offline = new GlossaryManager(offlineEngine, new NullGlossaryProvider(), cache);
    offlineEngine.register('glossary', offline);
    const alice2 = ApiContext.from({ username: 'alice', role: 'user' }, offlineEngine);
    expect(await offline.explain(alice2, '2160-0', LOINC)).toMatchObject({ source: 'cache' });
    expect(await offline.explain(alice2, '4548-4', LOINC)).toBeUndefined();
    expect(offline.unavailable()).toContain('no glossary lookup is configured');
  });

  it('requires a caller: a code is not PHI, but this must not be an open outbound trigger', async () => {
    await expect(glossary.explain(ApiContext.anonymous(engine), '2160-0', LOINC)).rejects.toBeInstanceOf(ApiError);
  });

  it('reports at boot how many codes it has explained — the number yourphr#606 turned on', async () => {
    await glossary.explain(alice, '2160-0', LOINC);
    await glossary.initialize();
    expect(lines.some((l) => l.includes('1 code(s) already explained'))).toBe(true);
  });
});
