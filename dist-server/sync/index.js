import { OutboundHttp } from '../http/index.js';
const DEFAULT_MAX_PAGES = 500;
/**
 * The next page URL, or undefined when the bundle is the last one.
 *
 * A `next` link is a provider-supplied URL that this client will follow while holding an access
 * token, so it is checked twice: the guarded capability refuses internal addresses, and this
 * refuses a link that leaves the origin the sync started from. Without the second check a provider
 * could page a caller onto an unrelated host and be handed the Authorization header.
 */
export function nextPageUrl(bundle, currentUrl) {
    const link = (bundle.link ?? []).find((l) => l.relation === 'next');
    if (!link?.url) {
        return undefined;
    }
    let candidate;
    let origin;
    try {
        candidate = new URL(link.url, currentUrl);
        origin = new URL(currentUrl);
    }
    catch {
        throw new Error(`unusable next link: ${link.url}`);
    }
    if (candidate.origin !== origin.origin) {
        throw new Error(`refusing a next link that leaves the origin: ${candidate.origin} is not ${origin.origin} — ` +
            'the access token would be sent there');
    }
    return candidate.href;
}
/**
 * Fetches every page from `startUrl` and stores what comes back.
 *
 * Storage goes through the repository's create/update path, which keys on (resourceType, id, user).
 * So a resource that arrives twice — across a resync, or twice within one run — updates in place
 * rather than inserting again. That is where idempotence comes from; it is a property of the
 * primary key, not of anything clever here.
 */
export async function syncFrom(startUrl, options) {
    const { accessToken } = options;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const http = new OutboundHttp({ allowInternal: options.allowInternal });
    // The door the records go through (yourphr#609): a writer bound to the account and the source.
    // A repository-bound writer is built here for the harnesses that hand a repository in directly.
    const writer = options.writer ?? repositoryWriter(options.repo, options.sourceId ?? '');
    const report = {
        pages: 0,
        collisions: [],
        received: 0,
        created: 0,
        updated: 0,
        duplicatesWithinRun: 0,
        byType: {},
        skipped: [],
    };
    const seenThisRun = new Set();
    let url = startUrl;
    try {
        while (url) {
            if (report.pages >= maxPages) {
                throw new Error(`stopped after ${maxPages} pages — a provider that always returns a next link`);
            }
            const response = await http.get(url, {
                headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
            });
            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status} fetching ${url}: ${response.body.toString('utf8').slice(0, 256)}`);
            }
            let bundle;
            try {
                bundle = JSON.parse(response.body.toString('utf8'));
            }
            catch (err) {
                throw new Error(`decoding the bundle from ${url}: ${err.message}`);
            }
            if (bundle.resourceType !== 'Bundle') {
                throw new Error(`expected a Bundle from ${url}, got ${String(bundle.resourceType)}`);
            }
            report.pages++;
            for (const entry of (bundle.entry ?? [])) {
                const resource = entry.resource;
                if (!resource?.resourceType) {
                    report.skipped.push({ reason: 'entry carried no resource', detail: JSON.stringify(entry).slice(0, 120) });
                    continue;
                }
                if (!resource.id) {
                    // Without an id there is no way to recognise this record on the next sync, so storing it
                    // would guarantee a duplicate later. Refusing is the honest outcome.
                    report.skipped.push({ reason: 'resource had no id', detail: resource.resourceType });
                    continue;
                }
                report.received++;
                const key = `${resource.resourceType}/${resource.id}`;
                if (seenThisRun.has(key)) {
                    report.duplicatesWithinRun++;
                }
                seenThisRun.add(key);
                let outcome;
                try {
                    outcome = await writer.upsert(resource);
                }
                catch (err) {
                    const message = err.message;
                    if (message.includes('cross-source id collision')) {
                        // Reported and skipped rather than aborting the run: one contested id must not cost the
                        // patient the other 20,000 records in the sync.
                        report.collisions.push({ resource: key, detail: message });
                        continue;
                    }
                    throw err;
                }
                if (outcome === 'updated') {
                    report.updated++;
                }
                else {
                    report.created++;
                    report.byType[resource.resourceType] = (report.byType[resource.resourceType] ?? 0) + 1;
                }
            }
            url = nextPageUrl(bundle, url);
        }
    }
    finally {
        // nothing to restore: the writer carries its own source attribution
    }
    return report;
}
/** A writer over a repository handle, attributing every write to one source and restoring afterwards. */
export function repositoryWriter(repo, sourceId) {
    return {
        upsert: async (resource) => {
            let existed = true;
            try {
                await repo.readResource(resource.resourceType, resource.id);
            }
            catch {
                existed = false;
            }
            const previous = repo.sourceId;
            repo.sourceId = sourceId;
            try {
                await repo.updateResource(resource);
            }
            finally {
                repo.sourceId = previous;
            }
            return existed ? 'updated' : 'created';
        },
        exists: async (resourceType, id) => {
            try {
                await repo.readResource(resourceType, id);
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
//# sourceMappingURL=index.js.map