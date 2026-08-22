/**
 * The HTTP layer, serving YOURPHR's API contract rather than FHIR REST (#537).
 *
 * The evaluation assumes a backend rewrite does not force a frontend rewrite, because "the Angular
 * app talks to an HTTP contract a TypeScript backend can serve unchanged". This is the test of that
 * assumption, and it is not free: **the frontend does not speak FHIR REST.**
 *
 * Medplum's FhirRouter serves `GET /Condition?patient=x` returning a Bundle. The Angular app calls
 * `GET /api/secure/resource/fhir?sourceResourceType=Condition` and expects
 * `{success, data: ResourceFhir[]}`, where ResourceFhir WRAPS the FHIR resource with YourPHR's own
 * metadata:
 *
 *     { source_id, source_resource_type, source_resource_id, fhir_version,
 *       resource_raw, sort_title, sort_date, provenance?, classified? }
 *
 * So keeping the frontend means writing an adapter, and the adapter needs data a FHIR-native store
 * does not hold. That is the finding; the cost is real but bounded, and it is far smaller than
 * rewriting 76.8k lines of Angular.
 */
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {dirname, extname, join, resolve, sep} from 'node:path';
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import type {SqliteFhirRepository} from './SqliteFhirRepository.js';

import {sseFrame, type EventBus} from './events/index.js';
import {Engine} from './framework/Engine.js';
import {ApiContext, ApiError} from './framework/ApiContext.js';
import {RecordsManager} from './app/managers/RecordsManager.js';
import {SqliteRecordsProvider} from './app/providers/SqliteRecordsProvider.js';

/**
 * The Go cookie name, on purpose: a browser that moves between the two stacks during the cut-over
 * (yourphr#588) keeps one session entry, and the Angular app (yourphr#118 Phase 2b) never sees a
 * token — it relies entirely on this HttpOnly cookie being set on sign-in and read on /api/secure/*.
 */
export const SESSION_COOKIE = 'fasten_session';

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

export interface ServerAuth {
  /** Lifetime of the session cookie — the session's absolute cap; default 12h like DefaultSessionPolicy. */
  cookieMaxAgeSeconds?: number;
  /** Mark the cookie Secure. False behind a TLS-terminating proxy that talks plain HTTP to us (Go's web.listen.https.enabled posture). */
  secureCookies?: boolean;
  /**
   * The repository serving a VERIFIED user's requests. This signature is the point of the wiring
   * (yourphr#541): the user id stops being server configuration and becomes something each request
   * proves with a session — the isolation #537 demonstrated, enforced on the wire.
   */
}

