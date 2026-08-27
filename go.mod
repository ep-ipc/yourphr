// The SMART on FHIR store-and-poll OAuth relay (EPIC yourphr#20, yourphr#50).
//
// This module exists for ONE binary. When the Go application was deleted (yourphr#677) the relay
// was the only Go left standing: it is deployed in production, the deployment contract publishes
// ghcr.io/jwilleke/yourphr-relay at every release, and the TypeScript stack has no replacement for
// it yet — /api/secure/source/relay-config reports "not configured" rather than pretending.
//
// It survives the deletion cleanly because it is PURE STDLIB — no requires, so no go.sum and no
// vendor/ (132 MB of vendored dependencies went with the application). Keep it that way: a single
// dependency here brings back the whole supply chain this deletion removed.
//
// The module path no longer says fastenhealth (yourphr#676). Nothing imports this module, so the
// path is free to be honest about whose code it is.
module github.com/jwilleke/yourphr/relay

go 1.26.1

toolchain go1.26.6
