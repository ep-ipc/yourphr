import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine.js';
import { ApiContext, ApiError } from '../ApiContext.js';

const engine = new Engine();

describe('ApiContext — who is asking, immutable, with guards that throw ApiError', () => {
  it('carries the authorization facts and freezes them', () => {
    const ctx = ApiContext.from({ username: 'alice', role: 'user', tokenGeneration: 7 }, engine);
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.username).toBe('alice');
    expect(ctx.tokenGeneration).toBe(7);
    expect(ctx.actor).toBe('alice');
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => { (ctx as { role: string }).role = 'admin'; }).toThrow();
    expect(ctx.role).toBe('user');
  });

  it('guards: anonymous is 401, a member is 403 on requireAdmin, an admin passes', () => {
    const nobody = ApiContext.anonymous(engine);
    const member = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    const admin = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
    expect(() => nobody.requireAuthenticated()).toThrow(ApiError);
    try { nobody.requireAuthenticated(); } catch (e) { expect((e as ApiError).status).toBe(401); }
    try { member.requireAdmin(); } catch (e) { expect((e as ApiError).status).toBe(403); expect((e as ApiError).message).toBe('admin role required'); }
    expect(() => admin.requireAdmin()).not.toThrow();
    expect(member.isAdmin()).toBe(false);
    expect(admin.isAdmin()).toBe(true);
    expect(nobody.isAdmin()).toBe(false);
  });

  it('a system principal acts for an account and is the named actor', () => {
    const tool = ApiContext.system('migration', 'alice', engine);
    expect(tool.isAuthenticated).toBe(true);
    expect(tool.username).toBe('alice');
    expect(tool.actor).toBe('migration');
    expect(tool.role).toBe('user');
  });

  it('ApiError carries status and extra envelope fields', () => {
    const err = new ApiError(403, 'consent first', { error_code: 'legal_consent_required' });
    expect(err.status).toBe(403);
    expect(err.extra).toEqual({ error_code: 'legal_consent_required' });
    expect(err.name).toBe('ApiError');
  });
});
