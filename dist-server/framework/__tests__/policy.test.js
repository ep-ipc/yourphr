import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine.js';
import { ApiContext } from '../ApiContext.js';
import { ConfigurationManager } from '../ConfigurationManager.js';
import { PolicyManager, PERMISSIONS_KEY, ROLES_KEY } from '../managers/PolicyManager.js';
import { FakeConfigProvider } from '../providers/__tests__/FakeConfigProvider.js';
function boot(custom = {}) {
    const engine = new Engine();
    const configuration = new ConfigurationManager(engine, new FakeConfigProvider(custom), { env: {} });
    engine.register('configuration', configuration);
    const policy = new PolicyManager(engine);
    engine.register('policy', policy);
    return { engine, policy, configuration };
}
describe('PolicyManager — permissions and roles read from the merged configuration (yourphr#623)', () => {
    it('reads the shipped registry and roles', () => {
        const { policy } = boot();
        expect(policy.registry().map((p) => p.permission).sort())
            .toEqual(['admin-read', 'admin-system', 'user-create', 'user-edit', 'user-read']);
        expect(policy.roleDefinitions().map((r) => r.role)).toEqual(['admin', 'user', 'anonymous']);
        expect(policy.permissionsFor('admin')).toContain('admin-system');
        expect(policy.permissionsFor('user')).toEqual([]); // ownership, not a permission
        expect(policy.permissionsFor('anonymous')).toEqual([]); // a role, not an `if` at the edge
        expect(policy.permissionsFor('nonexistent')).toEqual([]); // a typo must not widen anyone's powers
    });
    it('splits {target}-{action} and carries the operator-facing description', () => {
        const { policy } = boot();
        const adminRead = policy.registry().find((p) => p.permission === 'admin-read');
        expect(adminRead).toMatchObject({ target: 'admin', action: 'read' });
        expect(adminRead?.description).toContain('operator screens');
    });
    it('an operator can narrow a shipped role without touching the others — the demo-admin case (yourphr#494)', () => {
        // The doc's demo-admin: every admin screen, changes nothing, cannot see the user list.
        const { policy } = boot({ [ROLES_KEY]: { admin: { permissions: ['admin-read'] } } });
        expect(policy.permissionsFor('admin')).toEqual(['admin-read']);
        expect(policy.roleDefinitions().find((r) => r.role === 'admin')?.displayname).toBe('Administrator'); // the rest of the entry survives the merge
        expect(policy.permissionsFor('user')).toEqual([]); // other roles untouched
    });
    it('an operator can ADD a role without restating the shipped ones — roles deep-merge per entry', () => {
        const { policy } = boot({ [ROLES_KEY]: { caregiver: { displayname: 'Caregiver', issystem: false, permissions: ['user-read'] } } });
        expect(policy.roleDefinitions().map((r) => r.role).sort()).toEqual(['admin', 'anonymous', 'caregiver', 'user']);
        expect(policy.permissionsFor('caregiver')).toEqual(['user-read']);
        expect(policy.permissionsFor('admin')).toHaveLength(5); // still whole
        expect(policy.roleDefinitions().find((r) => r.role === 'caregiver')?.system).toBe(false);
        expect(policy.roleDefinitions().find((r) => r.role === 'admin')?.system).toBe(true);
    });
    it('REFUSES to boot when a role grants a permission this build does not enforce', () => {
        expect(() => boot({ [ROLES_KEY]: { admin: { permissions: ['admin-read', 'record-share'] } } }))
            .toThrow(/does not enforce — record-share/);
        // and it says what IS enforced, so the operator can fix it without reading the source
        expect(() => boot({ [ROLES_KEY]: { admin: { permissions: ['admin-raed'] } } })).toThrow(/This build enforces: admin-read/);
    });
    it('refuses a permission name that is not {target}-{action} — scope never goes in a name', () => {
        expect(() => boot({ [PERMISSIONS_KEY]: { 'record-read-patient-123': { description: 'no' } } }))
            .toThrow(/is not \{target\}-\{action\}/);
    });
    it('a role list is deduplicated and sorted, and is additive only', () => {
        const { policy } = boot({ [ROLES_KEY]: { admin: { permissions: ['user-read', 'admin-read', 'user-read'] } } });
        expect(policy.permissionsFor('admin')).toEqual(['admin-read', 'user-read']);
    });
    it('the list the admin screen renders IS the list the evaluator answers from — one list, not two', () => {
        const { policy } = boot({ [ROLES_KEY]: { admin: { permissions: ['admin-read'] } } });
        const rendered = policy.roleDefinitions().find((r) => r.role === 'admin').permissions;
        expect(rendered).toEqual(policy.permissionsFor('admin')); // ngdpbase's #713, designed out
    });
});
describe('ApiContext resolves permissions through the policy manager', () => {
    it('a role carries what configuration says it carries, live per request', () => {
        const { engine } = boot();
        const admin = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
        const member = ApiContext.from({ username: 'alice', role: 'user' }, engine);
        const nobody = ApiContext.anonymous(engine);
        expect(admin.can('admin-read')).toBe(true);
        expect(member.can('admin-read')).toBe(false);
        expect(nobody.can('admin-read')).toBe(false);
        expect(() => admin.require('admin-read')).not.toThrow();
        expect(() => member.require('admin-read')).toThrow(/admin role required/);
    });
    it('narrowing a role in configuration narrows what a context may do — no code change', () => {
        const { engine } = boot({ [ROLES_KEY]: { admin: { permissions: ['admin-read'] } } });
        const admin = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
        expect(admin.can('admin-read')).toBe(true);
        expect(admin.can('admin-system')).toBe(false); // reads every screen, changes nothing
        expect(admin.can('user-read')).toBe(false); // cannot see the user list
    });
    it('an engine with no policy manager grants nothing — failing closed', () => {
        const bare = new Engine();
        const admin = ApiContext.from({ username: 'ops', role: 'admin' }, bare);
        expect(admin.permissions).toEqual([]);
        expect(() => admin.require('admin-read')).toThrow(/admin role required/);
    });
});
//# sourceMappingURL=policy.test.js.map