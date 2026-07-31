// Per-user Privacy Policy + Terms of Service opt-in (#427).
export interface LegalConsentStatus {
  accepted: boolean;
  accepted_at?: string;
  privacy_policy_url: string;
  terms_of_service_url: string;
  /** Present on revoke response only. */
  medicare_sources_disconnected?: number;
}
