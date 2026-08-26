/**
 * Provider-catalog storage (yourphr#613): what this instance CAN connect to — the admin's instance
 * configuration. The provider stores rows; every rule (write-only secret, URL refusals, seeding,
 * who may read) is the manager's. The secret leaves a row through `clientSecretFor` only.
 */
export type ProviderEnvironment = 'sandbox' | 'production';

/** Every column but the id — what a write carries. */
export interface CatalogFields {
  display: string;
  environment: ProviderEnvironment;
  fhirBaseUrl: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  authorizeUrlOverride: string;
  /**
   * Go's four presentation/policy fields (yourphr#603): platform_type ('ehr' by default), a logo
   * URL, the consent policy ('required' | 'skip') and the pre-connect profile ('auto' | 'none' |
   * 'generic' | 'medicare'). '' = unstated; the policy resolves Go's defaults at read time.
   */
  platformType: string;
  brandLogoUrl: string;
  consentPolicy: string;
  preConnectProfile: string;
}

/** A row as it is read: the secret is never on it (yourphr#286) — only whether there is one. */
export interface CatalogEntry extends Omit<CatalogFields, 'clientSecret'> {
  id: number;
  hasClientSecret: boolean;
}

export abstract class BaseCatalogProvider {
  abstract initialize(): Promise<void>;
  abstract create(fields: CatalogFields): Promise<CatalogEntry>;
  /** Full replacement; undefined when there is no such row. */
  abstract update(id: number, fields: CatalogFields): Promise<CatalogEntry | undefined>;
  abstract remove(id: number): Promise<boolean>;
  abstract byId(id: number): Promise<CatalogEntry | undefined>;
  abstract byDisplay(display: string): Promise<CatalogEntry | undefined>;
  /** Every entry, by display. */
  abstract list(): Promise<CatalogEntry[]>;
  /** The secret, for the SERVER-SIDE token exchange only. '' when there is none. */
  abstract clientSecretFor(id: number): Promise<string>;
}
