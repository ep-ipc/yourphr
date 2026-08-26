/** Anything that is not exactly 'admin' is a user — a typo in a role is never a privilege. */
export function normaliseRole(role) {
    return role === 'admin' ? 'admin' : 'user';
}
export class BaseUsersProvider {
}
//# sourceMappingURL=BaseUsersProvider.js.map