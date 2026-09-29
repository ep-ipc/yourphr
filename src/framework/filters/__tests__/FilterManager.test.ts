import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../Engine.js';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { FakeConfigProvider } from '../../providers/__tests__/FakeConfigProvider.js';
import { FilterManager } from '../../managers/FilterManager.js';
import { BaseFilter } from '../BaseFilter.js';
import { SecurityFilter } from '../SecurityFilter.js';

let engine: Engine;
let filters: FilterManager;
let lines: string[];

async function boot(custom: Record<string, unknown> = {}): Promise<void> {
  engine = new Engine();
  lines = [];
  filters = new FilterManager(engine, (l) => lines.push(l));
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(custom as never), { env: {} })).register('filters', filters);
  await engine.initialize();
}

beforeEach(async () => { await boot(); });

const rules = async (md: string) => (await filters.collectErrors(md)).map((e) => `${e.line}:${e.rule}`);

describe('save path — markdown that would render to HTML or run script is refused (yourphr#775)', () => {
  it('refuses ngdpbase\'s six, one error per offending line, all at once', async () => {
    const md = ['<script>alert(1)</script>', 'fine', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '<iframe src="https://evil">', '<svg onload=x>', 'a<br>b'].join('\n');
    expect(await rules(md)).toEqual(['1:no-raw-html', '3:no-raw-html', '5:no-raw-html', '6:no-raw-html', '7:no-raw-html', '4:no-script-url']);
  });

  it('closes the gaps ngdpbase\'s deny-list leaves: style, base, meta, form, link, comments — any tag at all', async () => {
    for (const bad of ['<style>body{}</style>', '<base href="https://evil/">', '<meta http-equiv="refresh" content="0;url=https://evil">', '<form action="https://evil">', '<link rel="stylesheet" href="x">', '<!-- hidden -->', '<div>plain</div>', '</p>']) {
      expect(await rules(bad), bad).toEqual(['1:no-raw-html']);
    }
  });

  it('refuses links and images that run script or smuggle content, in every link form', async () => {
    expect(await rules('[a](JavaScript:alert(1))')).toEqual(['1:no-script-url']);
    expect(await rules('![a]( data:image/svg+xml,<svg onload=x>)')).toEqual(['1:no-raw-html', '1:no-script-url']);
    expect(await rules('[a](vbscript:msgbox)')).toEqual(['1:no-script-url']);
    expect(await rules('[ref]: javascript:alert(1)')).toEqual(['1:no-script-url']);
    expect(await rules('<javascript:alert(1)>')).toEqual(['1:no-script-url']);
    expect(await rules('[a](file:///etc/passwd)')).toEqual(['1:no-script-url']);
  });

  it('keeps ordinary markdown: autolinks, web links, emphasis, lists — a person\'s words are not HTML', async () => {
    const md = 'Saw Dr Smith <https://example.org/clinic> and <nurse@example.org>.\n\n- **BP** 120 < 140 and 3 > 2\n- [portal](https://mychart.example.org)\n\n![scan](https://example.org/x.png)';
    expect(await rules(md)).toEqual([]);
  });

  it('code is exempt — fenced (``` and ~~~), indented and `backticks` — so HTML can be documented (#632)', async () => {
    const md = ['Use `<br>` sparingly.', '```html', '<script>documented</script>', '```', '~~~~', '<iframe>', '~~~~', '', '    <div>indented</div>', 'but <b>this</b> is live'].join('\n');
    expect(await rules(md)).toEqual(['10:no-raw-html']); // the only live tag, on its own line number
  });

  it('assertSavable is a 400 naming every line, with the errors for a form to mark', async () => {
    await expect(filters.assertSavable('ok\n<b>x</b>\n[y](javascript:z)')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^line 2: HTML is not allowed.*; line 3: A link or image may not point at javascript:/),
      extra: { errors: [expect.objectContaining({ rule: 'no-raw-html', line: 2 }), expect.objectContaining({ rule: 'no-script-url', line: 3 })] },
    });
    await expect(filters.assertSavable('**fine**')).resolves.toBeUndefined();
  });

  it('max-content-length, when set, refuses longer text', async () => {
    await boot({ 'yourphr.filters.security.max-content-length': 10 });
    expect(await rules('0123456789x')).toEqual(['undefined:max-content-length']);
    expect(await rules('short')).toEqual([]);
  });
});

