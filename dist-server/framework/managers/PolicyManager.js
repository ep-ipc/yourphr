/**
 * Authorization as data, read from the merged configuration at startup (yourphr#623).
 *
 * [#620](https://github.com/jwilleke/yourphr/issues/620) landed the registry as compiled TypeScript
 * constants. That was wrong, and reading ngdpbase is what showed it: `config/app-default-config.json`
 * has carried both all along — `ngdpbase.permissions.definitions` and `ngdpbase.roles.definitions`,
 * with `UserManager.ts:255` reading roles straight out of `getProperty(...)`. With the two-file
 * config system in place (yourphr#621) this needs no new mechanism: they are two keys.
 *
 * What is data and what is not:
 *
 *   - WHICH ROLE HOLDS WHICH PERMISSION is configuration. That is the point — a caregiver role, or
 *     the doc's read-only `demo-admin` for the public demo (yourphr#494), becomes an edit in
 *     Admin -> Configuration rather than a release.
 *   - WHAT A PERMISSION MEANS is the code's. An operator cannot invent `record-share` and have it
 *     do anything, because nothing enforces it; a role granting a name this build does not define
 *     REFUSES THE BOOT rather than silently granting nothing. Same posture as a required capability
 *     (yourphr#546): an instance that cannot enforce its stated policy should not serve.
 *
 * ONE LIST, NOT TWO. ngdpbase's own config warns about this (its #713): its role definitions carry
 * an inline `permissions[]` that is *display only*, while `PolicyEvaluator.evaluateAccess()` reads
 * a different key, and the two are kept matched by a comment telling the next editor to do so. The
 * list `roleDefinitions()` renders for the admin screen is the same list `permissionsFor()` answers
 * from, so there is nothing to keep in sync.
 */
import { BaseManager } from '../BaseManager.js';
import { isConfigObject } from '../../config/index.js';
export const PERMISSIONS_KEY = 'yourphr.auth.permissions.definitions';
export const ROLES_KEY = 'yourphr.auth.roles.definitions';
export class PolicyManager extends BaseManager {
    log;
    name = 'policy';
    dependsOn = ['configuration'];
    permissions = new Map();
    roles = new Map();
    constructor(engine, log = () => undefined) {
        super(engine);
        this.log = log;
        this.load();
    }
    /** Read at construction as well as at initialize(): a context can be built before the engine runs. */
    load() {
        const configuration = this.engine.managers.configuration;
        this.permissions = readPermissions(configuration.getObject(PERMISSIONS_KEY));
        this.roles = readRoles(configuration.getObject(ROLES_KEY), this.permissions);
    }
    async initialize(config = {}) {
        await super.initialize(config);
        this.load();
        this.log(`policy: ${this.permissions.size} permissions, roles ${[...this.roles.keys()].join(', ')}`);
    }
    /**
     * What a role may do. An unknown role gets NOTHING — a typo in a role name must not widen
     * anyone's powers, and failing closed is the only safe direction for that mistake.
     */
    permissionsFor(role) {
        return this.roles.get(role)?.permissions ?? [];
    }
    isPermission(name) { return this.permissions.has(name); }
    /** Every permission this build enforces — the admin screen's registry, and the drift check's. */
    registry() { return [...this.permissions.values()]; }
    /** The roles as configured. The same list the evaluator answers from — never a second copy. */
    roleDefinitions() { return [...this.roles.values()]; }
    /** Nothing of its own: the definitions live in the configuration manager's layers. */
    async backup() {
        return { manager: this.name, takenAt: new Date().toISOString() };
    }
    async restore() { }
}
function readPermissions(raw) {
    const out = new Map();
    for (const [permission, value] of Object.entries(raw)) {
        const [target, action, ...rest] = permission.split('-');
        if (!target || !action || rest.length > 0) {
            // Scope never goes in a name: `record-read-patient-123` is a compartment question wearing a
            // permission's clothes, and it cannot be listed in a registry.
            throw new Error(`policy: ${PERMISSIONS_KEY} defines '${permission}', which is not {target}-{action}`);
        }
        out.set(permission, {
            permission,
            target,
            action,
            description: isConfigObject(value) ? String(value['description'] ?? '') : '',
        });
    }
    return out;
}
function readRoles(raw, permissions) {
    const out = new Map();
    for (const [role, value] of Object.entries(raw)) {
        if (!isConfigObject(value))
            throw new Error(`policy: ${ROLES_KEY} entry '${role}' is not an object`);
        const granted = Array.isArray(value['permissions']) ? value['permissions'].map(String) : [];
        const unknown = granted.filter((p) => !permissions.has(p));
        if (unknown.length > 0) {
            // Refusing beats warning: a role granting a permission nothing enforces is configuration
            // claiming an authority the running system does not have — the same family as a NULL counter.
            throw new Error(`policy: role '${role}' in ${ROLES_KEY} grants ${unknown.length === 1 ? 'a permission' : 'permissions'} this build does not enforce — ${unknown.join(', ')}. ` +
                `This build enforces: ${[...permissions.keys()].sort().join(', ')}`);
        }
        out.set(role, {
            role,
            displayname: String(value['displayname'] ?? role),
            description: String(value['description'] ?? ''),
            system: value['issystem'] === true,
            // Deduplicated and sorted: two spellings of one list compare equal, and the admin screen's
            // order does not depend on how the operator happened to type it. Additive only — no entry
            // takes away, so "everything except" is deliberately not expressible here.
            permissions: [...new Set(granted)].sort(),
        });
    }
    return out;
}
//# sourceMappingURL=PolicyManager.js.map