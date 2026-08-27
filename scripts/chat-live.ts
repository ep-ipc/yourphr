/**
 * A live chat instance over real infrastructure (yourphr#594): a Typesense sidecar and an operator's
 * own model. Boots the app, imports one synthetic Synthea bundle for one account, indexes it, and
 * serves the built Angular app so the chat page can be used in a browser.
 *
 * Synthetic records only — these are Synthea patients, not people.
 *
 *   CHAT_LIVE_BUNDLE   path to the Synthea bundle to import
 *   CHAT_LIVE_WEB_DIR  the built Angular app (optional; API-only without it)
 *   CHAT_LIVE_PORT     default 18222
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import { assembleApp } from '../src/app.js';
import { ApiContext } from '../src/framework/ApiContext.js';

const bundlePath = process.env['CHAT_LIVE_BUNDLE'];
if (!bundlePath || !existsSync(bundlePath)) {
  console.error(`[chat-live] set CHAT_LIVE_BUNDLE to a FHIR bundle (got ${bundlePath ?? 'nothing'})`);
  process.exit(78);
}
const webDir = process.env['CHAT_LIVE_WEB_DIR'];
const port = Number(process.env['CHAT_LIVE_PORT'] ?? 18222);
const USER = 'demo';
const PASS = 'demo-long-enough-password';
/** A second account that imports NOTHING — the control for the isolation check. */
const OTHER = 'nosy';
const OTHER_PASS = 'nosy-long-enough-password';
const SOURCE = 'synthea-import';

const dir = mkdtempSync(join(tmpdir(), 'chat-live-'));

const app = await assembleApp(dir, {
  env: {
    YOURPHR_CHAT_PROVIDER: 'typesense',
    YOURPHR_CHAT_TYPESENSE_URI: process.env['YOURPHR_CHAT_TYPESENSE_URI'] ?? 'http://127.0.0.1:8108',
    YOURPHR_CHAT_TYPESENSE_API_KEY: process.env['YOURPHR_CHAT_TYPESENSE_API_KEY'] ?? '',
    YOURPHR_CHAT_MODEL_ID: process.env['YOURPHR_CHAT_MODEL_ID'] ?? 'yourphr-chat',
    YOURPHR_CHAT_MODEL_NAME: process.env['YOURPHR_CHAT_MODEL_NAME'] ?? 'vllm/medgemma:4b',
    YOURPHR_CHAT_MODEL_VLLM_URL: process.env['YOURPHR_CHAT_MODEL_VLLM_URL'] ?? '',
    YOURPHR_DATABASE_ENCRYPTION_KEY: 'chat-live-at-rest-key',
    YOURPHR_BACKUP_ENCRYPTION_KEY: 'chat-live-backup-key',
  },
  ...(webDir ? { webDir } : {}),
  version: 'chat-live',
});

const admin = ApiContext.system('chat-live', 'admin', app.engine);
await app.users.createUser(admin, USER, PASS);
const who = ApiContext.system('chat-live', USER, app.engine);
await app.users.setConsent(who, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
await app.users.createUser(admin, OTHER, OTHER_PASS);
await app.users.setConsent(ApiContext.system('chat-live', OTHER, app.engine), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

// --- import the bundle through the Records door, exactly as a sync would ---
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as { entry?: { resource?: Resource }[] };
const writer = app.engine.managers.records.writer(who, SOURCE);
let written = 0;
const skipped: Record<string, number> = {};
for (const entry of bundle.entry ?? []) {
  const resource = entry.resource;
  if (!resource?.resourceType || !resource.id) continue;
  try {
    await writer.upsert(resource);
    written++;
  } catch (err) {
    skipped[resource.resourceType] = (skipped[resource.resourceType] ?? 0) + 1;
    if (Object.keys(skipped).length < 4) console.warn(`[chat-live] skipped ${resource.resourceType}/${resource.id}: ${(err as Error).message}`);
  }
}
console.log(`[chat-live] imported ${written} resource(s)${Object.keys(skipped).length ? `; skipped ${JSON.stringify(skipped)}` : ''}`);

// --- index them for chat ---
const chat = app.engine.managers.chat;
if (!chat.available()) {
  console.error(`[chat-live] chat is NOT available: ${chat.unavailable()}`);
  process.exit(1);
}
const result = await chat.reindex(who, { force: true });
console.log(`[chat-live] indexed ${result.indexed} record(s) for ${USER}`);

await new Promise<void>((resolve) => app.server.listen(port, '127.0.0.1', resolve));
console.log(`[chat-live] listening on http://127.0.0.1:${port} — sign in as ${USER} / ${PASS}`);
console.log(`[chat-live] second account, holds no records: ${OTHER} / ${OTHER_PASS}`);
console.log(`[chat-live] data in ${dir}${webDir ? `; web ${webDir}` : '; API only'}`);

const stop = async (): Promise<void> => { await app.close(); process.exit(0); };
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