describe('render path — CommonMark, raw HTML off (yourphr#775)', () => {
  // Examples from the CommonMark spec 0.31.2 (https://spec.commonmark.org/0.31.2/), cited by number.
  // Asserted against the SPEC's expected output, not the parser's say-so.
  const SPEC: [number, string, string][] = [
    [350, '*foo bar*\n', '<p><em>foo bar</em></p>\n'],
    [42, '***\n---\n___\n', '<hr />\n<hr />\n<hr />\n'],
    [62, '# foo\n## foo\n### foo\n', '<h1>foo</h1>\n<h2>foo</h2>\n<h3>foo</h3>\n'],
    [301, '- foo\n- bar\n+ baz\n', '<ul>\n<li>foo</li>\n<li>bar</li>\n</ul>\n<ul>\n<li>baz</li>\n</ul>\n'],
    [328, '`foo`\n', '<p><code>foo</code></p>\n'],
    [482, '[link](/uri "title")\n', '<p><a href="/uri" title="title">link</a></p>\n'],
    [594, '<http://foo.bar.baz>\n', '<p><a href="http://foo.bar.baz">http://foo.bar.baz</a></p>\n'],
    [119, '```\n<\n >\n```\n', '<pre><code>&lt;\n &gt;\n</code></pre>\n'],
  ];
  for (const [n, md, html] of SPEC) {
    it(`spec example ${n}`, async () => { expect(await filters.render(md)).toBe(html); });
  }

  it('raw HTML that reaches render (an operator\'s file, older text) is shown as text, never run', async () => {
    const html = await filters.render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a javascript: link is not rendered as a link', async () => {
    expect(await filters.render('[x](javascript:alert(1))')).not.toContain('href="javascript:');
  });

  it('GFM tables render — the shipped legal documents use them', async () => {
    expect(await filters.render('| a | b |\n|---|---|\n| 1 | 2 |\n')).toContain('<table>');
  });

  it('GFM strikethrough is NOT on: CommonMark, plus tables only', async () => {
    expect(await filters.render('~~x~~')).toBe('<p>~~x~~</p>\n');
  });
});

describe('FilterManager — one owner, filters registered not hardcoded', () => {
  it('registers the built-in SecurityFilter through the contributed path', () => {
    expect(filters.getFilters().map((f) => f.filterId)).toEqual(['security']);
    expect(lines).toContain('filters: security registered');
  });

  it('a contributed filter runs in its phase and in priority order', async () => {
    class Shout extends BaseFilter { readonly filterId = 'shout'; constructor() { super(50, 'html'); } async process(c: string) { return c.toUpperCase(); } }
    class Tag extends BaseFilter { readonly filterId = 'tag'; constructor() { super(500, 'markup'); } async process(c: string) { return `${c} (checked)`; } }
    expect(await filters.registerFilter(new Shout())).toBe(true);
    expect(await filters.registerFilter(new Tag())).toBe(true);
    expect(filters.getFilters().map((f) => f.filterId)).toEqual(['security', 'tag', 'shout']);
    expect(await filters.render('hello')).toBe('<P>HELLO (CHECKED)</P>\n');
  });

  it('block-on-save off: no save rules registered; the render path still has raw HTML off', async () => {
    await boot({ 'yourphr.filters.security.block-on-save': false });
    expect(await filters.collectErrors('<script>x</script>')).toEqual([]);
    expect(await filters.render('<b>x</b>')).not.toContain('<b>');
  });

  it('the whole pipeline off: nothing registers, and says so', async () => {
    await boot({ 'yourphr.filters.enabled': false });
    expect(await filters.registerFilter(new SecurityFilter())).toBe(false);
    expect(await filters.collectErrors('<script>x</script>')).toEqual([]);
    expect(lines[0]).toContain('pipeline disabled by configuration');
  });
});
