// One legal document as served by this instance (#463).
// Mirrors backend/pkg/legal.Document.
export interface LegalDocument {
  kind: 'privacy' | 'terms';
  // Rendered HTML. Bound with [innerHTML], which Angular sanitizes — an operator's own Markdown
  // is rendered, but any script in it is stripped.
  html: string;
  // "sha256:<hex>" over the Markdown source. Identifies exactly which text was shown.
  digest: string;
  // 'shipped' = the text embedded in this release; 'operator' = this operator's own file.
  source: 'shipped' | 'operator';
  // Where the operator's file lives, when source is 'operator'.
  path?: string;
}
