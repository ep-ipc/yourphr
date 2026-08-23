/**
 * The account's rules (yourphr#596, #614): which providers need the legal consent, and which
 * routes count as an access of a person's record. Pure functions — the consent is the users
 * provider's, the access log is the Audit manager's.
 */
export type { AccessEvent } from '../framework/providers/BaseAuditProvider.js';

/** Go's rule for which providers need the legal consent before connecting: the Medicare family. */
export function providerRequiresLegalConsent(display: string, fhirBaseUrl: string, platformType: string): boolean {
  const blob = `${display}\n${fhirBaseUrl}\n${platformType}`.toLowerCase();
  return ['medicare', 'blue button', 'bluebutton', 'blue-button', 'cms.gov', 'cms.hhs.gov'].some((m) => blob.includes(m));
}

/** Go's accessLogCategories, for the routes this stack serves. A path not listed is not an access. */
export function accessCategoryFor(pathname: string): string | undefined {
  const exact: Record<string, string> = {
    '/api/secure/summary': 'Summary',
    '/api/secure/summary/ips': 'Summary (IPS)',
    '/api/secure/medications/reconciled': 'Medications',
    '/api/secure/conditions/reconciled': 'Conditions',
    '/api/secure/allergies/classified': 'Allergies',
    '/api/secure/immunizations/classified': 'Immunizations',
    '/api/secure/resources/recent': 'Record search',
    '/api/secure/resource/fhir': 'Records (FHIR)',
  };
  if (exact[pathname]) return exact[pathname];
  if (/^\/api\/secure\/resource\/fhir\/[^/]+\/[^/]+$/.test(pathname)) return 'Records (FHIR)';
  if (/^\/api\/secure\/source\/[^/]+\/export$/.test(pathname)) return 'Full export';
  return undefined;
}

/**
 * Go's LegalConsentStatus, from the stored timestamp ('' = not accepted). The account page reads
 * these exact field names, so the shape is Go's rather than this stack's preference (yourphr#619).
 */
export function consentStatus(acceptedAt: string): Record<string, unknown> {
  return {
    accepted: acceptedAt !== '',
    ...(acceptedAt !== '' ? { accepted_at: acceptedAt } : {}),
    privacy_policy_url: '/privacy',
    terms_of_service_url: '/terms',
  };
}

/** The timestamp Go stamps a consent with: ISO 8601, whole seconds. */
export function consentNow(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
