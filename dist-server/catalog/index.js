// ---------------------------------------------------------------------------
// Go's connection policy (yourphr#603), resolved at read time
/** Go's markers for the Medicare family — the providers whose connection needs the legal consent. */
export function isMedicareClass(display, fhirBaseUrl, platformType) {
    const blob = `${display}\n${fhirBaseUrl}\n${platformType}`.toLowerCase();
    return ['medicare', 'blue button', 'bluebutton', 'blue-button', 'cms.gov', 'cms.hhs.gov'].some((m) => blob.includes(m));
}
export function normalizeConsentPolicy(v) {
    const s = (v ?? '').trim().toLowerCase();
    return s === 'skip' ? 'skip' : s === 'required' ? 'required' : '';
}
export function normalizePreConnectProfile(v) {
    const s = (v ?? '').trim().toLowerCase();
    return s === 'none' || s === 'generic' || s === 'medicare' || s === 'auto' ? s : '';
}
/** Go's ResolveConnectionPolicy: consent required unless 'skip'; profile 'auto' = medicare or generic. */
export function connectionPolicy(entry) {
    const medicareClass = isMedicareClass(entry.display, entry.fhirBaseUrl, entry.platformType);
    const consent = normalizeConsentPolicy(entry.consentPolicy) || 'required';
    let pre = normalizePreConnectProfile(entry.preConnectProfile);
    if (pre === '' || pre === 'auto')
        pre = medicareClass ? 'medicare' : 'generic';
    return { requiresUserConsent: consent !== 'skip', preConnectProfile: pre, medicareClass };
}
/** Go's PatientFacingSourceDisplay: a production Medicare-family provider is shown as "Medicare". */
export function patientFacingDisplay(entry) {
    if (entry.environment === 'sandbox')
        return entry.display;
    return isMedicareClass(entry.display, entry.fhirBaseUrl, entry.platformType) ? 'Medicare' : entry.display;
}
/** Go's ConnectableProvider shape. */
export function connectableShape(entry) {
    const policy = connectionPolicy(entry);
    return {
        id: String(entry.id),
        display: patientFacingDisplay(entry),
        brand_logo_url: entry.brandLogoUrl,
        requires_user_consent: policy.requiresUserConsent,
        pre_connect_profile: policy.preConnectProfile,
        medicare_class: policy.medicareClass,
        requires_legal_consent: policy.requiresUserConsent,
    };
}
/** Go's ProviderCatalogEntry shape, as the admin page reads and writes it. The secret never leaves. */
export function catalogEntryShape(entry) {
    return {
        id: String(entry.id),
        display: entry.display,
        environment: entry.environment,
        api_endpoint_base_url: entry.fhirBaseUrl,
        scopes: entry.scopes,
        platform_type: entry.platformType || 'ehr',
        brand_logo_url: entry.brandLogoUrl,
        enabled: entry.enabled,
        client_id: entry.clientId,
        has_client_secret: entry.hasClientSecret,
        authorize_url_override: entry.authorizeUrlOverride,
        consent_policy: entry.consentPolicy || 'required',
        pre_connect_profile: entry.preConnectProfile || 'auto',
    };
}
//# sourceMappingURL=index.js.map