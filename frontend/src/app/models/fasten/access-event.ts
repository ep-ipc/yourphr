// One row of the patient-visible access log (#563): who accessed which category of your records on
// which day, how many times. Aggregated server-side; deliberately carries no IP or user-agent.
export interface AccessEvent {
  actor_username: string
  category: string
  // UTC calendar day, "2026-08-19"
  day: string
  count: number
  first_at: string
  last_at: string
}