export interface ServerModules {
  /** GET /api/secure/summary/ips — the IPS document for the caller (yourphr#577). */
  ips?: (ctx: ApiContext) => Promise<unknown>;
  /** GET /api/secure/resource/provenance/:type/:id (yourphr#579). */
  provenanceFor?: (ctx: ApiContext, resourceType: string, id: string) => Promise<unknown>;
  /** GET /api/secure/medications/reconciled (yourphr#580). */
  medications?: (ctx: ApiContext) => Promise<unknown>;
  /** The dashboard and record pages (yourphr#595): classified lists, recent activity, the typed query. */
  records?: {
    recent: (ctx: ApiContext, limit: number) => Promise<unknown[]>;
    conditions: (ctx: ApiContext) => Promise<unknown[]>;
    allergies: (ctx: ApiContext) => Promise<unknown[]>;
    immunizations: (ctx: ApiContext) => Promise<unknown[]>;
    /** Throws ApiError on a malformed query. */
    query: (ctx: ApiContext, body: Record<string, unknown>) => Promise<unknown[]>;
  };
  /** The provider catalog (yourphr#603): admin CRUD, the sandbox list, authorize + connect. */
  catalog?: {
    list: () => unknown[];
    get: (id: string) => unknown | undefined;
    /** Throws on a refusal (message is the reason). */
    create: (body: Record<string, unknown>) => unknown;
    update: (id: string, body: Record<string, unknown>) => unknown | undefined;
    remove: (id: string) => boolean;
    sandbox: () => unknown[];
    /** Resolves Go's authorize answer; rejects with a status-bearing error. */
    authorize: (username: string, id: string, body: Record<string, unknown>) => Promise<unknown>;
    connect: (ctx: ApiContext, id: string, body: Record<string, unknown>) => Promise<{ source: unknown; data: unknown }>;
  };
  /** The account page and the legal pages (yourphr#596). */
  account?: {
    /** GET /api/legal/:kind — public. Throws when an operator override is unusable. */
    legalDocument: (kind: string) => unknown | undefined;
    accessLog: (username: string) => unknown[];
    /** Called for every listed GET a signed-in user makes; the store folds it into a day bucket. */
    recordAccess: (username: string, pathname: string) => void;
    legalConsent: (ctx: ApiContext) => unknown;
    grantConsent: (ctx: ApiContext) => unknown;
    revokeConsent: (ctx: ApiContext) => unknown;
    /** Throws ApiError (401 wrong current, 400 policy); resolves the fresh session token. */
    changePassword: (ctx: ApiContext, current: string, next: string) => Promise<string | undefined>;
    signOutEverywhere: (ctx: ApiContext) => Promise<void>;
    deleteAccount: (ctx: ApiContext) => Promise<void>;
  };
  /** GET/POST/DELETE /api/secure/user/favorites (yourphr#595): the caller's starred practitioners. */
  favorites?: {
    list: (username: string, resourceType: string) => unknown[];
    add: (username: string, fav: { source_id: string; resource_type: string; resource_id: string }) => void;
    remove: (username: string, fav: { source_id: string; resource_type: string; resource_id: string }) => boolean;
    supports: (resourceType: string) => boolean;
  };
  /** Admin surface (yourphr#582): gate decides who counts as the operator. */
  /** What an anonymous caller may know about this instance (GET /api/instance/public). */
  publicInstance?: () => Record<string, unknown>;
  /** What a signed-in member may know (GET /api/secure/instance, yourphr#593): public plus the operator contact. */
  instanceForUser?: (username: string) => Record<string, unknown>;
  /** GET /api/secure/jobs (yourphr#593): the caller's sync jobs in Go's BackgroundJob shape. */
  jobsForUser?: (username: string, query: { limit: number; page: number; status?: string; jobType?: string }) => unknown[];
  /**
   * The Sources page (yourphr#594): the caller's connected sources in Go's SourceCredential shape,
   * the per-source actions, the connectable catalog and the event stream. Every per-source call
   * answers undefined for a source the caller does not own — 404, never 403, so ids are not probed.
   */
  sources?: {
    list: (username: string) => unknown[];
    get: (username: string, id: string) => unknown | undefined;
    summary: (ctx: ApiContext, id: string) => Promise<unknown | undefined>;
    /** Resolves to Go's {source, data} or undefined; rejects when the sync itself failed. */
    sync: (username: string, id: string) => Promise<{ source: unknown; data: unknown } | undefined>;
    disconnect: (username: string, id: string) => boolean;
    removeData: (ctx: ApiContext, id: string) => Promise<number | undefined>;
    remove: (ctx: ApiContext, id: string) => Promise<number | undefined>;
    exportBundle: (ctx: ApiContext, id: string) => Promise<{ filename: string; bundle: unknown } | undefined>;
    connectable: () => unknown[];
    events: EventBus;
  };
  admin?: {
    /** GET /admin/config in Go's AdminConfigResponse shape (yourphr#602). */
    configSnapshot: () => unknown;
    configReveal: (key: string) => unknown | undefined;
    /** Throws with a status-bearing error: 400 unknown/invalid, 409 env-pinned. */
    configSet: (key: string, value: unknown) => void;
    configReset: (key: string) => boolean;
    catalogList: () => unknown;
    backupNow: () => Promise<unknown>;
    createUser: (ctx: ApiContext, username: string, password: string, role?: string) => Promise<void>;
    /** The Users page (yourphr#604). */
    listUsers: (ctx: ApiContext) => Promise<unknown[]>;
    resetUserPassword: (ctx: ApiContext, username: string) => Promise<{ username: string; password: string }>;
    instanceSettings: () => { name: string; contact_email: string; contact_url: string };
    setInstanceSettings: (s: { name: string; contact_email: string; contact_url: string }) => void;
    metrics: () => unknown;
    databaseInfo: () => Promise<unknown>;
    /** Returns the file path of a fresh backup for streaming. */
    backupFile: () => Promise<{ file: string; name: string; sizeBytes: number }>;
    setSchedule: (body: Record<string, unknown>) => unknown;
    testDestination: (destination: string) => unknown;
    browse: (path: string) => unknown;
    stageRestore: (backupName: string) => Promise<unknown>;
    logs: () => { level: string; valid_levels: string[]; lines: string[] };
    setLogLevel: (level: string) => string;
    relayConfig: () => unknown;
  };
}

export interface ServerOptions {
  /** The pinned single-user repository — used only when `auth` is absent (the read-only harnesses). */
  /** The composition root (yourphr#608). When absent, a bare engine is built over `repo` for the contract harnesses. */
  engine?: Engine;
  /** Legacy: the contract harnesses hand one repository in and test reads, not auth. */
  repo?: SqliteFhirRepository;
  /** Which source every record is attributed to. See the note on sourceId below. */
  sourceId?: string;
  /**
   * When present, /api/secure/* requires a Bearer session from POST /api/auth/signin, and each
   * request is served as its verified user. Absent keeps the legacy pinned-user behavior for the
   * existing contract harnesses, which test reads, not auth.
   */
  auth?: ServerAuth;
  /** The assembled modules (yourphr#582). Absent keeps the bare read server. */
  modules?: ServerModules;
  /**
   * Directory holding the BUILT Angular app (yourphr#585). When set, non-/api requests serve
   * static files with an SPA fallback to index.html — one container replaces one container at
   * cut-over. API routes always win.
   */
  webDir?: string;
  /** Reported by GET /api/version — the Angular footer shows it. */
  version?: string;
}

/**
 * Wrap a FHIR resource the way the Angular app expects to receive it.
 *
 * THREE FIELDS THE SPIKE CANNOT PRODUCE, and they are the honest cost of this layer:
 *
 *   source_id   — which connected provider a record came from. YourPHR stores it per record; a
 *                 FHIR-native store has no such concept. Migrating means persisting it alongside.
 *   sort_title  — a display title the Go backend derives per resource type at write time. The list
 *                 views sort and label by it, so an empty one gives a screen of blank rows.
 *   provenance / classified — attached on the read path (#271, #308/#309), not stored.
 *
 * None is hard; all are invisible until the screen renders wrong, which is exactly why this had to
 * be built rather than reasoned about.
 */
