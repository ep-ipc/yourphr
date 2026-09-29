/**
 * The content-filter contract (yourphr#775), ported from ngdpbase's `BaseFilter`
 * (src/parsers/filters/BaseFilter.ts) and trimmed to what this stack uses.
 *
 * A filter declares its PHASE — `markup` sees the source a person wrote, `html` sees the rendered
 * output — and its PRIORITY (0–1000, higher runs first). It takes part in either path or both:
 *
 *   SAVE    collectErrors(content)  → violations that refuse the save, each naming its line
 *   RENDER  process(content)        → the content transformed for display, in its phase
 *
 * Built-ins and an addon's filters register the same way, through FilterManager.registerFilter().
 */

export type FilterPhase = 'markup' | 'html';

/** One reason a save is refused — ngdpbase's FilterValidationError. */
export interface FilterValidationError {
  filterId: string;
  rule: string;
  severity: 'error';
  message: string;
  /** 1-based line of the source the author must change. */
  line?: number;
}

export abstract class BaseFilter {
  /** Stable name, reported with every error it raises. */
  abstract readonly filterId: string;
  /** 0–1000; higher runs first. */
  readonly priority: number;
  readonly phase: FilterPhase;
  private enabled = true;

  constructor(priority = 100, phase: FilterPhase = 'markup') {
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new Error(`filter priority must be 0–1000, got ${priority}`);
    this.priority = priority;
    this.phase = phase;
  }

  /** Called once when registered. */
  async initialize(): Promise<void> { /* most filters need nothing */ }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Save-time violations. A filter that has no save rules returns none. */
  async collectErrors(_content: string): Promise<FilterValidationError[]> { return []; }

  /** Render-time transform in this filter's phase. The identity unless a filter overrides it. */
  async process(content: string): Promise<string> { return content; }
}
