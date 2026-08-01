/** GET /api/secure/admin/metrics — Admin Dashboard Metrics card (#441). */
export interface SyncJobSummary {
  outcome?: string;
  duration_ms?: number;
  total_resources?: number;
  by_type?: Record<string, number>;
  environment?: string;
  platform_type?: string;
  error_message?: string;
}

export interface RecentSyncJob {
  id: string;
  job_status: string;
  created_at?: string;
  done_time?: string;
  source_id?: string;
  summary?: SyncJobSummary | null;
}

export interface MetricsProcessSnapshot {
  jobs_total?: Record<string, number>;
  resources_total?: Record<string, number>;
  duration_count?: number;
  duration_sum_seconds?: number;
}

export interface AdminMetrics {
  scrape_enabled: boolean;
  scrape_addr?: string;
  scrape_path: string;
  scrape_note: string;
  process: MetricsProcessSnapshot;
  recent_jobs: RecentSyncJob[];
}