export function toResourceFhir(resource: Resource, sourceId: string): Record<string, unknown> {
  return {
    source_id: sourceId,
    source_resource_type: resource.resourceType,
    source_resource_id: resource.id,
    fhir_version: 'R4',
    resource_raw: resource,
    // Best effort from the resource itself. The Go side computes a richer title per type; matching
    // it exactly is adapter work, not a question about whether the approach can work.
    sort_title: titleFor(resource),
    sort_date: dateFor(resource),
  };
}

export function titleFor(resource: any): string {
  return (
    resource.code?.text ||
    resource.code?.coding?.[0]?.display ||
    resource.type?.[0]?.text ||
    resource.type?.coding?.[0]?.display ||
    resource.medicationCodeableConcept?.text ||
    resource.medicationCodeableConcept?.coding?.[0]?.display ||
    resource.vaccineCode?.text ||
    resource.vaccineCode?.coding?.[0]?.display ||
    resource.description ||
    resource.name?.[0]?.text ||
    resource.name ||
    ''
  );
}

export function dateFor(resource: any): string | null {
  return (
    resource.effectiveDateTime ||
    resource.effectivePeriod?.start ||
    resource.issued ||
    resource.onsetDateTime ||
    resource.recordedDate ||
    resource.occurrenceDateTime ||
    resource.performedDateTime ||
    resource.performedPeriod?.start ||
    resource.authoredOn ||
    resource.date ||
    resource.created ||
    resource.dateAsserted ||
    resource.period?.start ||
    null // never meta.lastUpdated: when THIS instance stored it is not when anything happened
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded)});
  res.end(encoded);
}

/**
 * Serves the subset of YourPHR's API the record screens actually use. Read-only, and deliberately
 * so: this exists to answer "can the existing frontend load records from the TypeScript stack",
 * not to be a backend.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves the built Angular app (yourphr#585). The one security rule that matters: the resolved
 * path must stay INSIDE webDir — a traversal (%2e%2e, ../) gets 404, not the file. SPA fallback:
 * an extensionless path is an Angular route and gets index.html; a missing asset (has an
 * extension) is an honest 404, because serving index.html as main.js breaks the app confusingly.
 */
function serveStatic(webDir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(webDir);
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({success: false, error: 'not found'}));
    return;
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(decoded) !== '') {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({success: false, error: 'not found'}));
      return;
    }
    file = join(root, 'index.html'); // the SPA fallback — Angular owns the route
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // index.html must revalidate (it names the hashed bundles); hashed assets may cache hard.
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

