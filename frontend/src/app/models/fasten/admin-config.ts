// Admin configuration screen (#458). Mirrors backend/pkg/web/handler/admin_config.go.

export interface ConfigEntry {
  key: string;
  // Placeholder text when masked is true — the real value is never sent with the listing.
  value: any;
  masked: boolean;
  // Where the effective value comes from. 'environment' outranks the config store on restart,
  // so such a key is not editable from the screen.
  source: 'custom' | 'default' | 'environment';
  // Readable by anonymous callers via /api/instance/public.
  public: boolean;
  // Added to the public array beyond the shipped set by this instance.
  promoted: boolean;
  // The shipped value, so "reset" is predictable. Masked on the same rule as value.
  default: any;
  // True when the value comes from the process environment, which outranks the config store on
  // restart — such a key cannot be edited here.
  from_env: boolean;
  // The environment variable that governs this key, whether or not it is currently set.
  env_var: string;
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
