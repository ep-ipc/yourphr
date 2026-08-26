/**
 * Users — the door to accounts (yourphr#611): who exists, their role, their password and the
 * policy on it, bootstrap of the first admin (yourphr#504), recovery when nobody can sign in
 * (yourphr#510), an admin's reset of a member's password (yourphr#511), deletion, and the legal
 * consent that folds in here (the architecture doc's judgment call). Takes the context on every
 * call that acts for someone; the migration tool and the bootstrap act as named system principals.
 *
 * Passwords are the auth provider's to hash and verify; this manager only ever holds the hash on
 * its way to the users provider.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BaseManager } from '../BaseManager.js';
import { ApiError } from '../ApiContext.js';
import { normaliseRole } from '../providers/BaseUsersProvider.js';
import { isLegacyBcrypt } from '../providers/PasswordAuthProvider.js';
export class UsersManager extends BaseManager {
    provider;
    passwords;
    name = 'users';
    dependsOn = ['configuration'];
    minPasswordLength = 12;
    bootstrapFile;
    bootstrapUsername;
    log;
    constructor(engine, provider, passwords, options = {}) {
        super(engine);
        this.provider = provider;
        this.passwords = passwords;
        this.log = options.log ?? (() => undefined);
    }
    async initialize(config = {}) {
        await this.provider.initialize();
        this.minPasswordLength = this.engine.managers.configuration.getInt('yourphr.auth.password.min-length');
        await super.initialize(config);
    }
    // --- what the Sessions manager needs, manager to manager ---
    /** The stored account, for the auth provider to verify against. */
    async record(username) {
        return this.provider.get(username);
    }
    /** Persist an upgraded hash after a successful legacy sign-in — no generation bump, the password did not change. */
    async rehash(username, hash) {
        await this.provider.setPasswordHash(username, hash, false);
    }
    async roleOf(username) {
        return (await this.provider.get(username))?.role;
    }
    async isAdmin(username) {
        return (await this.roleOf(username)) === 'admin';
    }
    /** Every session of the account ends (the Sessions manager's sign-out-everywhere). */
    async bumpGeneration(username) {
        await this.provider.bumpGeneration(username);
    }
    /** The bootstrap password file goes at the first successful sign-in (yourphr#466): a copy in the data dir rides in every backup. */
    onSignedIn(username) {
        if (this.bootstrapFile && username === this.bootstrapUsername && existsSync(this.bootstrapFile)) {
            rmSync(this.bootstrapFile, { force: true });
            this.bootstrapFile = undefined;
        }
    }
    // --- the policy ---
    checkPolicy(password) {
        if (password.length < this.minPasswordLength)
            throw new ApiError(400, `password must be at least ${this.minPasswordLength} characters`);
    }
    checkUsername(username) {
        if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(username))
            throw new ApiError(400, 'username must be 2-63 chars: lowercase letters, digits, . _ - (leading alphanumeric)');
    }
    // --- accounts ---
    /** An admin (or a system principal: bootstrap, tests) creates an account. */
    async createUser(ctx, username, password, role = 'user') {
        if (ctx.system === '')
            ctx.require('user-create');
        this.checkUsername(username);
        this.checkPolicy(password);
        if (await this.provider.get(username))
            throw new ApiError(400, 'User already exists');
        await this.provider.create({ username, passwordHash: this.passwords.hash(password), tokenGeneration: 0, role: normaliseRole(role) });
    }
    /** Every account, for the admin's Users page: names, roles, when created — never a hash. */
    async listUsers(ctx) {
        ctx.require('user-read');
        return (await this.provider.list()).map((u) => ({ username: u.username, role: u.role, created_at: u.createdAt }));
    }
    /** The caller changes their own password: the current one must verify, the policy applies, every session ends. */
    async changePassword(ctx, currentPassword, newPassword, nowSeconds = Math.floor(Date.now() / 1000)) {
        ctx.requireAuthenticated();
        const stored = await this.provider.get(ctx.username);
        const verified = await this.passwords.authenticate(ctx.username, currentPassword, stored, nowSeconds);
        if (!verified.ok)
            throw new ApiError(401, 'current password is incorrect');
        this.checkPolicy(newPassword);
        if (!(await this.provider.setPasswordHash(ctx.username, this.passwords.hash(newPassword), true)))
            throw new ApiError(500, 'password change did not apply');
    }
    /**
     * An admin sets a member's password (yourphr#604; the product's #511 — the family case). A
     * generated, policy-compliant password, and a generation bump so whoever holds the old sessions
     * is signed out everywhere. Returned once — the caller shows it, nobody stores it.
     */
    async adminResetPassword(ctx, username) {
        ctx.require('user-edit');
        if (!(await this.provider.get(username)))
            throw new ApiError(404, 'no such user');
        const password = randomBytes(18).toString('base64url'); // 24 chars, always above the policy minimum
        if (!(await this.provider.setPasswordHash(username, this.passwords.hash(password), true)))
            throw new ApiError(500, 'could not set the password');
        this.log(`${ctx.actor} reset the password for ${username}; every session of that account ended`);
        return password;
    }
    /** How many accounts the instance holds — the admin's database page. */
    async count(ctx) {
        if (ctx.system === '')
            ctx.require('user-read');
        return this.provider.count();
    }
    /** The caller deletes their own account (the rest of what they own is the app's to remove first). */
    async deleteSelf(ctx) {
        ctx.requireAuthenticated();
        await this.provider.setConsentAcceptedAt(ctx.username, '');
        return this.provider.delete(ctx.username);
    }
    // --- legal consent (folded in: one small table, one owner) ---
    consentAcceptedAt(ctx) {
        ctx.requireAuthenticated();
        return this.provider.consentAcceptedAt(ctx.username);
    }
    setConsent(ctx, acceptedAt) {
        ctx.requireAuthenticated();
        return this.provider.setConsentAcceptedAt(ctx.username, acceptedAt);
    }
    // --- bootstrap and recovery: the proof is filesystem access, not a session ---
    /**
     * Provision the first admin without the first-run wizard (yourphr#504). One-way and only on an
     * EMPTY user table. The generated password is written 0600 to <dataDir>/.admin_bootstrap_password;
     * the caller logs the PATH only; the file is deleted after the admin's first sign-in.
     */
    async bootstrapAdmin(dataDir, username = 'admin') {
        if ((await this.provider.count()) > 0)
            return { created: false };
        const password = randomBytes(24).toString('base64url');
        await this.provider.create({ username, passwordHash: this.passwords.hash(password), tokenGeneration: 0, role: 'admin' });
        mkdirSync(dataDir, { recursive: true });
        const file = join(dataDir, '.admin_bootstrap_password');
        writeFileSync(file, password + '\n', { mode: 0o600 });
        this.bootstrapFile = file;
        this.bootstrapUsername = username;
        return { created: true, passwordFile: file };
    }
    /**
     * Does this password verify against the stored account? Asked by demo provisioning at boot
     * (yourphr#643), which must know whether the configured credential still matches before it
     * rotates one. Passwords are this manager's resource, so the question is answered here rather
     * than by a caller reaching for the hash — the manager-is-the-only-door rule from yourphr#608.
     *
     * Not a sign-in: no throttle entry, no generation check, no token. A boot-time check that spent
     * throttle budget would let a restart loop lock the account out of its own front door.
     */
    async passwordMatches(username, password, nowSeconds = Math.floor(Date.now() / 1000)) {
        const stored = await this.provider.get(username);
        if (!stored)
            return false;
        return (await this.passwords.authenticate(username, password, stored, nowSeconds)).ok;
    }
    /**
     * Set a generated password on an existing account at boot, ending every session of it
     * (yourphr#643). No ApiContext for the same reason bootstrapAdmin and recoverAccess have none:
     * this runs before anyone is asking, so there is no actor to check — the proof is that you are
     * the process, not that you hold a session.
     *
     * Deliberately NOT reachable from a route. The only caller is demo provisioning, which chooses
     * the password itself; a route that set a caller-supplied password with no permission check
     * would be an account-takeover primitive.
     */
    async provisionPassword(username, password) {
        return this.provider.setPasswordHash(username, this.passwords.hash(password), true);
    }
    /** Recovery when nobody can sign in (yourphr#510): a fresh password, 0600 in the data dir, every session ended. */
    async recoverAccess(dataDir, username) {
        if (!(await this.provider.get(username)))
            throw new Error(`no such account: ${username}`);
        const password = randomBytes(24).toString('base64url');
        if (!(await this.provider.setPasswordHash(username, this.passwords.hash(password), true)))
            throw new Error('recovery did not apply');
        mkdirSync(dataDir, { recursive: true });
        const file = join(dataDir, '.recovery_password');
        writeFileSync(file, password + '\n', { mode: 0o600 });
        return { passwordFile: file };
    }
    // --- the migration (yourphr#583, #597): one-way, as a system principal ---
    async importLegacy(ctx, users) {
        if (ctx.system === '')
            throw new ApiError(403, 'the legacy import is a system operation');
        const report = { imported: [], skippedExisting: [], admins: [] };
        for (const user of users) {
            if (await this.provider.get(user.username)) {
                report.skippedExisting.push(user.username);
                continue;
            }
            if (!isLegacyBcrypt(user.passwordHash))
                throw new Error(`refusing to import ${user.username}: password hash is not a Go bcrypt hash`);
            const role = normaliseRole(user.role);
            await this.provider.create({ username: user.username, passwordHash: user.passwordHash, tokenGeneration: user.tokenGeneration, role });
            report.imported.push(user.username);
            if (role === 'admin')
                report.admins.push(user.username);
        }
        return report;
    }
    // --- the base contract ---
    async backup() {
        // Accounts live in the app database, which the records backup already carries whole (#602).
        return { manager: this.name, takenAt: new Date().toISOString(), payload: { accounts: (await this.provider.list()).map((u) => u.username) } };
    }
    async restore() {
        throw new ApiError(501, 'accounts are restored with the app database, not live');
    }
}
//# sourceMappingURL=UsersManager.js.map