/** Reads a small JSON body; refuses anything over 64KB — sign-in bodies have no reason to be big. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

export function createYourPhrServer(options: ServerOptions) {
  const auth = options.auth;
  // The engine: the assembled one, or — for the contract harnesses that hand a repository in — a
  // bare one with a Records manager over that handle. Either way every record goes through the door.
  const engineReady: Promise<Engine> = options.engine
    ? Promise.resolve(options.engine)
    : (async () => {
        if (!options.repo) throw new Error('createYourPhrServer needs an engine or a repository');
        const e = new Engine();
        e.register('records', new RecordsManager(e, SqliteRecordsProvider.overRepository(options.repo)));
        await e.initialize();
        return e;
      })();
  const legacyUser = options.repo?.userId ?? '';

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const engine = await engineReady;

      // GET /healthz — liveness/readiness for the orchestrator (yourphr#587). No session, no data:
      // it says the process is up and serving, nothing about who is asking.
      if (url.pathname === '/healthz' && req.method === 'GET') {
        send(res, 200, {ok: true});
        return;
      }

      // The Angular app's boot calls (found by the parity audit, yourphr#591) — Go's shapes exactly.
      if (url.pathname === '/api/version' && req.method === 'GET') {
        send(res, 200, {success: true, data: {version: options.version ?? '0.0.0-dev', environment_name: ''}});
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        send(res, 200, {success: true, data: {first_run_wizard: false, standby_mode: false}});
        return;
      }
      const legalMatch = url.pathname.match(/^\/api\/legal\/([^/]+)$/);
      if (options.modules?.account && legalMatch && req.method === 'GET') {
        const document = options.modules.account.legalDocument(decodeURIComponent(legalMatch[1]!));
        document === undefined ? send(res, 404, {success: false, error: `unknown legal document "${legalMatch[1]}"`}) : send(res, 200, {success: true, data: document});
        return;
      }
      if (url.pathname === '/api/instance/public' && req.method === 'GET') {
        send(res, 200, {success: true, data: options.modules?.publicInstance?.() ?? {}});
        return;
      }
      // Logout clears the HttpOnly cookie — the one thing JavaScript cannot do itself.
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', sessionCookie('', 0, auth?.secureCookies ?? false));
        send(res, 200, {success: true});
        return;
      }

      // POST /api/auth/signin — the only route that exists without a session. Throttling, the
      // generic error and the trusted-proxy rule all live in AuthStore; this is just transport.
      if (auth && url.pathname === '/api/auth/signin' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const username = typeof body?.['username'] === 'string' ? (body['username'] as string) : '';
        const password = typeof body?.['password'] === 'string' ? (body['password'] as string) : '';
        const result = await engine.managers.sessions.signIn(username, { password }, {
          remoteAddr: req.socket.remoteAddress ?? '',
          xff: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
        });
        if (!result.ok) {
          send(res, 401, {success: false, error: result.error});
          return;
        }
        // The Go envelope, exactly: data IS the token string — the Angular auth service does
        // setAuthToken(resp.data). Wrapping it in an object signed the user straight back out
        // (found by the parity audit, yourphr#591).
        res.setHeader('Set-Cookie', sessionCookie(result.token, auth.cookieMaxAgeSeconds ?? 12 * 60 * 60, auth.secureCookies ?? false));
        send(res, 200, {success: true, data: result.token});
        return;
      }

      // The session gate: with auth wired, every /api/secure/* request proves who it is, and is
      // served by THAT user's repository. 401 for no token, a tampered token, an expired one, or a
      // token whose generation the account has moved past (a password change ends it mid-flight).
      let sessionUser = legacyUser;
      let ctx = ApiContext.from({username: legacyUser, role: 'user'}, engine);
      if (auth && url.pathname.startsWith('/api/secure/')) {
        // Bearer first (API clients, the harnesses), else the HttpOnly cookie (the browser).
        const header = req.headers['authorization'] ?? '';
        const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
        const token = bearer !== '' ? bearer : readCookie(req.headers['cookie'], SESSION_COOKIE);
        const session = token ? await engine.managers.sessions.verify(token) : ({ok: false} as const);
        if (!session.ok) {
          send(res, 401, {success: false, error: 'unauthorized'});
          return;
        }
        if (session.renewed) {
          res.setHeader('X-Renewed-Token', session.renewed);
          res.setHeader('Set-Cookie', sessionCookie(session.renewed, auth.cookieMaxAgeSeconds ?? 12 * 60 * 60, auth.secureCookies ?? false));
        }
        sessionUser = session.principal.username;
        // Who is asking, for every manager call this request makes (yourphr#608).
        ctx = ApiContext.from(session.principal, engine);
      }

      // The access log (yourphr#596): a listed GET by a signed-in user is an access of their record.
      if (auth && options.modules?.account && req.method === 'GET') {
        options.modules.account.recordAccess(sessionUser, url.pathname);
      }

      // --- the account page (yourphr#596) ---
      if (auth && options.modules?.account && url.pathname.startsWith('/api/secure/account/')) {
        const account = options.modules.account;
        if (url.pathname === '/api/secure/account/access-log' && req.method === 'GET') {
          send(res, 200, {success: true, data: account.accessLog(sessionUser)});
          return;
        }
        if (url.pathname === '/api/secure/account/legal-consent' && req.method === 'GET') {
          send(res, 200, {success: true, data: account.legalConsent(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/account/legal-consent/grant' && req.method === 'POST') {
          send(res, 200, {success: true, data: account.grantConsent(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/account/legal-consent/revoke' && req.method === 'POST') {
          send(res, 200, {success: true, data: account.revokeConsent(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/account/password' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const current = typeof body?.['current_password'] === 'string' ? (body['current_password'] as string) : '';
          const next = typeof body?.['new_password'] === 'string' ? (body['new_password'] as string) : '';
          if (!body || current === '' || next === '') {
            send(res, 400, {success: false, error: 'invalid request'});
            return;
          }
          const token = await account.changePassword(ctx, current, next); // ApiError -> the error boundary
          // The generation bump ended this session too; a fresh one rides back on the cookie, as Go does.
          if (token) {
            res.setHeader('Set-Cookie', sessionCookie(token, auth.cookieMaxAgeSeconds ?? 12 * 60 * 60, auth.secureCookies ?? false));
            send(res, 200, {success: true, data: token});
          } else {
            send(res, 200, {success: true});
          }
          return;
        }
        if (url.pathname === '/api/secure/account/sign-out-everywhere' && req.method === 'POST') {
          await account.signOutEverywhere(ctx);
          res.setHeader('Set-Cookie', sessionCookie('', 0, auth.secureCookies ?? false));
          send(res, 200, {success: true});
          return;
        }
        if (url.pathname === '/api/secure/account/me' && req.method === 'DELETE') {
          await account.deleteAccount(ctx);
          res.setHeader('Set-Cookie', sessionCookie('', 0, auth.secureCookies ?? false));
          send(res, 200, {success: true});
          return;
        }
      }

      // Who am I — the call the Angular app makes on every route to decide it is signed in, and
      // where it learns the role. Fields the spike does not store (full_name, email, picture) are
      // empty, not invented; id is the username because that is the spike's account identity.
      if (auth && url.pathname === '/api/secure/account/me' && req.method === 'GET') {
        send(res, 200, {success: true, data: {
          id: sessionUser, username: sessionUser, full_name: '', email: '', picture: '',
          role: ctx.role,
          demo_account: false, last_login: null, login_count: 0,
        }});
        return;
      }

      // --- the assembled modules (yourphr#582) ---
      const modules = options.modules;
      // The two calls every page makes (yourphr#593): who runs this instance, and the job indicator.
      if (modules?.instanceForUser && url.pathname === '/api/secure/instance' && req.method === 'GET') {
        send(res, 200, {success: true, data: modules.instanceForUser(sessionUser)});
        return;
      }
      if (modules?.jobsForUser && url.pathname === '/api/secure/jobs' && req.method === 'GET') {
        const limitParam = Number(url.searchParams.get('limit') ?? 0);
        const pageParam = Number(url.searchParams.get('page') ?? 0);
        if (!Number.isInteger(limitParam) || limitParam < 0 || !Number.isInteger(pageParam) || pageParam < 0) {
          send(res, 400, {success: false, error: 'limit and page must be non-negative integers'});
          return;
        }
        const query = {
          limit: limitParam === 0 ? 20 : limitParam, // Go's ResourceListPageSize when unset or 0
          page: pageParam,
          status: url.searchParams.get('status') ?? undefined,
          jobType: url.searchParams.get('jobType') ?? undefined,
        };
        send(res, 200, {success: true, data: modules.jobsForUser(sessionUser, query)});
        return;
      }

      // --- the Users page (yourphr#604): the admin's list, create, and password reset ---
      if (modules?.admin && (url.pathname === '/api/secure/users' || /^\/api\/secure\/users\/[^/]+\/password$/.test(url.pathname))) {
        // Go answers a non-admin here with 401 "Unauthorized"; the page treats both as "not for you".
        if (!ctx.isAdmin()) {
          send(res, 401, {success: false, error: 'Unauthorized'});
          return;
        }
        if (url.pathname === '/api/secure/users' && req.method === 'GET') {
          send(res, 200, {success: true, data: await modules.admin.listUsers(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/users' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const username = typeof body?.['username'] === 'string' ? (body['username'] as string).trim() : '';
          const password = typeof body?.['password'] === 'string' ? (body['password'] as string) : '';
          const role = body?.['role'] === 'admin' ? 'admin' : 'user';
          if (!body || username === '' || password === '') {
            send(res, 400, {success: false, error: 'username and password are required'});
            return;
          }
          await modules.admin.createUser(ctx, username, password, role); // ApiError (400) -> the error boundary
          // Go echoes the user it made. This stack stores no full_name or email — they are absent,
          // not invented; id is the username, as /account/me already says.
          send(res, 200, {success: true, data: {id: username, username, role}});
          return;
        }
        const resetMatch = url.pathname.match(/^\/api\/secure\/users\/([^/]+)\/password$/);
        if (resetMatch && req.method === 'POST') {
          send(res, 200, {success: true, data: await modules.admin.resetUserPassword(ctx, decodeURIComponent(resetMatch[1]!))});
          return;
        }
      }

      // --- the provider catalog (yourphr#603): admin curates, members connect ---
      if (modules?.catalog && url.pathname.startsWith('/api/secure/provider-catalog')) {
        const cat = modules.catalog;
        const fail = (err: unknown): void => {
          const e = err as Error & { status?: number; extra?: Record<string, unknown> };
          send(res, e.status ?? 400, {success: false, error: e.message, ...(e.extra ?? {})});
        };
        if (url.pathname === '/api/secure/provider-catalog/sandbox' && req.method === 'GET') {
          if (!ctx.isAdmin()) { send(res, 403, {success: false, error: 'admin role required'}); return; }
          send(res, 200, {success: true, data: cat.sandbox()});
          return;
        }
        const connectMatch = url.pathname.match(/^\/api\/secure\/provider-catalog\/([^/]+)\/(authorize|connect)$/);
        if (connectMatch && req.method === 'POST') {
          const body = (await readJsonBody(req)) ?? {};
          try {
            if (connectMatch[2] === 'authorize') {
              send(res, 200, {success: true, ...(await cat.authorize(sessionUser, decodeURIComponent(connectMatch[1]!), body)) as Record<string, unknown>});
            } else {
              const r = await cat.connect(ctx, decodeURIComponent(connectMatch[1]!), body);
              send(res, 200, {success: true, source: r.source, data: r.data});
            }
          } catch (err) {
            fail(err);
          }
          return;
        }
        if (url.pathname !== '/api/secure/provider-catalog/connectable') {
          // Everything else is the admin's: the catalog is instance configuration.
          if (!ctx.isAdmin()) { send(res, 403, {success: false, error: 'admin role required to manage the provider catalog'}); return; }
          if (url.pathname === '/api/secure/provider-catalog' && req.method === 'GET') {
            send(res, 200, {success: true, data: cat.list()});
            return;
          }
          if (url.pathname === '/api/secure/provider-catalog' && req.method === 'POST') {
            const body = await readJsonBody(req);
            if (!body) { send(res, 400, {success: false, error: 'invalid request'}); return; }
            try { send(res, 200, {success: true, data: cat.create(body)}); } catch (err) { fail(err); }
            return;
          }
          const idMatch = url.pathname.match(/^\/api\/secure\/provider-catalog\/([^/]+)$/);
          if (idMatch) {
            const id = decodeURIComponent(idMatch[1]!);
            if (req.method === 'GET') {
              const entry = cat.get(id);
              entry === undefined ? send(res, 404, {success: false, error: 'no such catalog entry'}) : send(res, 200, {success: true, data: entry});
              return;
            }
            if (req.method === 'PUT') {
              const body = await readJsonBody(req);
              if (!body) { send(res, 400, {success: false, error: 'invalid request'}); return; }
              try {
                const entry = cat.update(id, body);
                entry === undefined ? send(res, 404, {success: false, error: 'no such catalog entry'}) : send(res, 200, {success: true, data: entry});
              } catch (err) { fail(err); }
              return;
            }
            if (req.method === 'DELETE') {
              send(res, 200, {success: true, data: {deleted: cat.remove(id) ? 1 : 0}});
              return;
            }
          }
        }
      }

      // The SMART relay card (yourphr#602) — before the per-source routes, whose :id would swallow it.
      if (modules?.admin && url.pathname === '/api/secure/source/relay-config' && req.method === 'GET') {
        send(res, 200, {success: true, data: modules.admin.relayConfig()});
        return;
      }

      // --- the Sources page (yourphr#594) ---
      if (modules?.sources) {
        const src = modules.sources;
        if (url.pathname === '/api/secure/source' && req.method === 'GET') {
          send(res, 200, {success: true, data: src.list(sessionUser)});
          return;
        }
        if (url.pathname === '/api/secure/provider-catalog/connectable' && req.method === 'GET') {
          send(res, 200, {success: true, data: src.connectable()});
          return;
        }
        if (url.pathname === '/api/secure/events/stream' && req.method === 'GET') {
          // Server-sent events, Go's framing (event:message, JSON data). A keep-alive every 15s so
          // an idle connection survives a proxy; the subscription ends when the client goes away.
          res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
          res.write(sseFrame({event_type: 'keep_alive'}));
          const unsubscribe = src.events.subscribe(sessionUser, (event) => res.write(sseFrame(event)));
          const keepAlive = setInterval(() => res.write(sseFrame({event_type: 'keep_alive'})), 15_000);
          const close = (): void => { clearInterval(keepAlive); unsubscribe(); res.end(); };
          req.on('close', close);
          res.on('error', close);
          return;
        }
        const sourceMatch = url.pathname.match(/^\/api\/secure\/source\/([^/]+)(?:\/(summary|sync|disconnect|remove-data|export))?$/);
        if (sourceMatch) {
          const id = decodeURIComponent(sourceMatch[1]!);
          const action = sourceMatch[2];
          const notFound = (): void => send(res, 404, {success: false, error: 'source not found'});
          if (!action && req.method === 'GET') {
            const source = src.get(sessionUser, id);
            source === undefined ? notFound() : send(res, 200, {success: true, data: source});
            return;
          }
          if (!action && req.method === 'DELETE') {
            const rows = await src.remove(ctx, id);
            rows === undefined ? notFound() : send(res, 200, {success: true, data: rows});
            return;
          }
          if (action === 'summary' && req.method === 'GET') {
            const summary = await src.summary(ctx, id);
            summary === undefined ? notFound() : send(res, 200, {success: true, data: summary});
            return;
          }
          if (action === 'sync' && req.method === 'POST') {
            let result: { source: unknown; data: unknown } | undefined;
            try {
              result = await src.sync(sessionUser, id);
            } catch (err) {
              send(res, 500, {success: false, error: `record sync failed: ${(err as Error).message}`});
              return;
            }
            result === undefined ? notFound() : send(res, 200, {success: true, source: result.source, data: result.data});
            return;
          }
          if (action === 'disconnect' && req.method === 'POST') {
            src.disconnect(sessionUser, id) ? send(res, 200, {success: true, data: {disconnected: true}}) : notFound();
            return;
          }
          if (action === 'remove-data' && req.method === 'POST') {
            const rows = await src.removeData(ctx, id);
            rows === undefined ? notFound() : send(res, 200, {success: true, data: rows});
            return;
          }
          if (action === 'export' && req.method === 'GET') {
            const exported = await src.exportBundle(ctx, id);
            if (exported === undefined) {
              notFound();
              return;
            }
            const body = JSON.stringify(exported.bundle, null, 2);
            res.writeHead(200, {
              'Content-Type': 'application/fhir+json',
              'Content-Disposition': `attachment; filename=${exported.filename}`,
              'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }
        }
      }
      if (modules?.ips && url.pathname === '/api/secure/summary/ips' && req.method === 'GET') {
        send(res, 200, {success: true, data: await modules.ips(ctx)});
        return;
      }
      const provMatch = url.pathname.match(/^\/api\/secure\/resource\/provenance\/([^/]+)\/([^/]+)$/);
      if (modules?.provenanceFor && provMatch && req.method === 'GET') {
        const p = await modules.provenanceFor(ctx, provMatch[1]!, provMatch[2]!);
        if (!p) {
          send(res, 404, {success: false, error: 'not found'});
          return;
        }
        send(res, 200, {success: true, data: p});
        return;
      }
      if (modules?.medications && url.pathname === '/api/secure/medications/reconciled' && req.method === 'GET') {
        send(res, 200, {success: true, data: await modules.medications(ctx)});
        return;
      }

      // --- the dashboard and record pages (yourphr#595) ---
      if (modules?.records) {
        const records = modules.records;
        if (url.pathname === '/api/secure/resources/recent' && req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit') ?? 5);
          send(res, 200, {success: true, data: await records.recent(ctx, Number.isInteger(limit) && limit > 0 ? limit : 5)});
          return;
        }
        if (url.pathname === '/api/secure/conditions/reconciled' && req.method === 'GET') {
          send(res, 200, {success: true, data: await records.conditions(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/allergies/classified' && req.method === 'GET') {
          send(res, 200, {success: true, data: await records.allergies(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/immunizations/classified' && req.method === 'GET') {
          send(res, 200, {success: true, data: await records.immunizations(ctx)});
          return;
        }
        if (url.pathname === '/api/secure/query' && req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!body || typeof body['from'] !== 'string') {
            send(res, 400, {success: false, error: 'query must name a resource type in "from"'});
            return;
          }
          try {
            send(res, 200, {success: true, data: await records.query(ctx, body)});
          } catch (err) {
            send(res, err instanceof ApiError ? err.status : 400, {success: false, error: (err as Error).message});
          }
          return;
        }
      }
      if (modules?.favorites && url.pathname === '/api/secure/user/favorites') {
        const favorites = modules.favorites;
        if (req.method === 'GET') {
          const resourceType = url.searchParams.get('resource_type') ?? '';
          if (!favorites.supports(resourceType)) {
            send(res, 400, {success: false, error: 'only Practitioner resources are supported'});
            return;
          }
          send(res, 200, {success: true, data: favorites.list(sessionUser, resourceType)});
          return;
        }
        if (req.method === 'POST' || req.method === 'DELETE') {
          const body = await readJsonBody(req);
          const str = (k: string): string => (typeof body?.[k] === 'string' ? (body[k] as string) : '');
          const fav = {source_id: str('source_id'), resource_type: str('resource_type'), resource_id: str('resource_id')};
          if (!fav.source_id || !fav.resource_type || !fav.resource_id) {
            send(res, 400, {success: false, error: 'invalid request payload'});
            return;
          }
          if (!favorites.supports(fav.resource_type)) {
            send(res, 400, {success: false, error: 'only Practitioner resources are supported'});
            return;
          }
          if (req.method === 'POST') {
            favorites.add(sessionUser, fav);
            send(res, 200, {success: true, data: fav});
          } else {
            send(res, 200, {success: true, data: {removed: favorites.remove(sessionUser, fav)}});
          }
          return;
        }
      }
      if (modules?.admin && url.pathname.startsWith('/api/secure/admin/')) {
        // Operator-only. The gate is a role check, not a route secret: a non-admin gets 403 with
        // no detail about what lives here.
        if (!ctx.isAdmin()) {
          send(res, 403, {success: false, error: 'admin role required'});
          return;
        }
        const admin = modules.admin;
        const withStatus = (err: unknown): { status: number; error: string } => {
          const e = err as Error & { status?: number };
          return {status: e.status ?? 400, error: e.message};
        };
        if (url.pathname === '/api/secure/admin/config' && req.method === 'GET') {
          send(res, 200, {success: true, data: admin.configSnapshot()});
          return;
        }
        const reveal = url.pathname.match(/^\/api\/secure\/admin\/config\/reveal\/([^/]+)$/);
        if (reveal && req.method === 'GET') {
          const revealed = admin.configReveal(decodeURIComponent(reveal[1]!));
          revealed === undefined ? send(res, 404, {success: false, error: 'unknown configuration key'}) : send(res, 200, {success: true, data: revealed});
          return;
        }
        if (url.pathname === '/api/secure/admin/config' && req.method === 'PUT') {
          const body = await readJsonBody(req);
          const key = typeof body?.['key'] === 'string' ? (body['key'] as string).trim().toLowerCase() : '';
          if (!body || key === '' || !('value' in body)) {
            send(res, 400, {success: false, error: 'invalid request'});
            return;
          }
          try {
            admin.configSet(key, body['value']);
            send(res, 200, {success: true, data: {key}});
          } catch (err) {
            const e = withStatus(err);
            send(res, e.status, {success: false, error: e.error});
          }
          return;
        }
        const resetKey = url.pathname.match(/^\/api\/secure\/admin\/config\/([^/]+)$/);
        if (resetKey && req.method === 'DELETE') {
          try {
            send(res, 200, {success: true, data: {key: decodeURIComponent(resetKey[1]!), cleared: admin.configReset(decodeURIComponent(resetKey[1]!).toLowerCase())}});
          } catch (err) {
            const e = withStatus(err);
            send(res, e.status, {success: false, error: e.error});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/instance' && req.method === 'GET') {
          send(res, 200, {success: true, data: admin.instanceSettings()});
          return;
        }
        if (url.pathname === '/api/secure/admin/instance' && req.method === 'PUT') {
          const body = await readJsonBody(req);
          if (!body) {
            send(res, 400, {success: false, error: 'invalid request'});
            return;
          }
          const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
          const settings = {name: str('name'), contact_email: str('contact_email'), contact_url: str('contact_url')};
          if (settings.contact_email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.contact_email)) {
            send(res, 400, {success: false, error: 'contact_email is not an email address'});
            return;
          }
          if (settings.contact_url !== '' && !/^https?:\/\//.test(settings.contact_url)) {
            send(res, 400, {success: false, error: 'contact_url must start with http:// or https://'});
            return;
          }
          try {
            admin.setInstanceSettings(settings);
          } catch (err) {
            send(res, 500, {success: false, error: `save failed: ${(err as Error).message}`});
            return;
          }
          send(res, 200, {success: true, data: settings});
          return;
        }
        if (url.pathname === '/api/secure/admin/metrics' && req.method === 'GET') {
          send(res, 200, {success: true, data: admin.metrics()});
          return;
        }
        if (url.pathname === '/api/secure/admin/database' && req.method === 'GET') {
          send(res, 200, {success: true, data: await admin.databaseInfo()});
          return;
        }
        if (url.pathname === '/api/secure/admin/database/backup' && req.method === 'POST') {
          try {
            const b = await admin.backupFile();
            send(res, 200, {success: true, data: {filename: b.name, path: b.file, destination: dirname(b.file), size_bytes: b.sizeBytes}});
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/database/backup/download' && req.method === 'POST') {
          let b: { file: string; name: string; sizeBytes: number };
          try {
            b = await admin.backupFile();
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
            return;
          }
          res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename=${b.name}`, 'Content-Length': b.sizeBytes});
          createReadStream(b.file).pipe(res);
          return;
        }
        if (url.pathname === '/api/secure/admin/database/schedule' && req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!body) {
            send(res, 400, {success: false, error: 'invalid request'});
            return;
          }
          try {
            send(res, 200, {success: true, data: admin.setSchedule(body)});
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/database/backup/test' && req.method === 'POST') {
          const body = await readJsonBody(req);
          send(res, 200, {success: true, data: admin.testDestination(typeof body?.['destination'] === 'string' ? (body['destination'] as string) : '')});
          return;
        }
        if (url.pathname === '/api/secure/admin/database/browse' && req.method === 'GET') {
          try {
            send(res, 200, {success: true, data: admin.browse(url.searchParams.get('path') ?? '')});
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/database/restore' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const name = typeof body?.['backup_name'] === 'string' ? (body['backup_name'] as string) : '';
          if (!body || name === '') {
            send(res, 400, {success: false, error: 'invalid request'});
            return;
          }
          if (body['confirm'] !== true) {
            send(res, 400, {success: false, error: 'restore must be confirmed'});
            return;
          }
          try {
            send(res, 200, {success: true, data: await admin.stageRestore(name)});
          } catch (err) {
            const message = (err as Error).message;
            send(res, message.startsWith('no such backup') ? 404 : 400, {success: false, error: message});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/logs' && req.method === 'GET') {
          send(res, 200, {success: true, data: admin.logs()});
          return;
        }
        if (url.pathname === '/api/secure/admin/log-level' && req.method === 'PUT') {
          const body = await readJsonBody(req);
          const level = typeof body?.['level'] === 'string' ? (body['level'] as string) : '';
          try {
            send(res, 200, {success: true, data: {level: admin.setLogLevel(level)}});
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
          }
          return;
        }
        if (url.pathname === '/api/secure/admin/catalog' && req.method === 'GET') {
          send(res, 200, {success: true, data: modules.admin.catalogList()});
          return;
        }
        if (url.pathname === '/api/secure/admin/backup' && req.method === 'POST') {
          send(res, 200, {success: true, data: await modules.admin.backupNow()});
          return;
        }
        if (url.pathname === '/api/secure/admin/users' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const username = typeof body?.['username'] === 'string' ? (body['username'] as string) : '';
          const password = typeof body?.['password'] === 'string' ? (body['password'] as string) : '';
          await modules.admin.createUser(ctx, username, password);
          send(res, 200, {success: true});
          return;
        }
      }

      // The record routes go through the one door (yourphr#609). A record with no source
      // attribution is shown under the legacy `sourceId` the contract harnesses pin.
      const fallbackSource = options.sourceId ?? 'spike';
      const attributed = (row: Record<string, unknown>): Record<string, unknown> => (row['source_id'] === '' ? {...row, source_id: fallbackSource} : row);

      // GET /api/secure/resource/fhir?sourceResourceType=Condition[&sourceID=…]
      if (url.pathname === '/api/secure/resource/fhir' && req.method === 'GET') {
        const resourceType = url.searchParams.get('sourceResourceType');
        if (!resourceType) {
          send(res, 400, {success: false, error: 'sourceResourceType is required'});
          return;
        }
        const rows = await engine.managers.records.list(ctx, resourceType, {
          limit: Number(url.searchParams.get('limit') ?? 100000),
          sourceId: url.searchParams.get('sourceID') ?? undefined,
        });
        send(res, 200, {success: true, data: rows.map(attributed)});
        return;
      }

      // GET /api/secure/resource/fhir/:sourceId/:resourceId — the detail page
      const detail = url.pathname.match(/^\/api\/secure\/resource\/fhir\/([^/]+)\/([^/]+)$/);
      if (detail && req.method === 'GET') {
        send(res, 200, {success: true, data: attributed(await engine.managers.records.detail(ctx, detail[2]!))});
        return;
      }

      // GET /api/secure/summary — what the dashboard counts from
      if (url.pathname === '/api/secure/summary' && req.method === 'GET') {
        send(res, 200, {
          success: true,
          data: {
            resource_type_counts: await engine.managers.records.countsByType(ctx),
            sources: options.modules?.sources ? options.modules.sources.list(sessionUser) : [{id: fallbackSource, display: 'spike'}],
            patients: [],
          },
        });
        return;
      }

      if (options.webDir && !url.pathname.startsWith('/api/')) {
        serveStatic(options.webDir, url.pathname, res);
        return;
      }

      send(res, 404, {success: false, error: 'not found'});
    } catch (err) {
      // The one error boundary: a guard's refusal in the envelope, everything else a 500 that
      // reaches the caller rather than vanishing — the lesson of the product repo's #527.
      if (err instanceof ApiError) {
        send(res, err.status, {success: false, error: err.message, ...err.extra});
        return;
      }
      send(res, 500, {success: false, error: (err as Error).message});
    }
  });
}
