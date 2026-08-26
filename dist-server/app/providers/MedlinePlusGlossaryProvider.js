/**
 * MedlinePlus Connect (yourphr#640): the US National Library of Medicine's plain-language
 * explanations of medical codes, ported from the Go stack's `handler/glossary.go`.
 *
 * Two things carried over from Go verbatim, both learned the hard way there:
 *
 *   - __IPv4 only.__ Go's comment: "when using IPV6 to communicate with MedlinePlus, we're getting
 *     timeouts. Force IPV4". Kept, because an intermittent 10-second hang on a lab page is worse
 *     than the loss of IPv6.
 *   - __A 10-second timeout.__ This runs while somebody is looking at their results.
 *
 * Through the guarded HTTP client like every other outbound call, so the SSRF posture is the same
 * one the SMART client answers to — this is the only read path that leaves the LAN for something
 * that is not a provider sync.
 */
import { guardedFetch } from '../../http/guarded-fetch.js';
import { BaseGlossaryProvider } from './BaseGlossaryProvider.js';
const ENDPOINT = 'https://connect.medlineplus.gov/service';
export class MedlinePlusGlossaryProvider extends BaseGlossaryProvider {
    options;
    name = 'medlineplus';
    available = true;
    unavailableReason = '';
    constructor(options = {}) {
        super();
        this.options = options;
    }
    async explain(code, codeSystemOid) {
        const params = new URLSearchParams({
            'informationRecipient.languageCode.c': 'en',
            knowledgeResponseType: 'application/json',
            'mainSearchCriteria.v.c': code,
            'mainSearchCriteria.v.cs': codeSystemOid,
        });
        const response = await guardedFetch(`${ENDPOINT}?${params.toString()}`, {
            timeoutMs: this.options.timeoutMs ?? 10_000,
            allowInternal: this.options.allowInternal ?? false,
            // The answer is a few kilobytes; a large body here means something is wrong, not verbose.
            maxBytes: 512 * 1024,
        });
        if (response.status !== 200) {
            throw new Error(`glossary: MedlinePlus answered ${response.status} for ${code}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(response.body.toString('utf8'));
        }
        catch (err) {
            throw new Error(`glossary: MedlinePlus returned something that is not JSON (${err.message})`);
        }
        // No entry is a NORMAL answer: the sources do not describe every code. The caller renders
        // "not available"; treating it as an error would put a red box on a perfectly good lab page.
        const entry = parsed.feed?.entry?.[0];
        if (!entry)
            return undefined;
        return {
            title: entry.title?._value ?? '',
            description: entry.summary?._value ?? '',
            url: entry.link?.[0]?.href ?? '',
            publisher: parsed.feed?.author?.name?._value ?? 'MedlinePlus',
            updatedAt: entry.updated?._value ?? new Date().toISOString(),
        };
    }
}
//# sourceMappingURL=MedlinePlusGlossaryProvider.js.map