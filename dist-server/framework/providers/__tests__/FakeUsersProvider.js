/** An in-memory users provider (yourphr#611): what the Users and Sessions managers are unit-tested over. */
import { BaseUsersProvider } from '../BaseUsersProvider.js';
export class FakeUsersProvider extends BaseUsersProvider {
    rows = new Map();
    initialized = false;
    async initialize() { this.initialized = true; }
    async create(record) {
        if (this.rows.has(record.username))
            throw new Error('UNIQUE constraint failed: auth_users.username');
        this.rows.set(record.username, { ...record, createdAt: record.createdAt ?? '2026-01-01T00:00:00Z' });
    }
    async get(username) { return this.rows.get(username); }
    async list() { return [...this.rows.values()]; }
    async count() { return this.rows.size; }
    async setPasswordHash(username, hash, bumpGeneration) {
        const r = this.rows.get(username);
        if (!r)
            return false;
        r.passwordHash = hash;
        if (bumpGeneration)
            r.tokenGeneration++;
        return true;
    }
    async bumpGeneration(username) { const r = this.rows.get(username); if (r)
        r.tokenGeneration++; }
    async delete(username) { return this.rows.delete(username); }
    consent = new Map();
    async consentAcceptedAt(username) { return this.consent.get(username) ?? ''; }
    async setConsentAcceptedAt(username, acceptedAt) { this.consent.set(username, acceptedAt); }
}
//# sourceMappingURL=FakeUsersProvider.js.map