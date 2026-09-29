/**
 * FilterManager — the one owner of the content-filter pipeline (yourphr#775), ported from ngdpbase's
 * FilterManager (ngdpbase#1117). Jim, 2026-09-29: "create a new FilterManager".
 *
 * Markdown a person writes goes through here on BOTH paths, so there is one rule and one owner:
 *
 *     SAVE     a feature that stores markdown → assertSavable() → every filter's collectErrors()
 *     RENDER   anything that shows markdown   → render()        → markup filters → markdown-it → html filters
 *
 * The save path REFUSES, it does not silently strip: this product keeps what a person wrote, or says
 * which lines it cannot keep and why. The render path is the second line.
 *
 * The dialect is CommonMark (Jim, 2026-09-25), parsed by markdown-it as ngdpbase parses — its
 * `commonmark` preset, with GFM tables switched on because the shipped legal documents use them. Raw
 * HTML is OFF at render: whatever reaches render() that save-time checks did not see (a file an
 * operator dropped in, text stored before this existed) is shown as text, never run. Links that
 * would run script are dropped by markdown-it's validateLink.
 *
 * Filters are registered, not hardcoded — the built-in SecurityFilter goes through registerFilter(),
 * the path an addon uses. Ordering is each filter's priority, higher first.
 *
 * Configuration keeps ngdpbase's meanings under the yourphr. prefix:
 *   yourphr.filters.enabled                       the pipeline at all
 *   yourphr.filters.security.block-on-save        refuse unsafe markdown at save
 *   yourphr.filters.security.max-content-length   0 = no limit
 */
import MarkdownIt from 'markdown-it';
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import { ApiError } from '../ApiContext.js';
import { type BaseFilter, type FilterValidationError } from '../filters/BaseFilter.js';
import { SecurityFilter } from '../filters/SecurityFilter.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    filters: FilterManager;
  }
}

export class FilterManager extends BaseManager {
  readonly name = 'filters';
  override readonly dependsOn = ['configuration'] as const;
  private filters: BaseFilter[] = [];
  private pipelineEnabled = true;
  private readonly markdown = new MarkdownIt('commonmark', { html: false }).enable('table');

  constructor(engine: Engine, private readonly log: (line: string) => void = () => undefined) {
    super(engine);
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    const c = this.engine.managers.configuration;
    this.pipelineEnabled = c.getBool('yourphr.filters.enabled');
    if (!this.pipelineEnabled) {
      this.log('filters: pipeline disabled by configuration (yourphr.filters.enabled) — markdown is saved unchecked');
      return;
    }
    if (c.getBool('yourphr.filters.security.block-on-save')) {
      await this.registerFilter(new SecurityFilter(c.getInt('yourphr.filters.security.max-content-length')));
    }
    this.log(`filters: ${this.filters.map((f) => f.filterId).join(', ') || 'none'} registered`);
  }

  /**
   * THE contributed path: built-ins and an addon's filters alike. Returns false (and logs) when the
   * pipeline is off or the filter fails to initialise — one broken filter never takes the rest down.
   */
  async registerFilter(filter: BaseFilter): Promise<boolean> {
    if (!this.pipelineEnabled) {
      this.log(`filters: cannot register ${filter.filterId}: pipeline disabled`);
      return false;
    }
    try {
      await filter.initialize();
    } catch (err) {
      this.log(`filters: ${filter.filterId} failed to initialise: ${(err as Error).message}`);
      return false;
    }
    this.filters = [...this.filters.filter((f) => f.filterId !== filter.filterId), filter].sort((a, b) => b.priority - a.priority);
    return true;
  }

  /** The registered filters, highest priority first. */
  getFilters(): readonly BaseFilter[] {
    return this.filters;
  }

  /** Every save-time violation from every enabled filter, in priority order. */
  async collectErrors(content: string): Promise<FilterValidationError[]> {
    if (!this.pipelineEnabled || !content) return [];
    const all: FilterValidationError[] = [];
    for (const filter of this.filters) {
      if (filter.isEnabled()) all.push(...await filter.collectErrors(content));
    }
    return all;
  }

  /**
   * The write path: resolves when `content` may be stored, otherwise a 400 naming every offending
   * line (`errors` in the response carries them all for a form to mark).
   */
  async assertSavable(content: string): Promise<void> {
    const errors = await this.collectErrors(content);
    if (errors.length === 0) return;
    const where = (e: FilterValidationError): string => (e.line ? `line ${e.line}: ` : '');
    throw new ApiError(400, errors.map((e) => `${where(e)}${e.message}`).join('; '), { errors });
  }

  /** The render path: markup-phase filters, CommonMark to HTML (raw HTML off), then html-phase filters. */
  async render(markdownSource: string): Promise<string> {
    let content = markdownSource;
    for (const filter of this.filters) if (filter.isEnabled() && filter.phase === 'markup') content = await filter.process(content);
    let html = this.markdown.render(content);
    for (const filter of this.filters) if (filter.isEnabled() && filter.phase === 'html') html = await filter.process(html);
    return html;
  }

  /** Nothing of its own to back up: the rules are code and configuration. */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* nothing to bring back */ }
}
