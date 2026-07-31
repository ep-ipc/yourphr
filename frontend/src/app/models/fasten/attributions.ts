/**
 * Third-party attribution notices — single registry for all partners (#428+).
 * Docs: docs/Attributions.md
 *
 * Add new partners here; do not hardcode one-off notices in random components.
 */

export type AttributionContext =
  | 'attributions-page'
  | 'medicare-connect'
  | 'footer';

export interface AttributionNotice {
  /** Stable id (e.g. cms-blue-button). */
  id: string;
  /** Short title for headings / cards. */
  title: string;
  /** Exact required wording (preserve legal text). */
  body: string;
  /** Optional external policy / terms URL. */
  sourceUrl?: string;
  /** Where this notice should appear in the product. */
  contexts: AttributionContext[];
}

/** Canonical list — append new third-party notices here. */
export const ATTRIBUTIONS: AttributionNotice[] = [
  {
    id: 'cms-blue-button',
    title: 'CMS Blue Button APIs',
    body:
      'This product uses the Blue Button APIs but is not endorsed or certified by the Centers for Medicare & Medicaid Services or the U.S. Department of Health and Human Services.',
    sourceUrl: 'https://bluebutton.cms.gov/terms/',
    contexts: ['attributions-page', 'medicare-connect'],
  },
];

export function attributionsForContext(ctx: AttributionContext): AttributionNotice[] {
  return ATTRIBUTIONS.filter((a) => a.contexts.includes(ctx));
}

export function attributionById(id: string): AttributionNotice | undefined {
  return ATTRIBUTIONS.find((a) => a.id === id);
}
