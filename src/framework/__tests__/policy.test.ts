import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS, ROLES, isPermission, permissionsFor } from '../policy.js';

describe('policy — what may be done, as data (yourphr#620)', () => {
  it('the registry derives {target}-{action} names and nothing else is a permission', () => {
    expect(ALL_PERMISSIONS).toEqual(['admin-read', 'admin-system', 'user-create', 'user-edit', 'user-read']);
    expect(isPermission('admin-read')).toBe(true);
    expect(isPermission('admin-raed')).toBe(false);
    expect(isPermission('record-share')).toBe(false); // in the doc's first cut; no door here yet, so not claimed
    for (const p of ALL_PERMISSIONS) {
      const [target, action, ...rest] = p.split('-');
      expect(rest).toEqual([]); // scope never goes in a name
      expect(PERMISSIONS[target!]).toContain(action!);
    }
  });

  it('reading is split from changing, so a role can see an admin screen without being able to alter the instance', () => {
    expect(PERMISSIONS['admin']).toEqual(['read', 'system']);
    // The doc's demo-admin (yourphr#494), expressed: every admin screen, changes nothing, no user list.
    const demoAdmin: readonly string[] = ['admin-read'];
    expect(demoAdmin.every((p) => isPermission(p))).toBe(true);
    expect(demoAdmin).not.toContain('admin-system');
    expect(demoAdmin).not.toContain('user-read');
  });

  it('roles are flat, additive, system-flagged lists — and an unknown role grants nothing', () => {
    expect(permissionsFor('admin')).toEqual(ALL_PERMISSIONS);
    expect(permissionsFor('user')).toEqual([]);      // a member's own records are ownership, not a permission
    expect(permissionsFor('anonymous')).toEqual([]); // a role with an empty list, not an `if` at the edge
    expect(permissionsFor('nonexistent')).toEqual([]);
    expect(permissionsFor('ADMIN')).toEqual([]);     // a typo must not widen anyone's powers
    for (const role of Object.values(ROLES)) {
      expect(role.system).toBe(true);
      expect(role.permissions.every((p) => isPermission(p))).toBe(true);
    }
  });
});
