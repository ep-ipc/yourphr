/**
 * The save-time security rules for markdown a person writes (yourphr#775), ported from ngdpbase's
 * `SecurityFilter.collectErrors` — `blankOutCode`, then one error per offending line, every one of
 * them at once so an author is not sent round the loop once per problem.
 *
 * Deliberately STRICTER than ngdpbase, as #775 decided. Upstream enumerates dangerous tags because
 * wiki authors are trusted and a render-time allow-list catches the rest. Here the authors are
 * patients writing free text, and a note can travel into the exported summary — a self-contained
 * HTML file opened outside the product, where no render filter runs. So instead of a deny-list with
 * gaps (`<style>`, `<base>`, `<form>`, `data:` …) the rule is simpler: markdown is the language, and
 * HTML is not part of it.
 *
 *   - no-raw-html   any raw HTML tag or comment outside code
 *   - no-script-url a link or image whose destination runs script or smuggles content
 *                   (javascript:, vbscript:, data:, file:)
 *
 * Code is exempt, exactly as upstream: fenced blocks, indented blocks and backtick spans are blanked
 * before the rules run (keeping line numbers), because code renders as escaped text and cannot
 * execute — which is what lets the help pages (#632) document HTML at all.
 */
import { BaseFilter, type FilterValidationError } from './BaseFilter.js';

const RULES: { rule: string; pattern: RegExp; message: string }[] = [
  {
    rule: 'no-raw-html',
    // An HTML tag (open, close or self-closing) or a comment. A CommonMark autolink —
    // <https://…> or <someone@example.org> — is not a tag: a scheme's colon or an @ follows the name.
    pattern: /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])|<!--/,
    message: 'HTML is not allowed — write it as markdown, or put an example of HTML in `backticks` or a code block',
  },
  {
    rule: 'no-script-url',
    // Inline links/images `](dest)`, autolinks `<dest>`, and reference definitions `[x]: dest`.
    pattern: /(?:\]\(\s*<?|<|^\s*\[[^\]]+\]:\s*<?)\s*(?:javascript|vbscript|data|file):/i,
    message: 'A link or image may not point at javascript:, vbscript:, data: or file: — use a web address',
  },
];

export class SecurityFilter extends BaseFilter {
  readonly filterId = 'security';

  constructor(private readonly maxContentLength = 0) {
    super(900, 'markup');
  }

  /**
   * Code blanked, line count kept: fenced blocks become as many newlines as they held, indented code
   * lines become empty, backtick spans vanish. ngdpbase's blankOutCode, plus `~~~` fences and fences
   * longer than three, which CommonMark allows.
   */
  static blankOutCode(content: string): string {
    return content
      .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, (block) => '\n'.repeat(block.split('\n').length - 1))
      .replace(/^(?: {4}|\t).*$/gm, '')
      .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => span.replace(/[^\n]/g, ''));
  }

  async collectErrors(content: string): Promise<FilterValidationError[]> {
    if (!content) return [];
    const errors: FilterValidationError[] = [];
    if (this.maxContentLength > 0 && content.length > this.maxContentLength) {
      errors.push({ filterId: this.filterId, rule: 'max-content-length', severity: 'error', message: `The text is longer than ${this.maxContentLength} characters` });
    }
    const lines = SecurityFilter.blankOutCode(content).split('\n');
    for (const { rule, pattern, message } of RULES) {
      lines.forEach((text, index) => {
        if (pattern.test(text)) errors.push({ filterId: this.filterId, rule, severity: 'error', message, line: index + 1 });
      });
    }
    return errors;
  }
}
