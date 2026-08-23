/**
 * Policy as data (yourphr#620): what may be done, written down in one place instead of decided by
 * `requireAdmin()` at eighteen call sites. The doc's section is blunt about why — a third role
 * means revisiting every site, each an independent chance to be wrong — and the third role is
 * already named: `demo-admin`, which sees every admin screen, changes nothing, and cannot see the
 * user list (the public demo, yourphr#494). Under this model that role is a list of strings.
 *
 * Two rules from the doc are load-bearing here:
 *
 *   - A role is a FLAT list of permissions. No roles inside roles, no ordering, ADDITIVE ONLY —
 *     every entry grants and none takes away. "Everything except" is not expressible on purpose;
 *     that question belongs to the resource tier (confidentiality, the provenance lock), which is
 *     deliberately not in this file.
 *   - `anonymous` is a role with an empty list, not an `if` somewhere. The unauthenticated path
 *     goes through the same evaluator as every other, so the special case cannot hide there.
 *
 * SCOPE NEVER GOES IN A NAME. Not `record-read-patient-123`, not `guardian-of-alice`. Whose
 * records is the compartment axis (`user_id` today), and it is carried by the ASSIGNMENT, never by
 * the permission or the role. That axis is not in this file either.
 */

/**
 * The registry: `{target}-{action}`, in the doc's vocabulary, carrying only what this stack has a
 * door for. Names from the doc's first cut with no door yet — `record-share`, `admin-roles`, the
 * `source-*` family — are deliberately ABSENT: an entry that protects nothing is exactly the
 * orphan the drift check exists to catch, and listing an aspiration as policy makes the registry
 * lie about what is enforced.
 */
export const PERMISSIONS: Record<string, readonly string[]> = {
  /** The operator's screens: reading their data, and changing what the instance is. */
  admin: ['read', 'system'],
  /** The Users page (yourphr#604). Reading the roster is split from changing it. */
  user: ['create', 'read', 'edit'],
};

export type Permission = string;

/** Every permission the registry defines, as `{target}-{action}`. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.entries(PERMISSIONS)
  .flatMap(([target, actions]) => actions.map((action) => `${target}-${action}`))
  .sort();

export function isPermission(value: string): boolean {
  return ALL_PERMISSIONS.includes(value);
}

/** A role: a flat permission list, and whether the operator may redefine it. */
export interface RoleDefinition {
  /** Built-in roles are not the operator's to redefine (ngdpbase's `issystem`). */
  readonly system: boolean;
  readonly permissions: readonly Permission[];
}

/**
 * The roles this stack ships. `user` and `anonymous` are EMPTY on purpose and it is not an
 * oversight: every member action today is gated by ownership ("is this your record"), not by a
 * permission. Ownership is the compartment axis, and it stays out of the flat list — the doc's
 * point that a role says what may be done, never whose records.
 */
export const ROLES: Record<string, RoleDefinition> = {
  admin: { system: true, permissions: ALL_PERMISSIONS },
  user: { system: true, permissions: [] },
  anonymous: { system: true, permissions: [] },
};

/** What a role may do. An unknown role gets nothing — a typo must not widen anyone's powers. */
export function permissionsFor(role: string): readonly Permission[] {
  return ROLES[role]?.permissions ?? [];
}
