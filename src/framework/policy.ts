/**
 * The authorization vocabulary that stays in code (yourphr#620, narrowed by yourphr#623).
 *
 * The permission REGISTRY and the ROLE definitions are no longer here — they are two keys in the
 * shipped configuration (`auth.permissions.definitions`, `auth.roles.definitions`), read from the
 * merged configuration at startup by `PolicyManager`. What remains is the shape of the idea, and
 * the two rules that are not the operator's to change:
 *
 *   - A permission is `{target}-{action}`. SCOPE NEVER GOES IN A NAME — not
 *     `record-read-patient-123`, not `guardian-of-alice`. Both explode combinatorially and neither
 *     can be listed in a registry. Whose records is the compartment axis (`user_id` today), carried
 *     by the ASSIGNMENT, never by the permission or the role.
 *   - A role is a FLAT list. No roles inside roles, no ordering, ADDITIVE ONLY — every entry grants
 *     and none takes away. "Everything except" is not expressible on purpose; that question belongs
 *     to the resource tier (confidentiality, the provenance lock), which is not built.
 *
 * Both are enforced by `PolicyManager` when it reads the configuration, so an operator cannot write
 * a name that breaks them and have it quietly accepted.
 */

/** `{target}-{action}` — the enforcement contract. What each one means lives in configuration. */
export type Permission = string;
