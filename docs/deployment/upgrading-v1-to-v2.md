# Upgrading YourPHR v1 (Go) to v2 (TypeScript)

For anyone self-hosting YourPHR who is not running Kubernetes. If you are, the operator runbook is [`cutover-runbook.md`](cutover-runbook.md) — this page is the general path.

> __Status: written 2026-08-24, ahead of the v2 release.__ The migration itself is proven — it has been rehearsed against a real 20,068-record instance and verified record for record — and since [#654](https://github.com/jwilleke/yourphr/issues/654) step 2 below is a command the image actually has. What is __not__ yet true is the rest of the packaging: there is no compose file for v2. It is named at the bottom. Do not follow this page until v2.0.0 is released.

## What is changing, and what is not

__The backend is a rewrite.__ v1 is Go; v2 is TypeScript. Same records, same address, same passwords.

__Your data is not rewritten in place.__ The migration __reads__ your v1 database and __writes__ a new one alongside it. Your v1 data is untouched, which is what makes rolling back possible: if v2 does not suit you, start v1 again and it is exactly as you left it.

__What carries:__ every record, your accounts and their roles, connected sources with their tokens, the provider catalog, legal consent, the access log, and the settings that still mean the same thing.

__What does not:__

- __Sources with no refresh token__ will ask to be reconnected when their current token expires. Not a failure — v1 never stored one for them. Expect it, and tell the household.
- __Three backup-schedule settings__ (`backup.auto-backup`, `-days`, `-time`) do not carry, because v2 schedules differently. Set them again in Admin → Configuration.
- The migration report names anything it did not carry. __Read it__ rather than assuming silence means completeness.

## Before you start

__Back up, and check the backup opens.__ This is the one step that is not optional. An untested backup is a hope.

__Know your encryption keys, if you set any.__ If your v1 instance encrypts its database, you need that key for the migration and v2 needs it every time it starts. Write it somewhere that is not the machine YourPHR runs on: if the disk is lost and the key with it, the records are unreadable. Permanently.

__Stop v1 first.__ SQLite has one writer. Copying a database from a running instance can produce a file that looks fine and is not.

## The upgrade

```bash
# 1. stop v1 and take a copy of the data directory
docker compose down
cp -r ./db ./db-v1-backup

# 2. migrate the copy into a new data directory
docker run --rm \
  -v "$PWD/db-v1-backup:/old:ro" \
  -v "$PWD/data:/opt/yourphr/data" \
  ghcr.io/jwilleke/yourphr:2.0.0 \
  migrate --go /old/fasten.db --go-data /old --data /opt/yourphr/data

# 3. read the report. It ends with either
#      MIGRATION VERIFIED — ...        (every record accounted for)
#    or a named disagreement. Do not continue on a red report.

# 4. point compose at v2 and the new data directory, then start
docker compose up -d
```

The v1 database is mounted __read-only__ (`:ro`) on purpose. The migration cannot damage what it is reading, however badly it goes.

## After

__Sign in as yourself and as one other household member.__ Passwords are unchanged — v1's hashes carry across and re-hash on first sign-in.

Then check, in this order, because each answers a different question:

1. __Your records are there.__ Open Explore and a couple of individual records.
2. __Sources are listed__, and any needing reconnection say so.
3. __Account → access log shows today.__ On v2 a read that cannot be logged fails rather than completing silently, so an empty log after signing in is a stop signal, not a cosmetic gap.

## If it goes wrong

Start v1 again. Your v1 data directory was never written to.

```bash
docker compose down
# point compose back at the v1 image and ./db-v1-backup
docker compose up -d
```

Records you created __on v2__ after the switch stay on v2 — export them first if they matter.

## How long it takes

A rehearsal against a real instance — 20,068 records, a 111 MB database — took __87 seconds__ to migrate and verify. Budget a few minutes including stopping and starting. A much larger instance scales roughly with record count.

## Not yet true

One prerequisite for this page being followable is still open, and is tracked:

- __There is no v2 compose file.__ [#641](https://github.com/jwilleke/yourphr/issues/641) covers shipping one, along with example Kubernetes manifests and a bare-metal path.

Settled since this page was written: the migration __does__ ship in the image ([#654](https://github.com/jwilleke/yourphr/issues/654)). Step 2 is one of several commands the entrypoint accepts — `migrate`, `reset-password`, `version`, `help`, and `start`, which is what an argument-less `docker run` does. Run `docker run --rm ghcr.io/jwilleke/yourphr:<version> help` to see them.
