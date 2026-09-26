/** Unit tests for scripts/baseline-profile.ts — the parts that decide what counts as a regression. */
import { describe, expect, test } from 'vitest';
import { drift, median, outputFile, parseBaseline, type Snapshot, type Thresholds } from '../baseline-profile.js';

const T: Thresholds = { memPct: 25, rtPct: 50, rtMs: 50 };
const snap = (memoryMb: number, routes: [string, number][], coldStartMs = 3000): Snapshot => ({ memoryMb, coldStartMs, routes: new Map(routes) });

describe('median()', () => {
  test('odd and even counts', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('outputFile()', () => {
  test('never overwrites a same-day capture of the same version', () => {
    const taken = new Set(['/d/baseline-v3.7.2-2026-09-26.md', '/d/baseline-v3.7.2-2026-09-26-r2.md']);
    expect(outputFile('/d', '3.7.2', '2026-09-26', (p) => taken.has(p))).toBe('/d/baseline-v3.7.2-2026-09-26-r3.md');
    expect(outputFile('/d', '3.7.3', '2026-09-26', (p) => taken.has(p))).toBe('/d/baseline-v3.7.3-2026-09-26.md');
  });
});

describe('parseBaseline()', () => {
  test('reads back memory, cold start and every route row, keeping the role apart', () => {
    const text = [
      '| Resident memory (after sampling) | 312.4 MB |',
      '| Cold start (spawn until /api/health answers) | 4210 ms |',
      '| `/api/health` | 2 ms |',
      '| `/api/secure/summary` (member) | 14 ms |',
      '| `/api/secure/admin/database` (admin) | 9 ms |',
    ].join('\n');
    const s = parseBaseline(text);
    expect(s.memoryMb).toBe(312.4);
    expect(s.coldStartMs).toBe(4210);
    expect([...s.routes]).toEqual([['/api/health', 2], ['/api/secure/summary (member)', 14], ['/api/secure/admin/database (admin)', 9]]);
  });
});

describe('drift()', () => {
  test('a route is flagged only when BOTH its % and its ms thresholds trip', () => {
    const prev = snap(300, [['/fast', 2], ['/slow', 100]]);
    const curr = snap(300, [['/fast', 6], ['/slow', 200]]); // /fast: +200% but only +4 ms
    const { flags, markdown } = drift('prev.md', prev, curr, T);
    expect(flags).toEqual(['/slow +100 ms (+100.0%)']);
    expect(markdown).toMatch(/\| `\/slow` \| 100 ms \| 200 ms \| \+100 ms \(\+100\.0%\) ⚠️ \|/);
    expect(markdown).not.toMatch(/`\/fast`.*⚠️/);
  });

  test('memory past its % threshold is flagged', () => {
    expect(drift('p', snap(300, []), snap(400, []), T).flags).toEqual(['memory +100.0 MB (+33.3%)']);
    expect(drift('p', snap(300, []), snap(360, []), T).flags).toEqual([]);
  });

  test('a route the previous baseline did not have is new, not a regression', () => {
    const { flags, markdown } = drift('p', snap(300, []), snap(300, [['/api/x (admin)', 900]]), T);
    expect(flags).toEqual([]);
    expect(markdown).toMatch(/\| `\/api\/x` \(admin\) \| - \| 900 ms \| new \|/);
  });

  test('the section names the file it compared against', () => {
    expect(drift('baseline-v3.7.1-2026-09-24.md', snap(1, []), snap(1, []), T).markdown).toContain('## Drift vs baseline-v3.7.1-2026-09-24.md');
  });
});
