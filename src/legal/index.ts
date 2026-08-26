/**
 * Legal documents (yourphr#596; the product's #463): the Privacy Policy and Terms of Service every
 * instance serves at GET /api/legal/:kind, in Go's Document shape. The shipped text is the default;
 * an operator replaces it by dropping <data>/config/privacy-policy.md or terms-of-service.md in
 * place — the same file names and the same rule as Go: an EMPTY override is an error, not a
 * silent fallback to text the operator deliberately replaced. The digest is sha256 over the
 * newline-normalised Markdown, the value consent records are meant to pin (#465).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { SHIPPED_PRIVACY_POLICY, SHIPPED_TERMS_OF_SERVICE } from './shipped.js';

export type LegalKind = 'privacy' | 'terms';
export type LegalSource = 'shipped' | 'operator';

export interface LegalDocument {
  kind: LegalKind;
  html: string;
  markdown: string;
  digest: string;
  source: LegalSource;
  path?: string;
}

const OVERRIDE_FILE: Record<LegalKind, string> = { privacy: 'privacy-policy.md', terms: 'terms-of-service.md' };

export function parseLegalKind(value: string): LegalKind | undefined {
  const v = value.trim().toLowerCase();
  return v === 'privacy' || v === 'terms' ? v : undefined;
}

export function legalDigest(markdown: string): string {
  return 'sha256:' + createHash('sha256').update(markdown.replace(/\r\n/g, '\n')).digest('hex');
}

export function loadLegalDocument(dataDir: string, kind: LegalKind): LegalDocument {
  const path = join(dataDir, 'config', OVERRIDE_FILE[kind]);
  let markdown: string;
  let source: LegalSource;
  if (existsSync(path)) {
    markdown = readFileSync(path, 'utf8');
    if (markdown.trim() === '') {
      throw new Error(`legal override ${path} is empty; remove the file to use the shipped document`);
    }
    source = 'operator';
  } else {
    markdown = kind === 'terms' ? SHIPPED_TERMS_OF_SERVICE : SHIPPED_PRIVACY_POLICY;
    source = 'shipped';
  }
  return {
    kind,
    html: marked.parse(markdown, { async: false }) as string,
    markdown,
    digest: legalDigest(markdown),
    source,
    ...(source === 'operator' ? { path } : {}),
  };
}
