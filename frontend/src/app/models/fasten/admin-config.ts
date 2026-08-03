// Admin configuration screen (#458). Mirrors backend/pkg/web/handler/admin_config.go.

export interface ConfigEntry {
  key: string;
  // Placeholder text when masked is true — the real value is never sent with the listing.
  value: any;
  masked: boolean;
  // 'custom' when this instance overrode the shipped value, otherwise 'default'.
  source: 'custom' | 'default';
  // Readable by anonymous callers via /api/instance/public.
  public: boolean;
  // Added to the public array beyond the shipped set by this instance.
  promoted: boolean;
  // The shipped value, so "reset" is predictable. Masked on the same rule as value.
  default: any;
}

export interface AdminConfig {
  entries: ConfigEntry[];
  custom_config_path: string;
  warnings: string[];
}

export interface RevealedConfigValue {
  key: string;
  value: any;
  default: any;
}
