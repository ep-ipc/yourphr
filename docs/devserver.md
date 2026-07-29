# Running the dev servers

Local development runs **two processes**: the Go API and the Angular dev server. The frontend dev server proxies `/api` to the backend, so you browse the SPA on `:4200` and it talks to the API on `:9090`.

## Prerequisites

- **`config.dev.yaml`** at the repo root (gitignored; copy/adapt from the committed `config.yaml`). It sets the backend listen port and dev settings (encryption off, debug). `make serve-backend` requires it.

## Start

In two terminals:

```bash
make serve-backend      # Go API on :9090 (config.dev.yaml, --debug)
make serve-frontend     # ng serve on :4200; proxies /api -> :9090 (sandbox mode)
```

Then open **<http://localhost:4200>**.

## LAN access (other devices)

By default `ng serve` binds to `localhost` only. To reach the dev app from another device on your network (a phone, another machine) use the LAN target instead of `serve-frontend`:

```bash
make serve-frontend-lan   # ng serve on 0.0.0.0 (+ --disable-host-check), still :4200
```

Then browse to `http://<this-host-ip>:4200` from the other device. The backend already listens on all interfaces (`:9090`), so no change is needed there.

`--disable-host-check` accepts the LAN IP as the `Host` header (it turns off the dev server's DNS-rebinding protection). **Dev-only, trusted networks only** — don't expose it on an untrusted network.

## Notes

- **Ports:** backend **9090** (`config.dev.yaml` `web.listen.port` — the `ng serve` dev proxy forwards `/api` here), frontend **4200**.
- **Sandbox mode:** the frontend dev server defaults to **sandbox** (talks only to synthetic-data test servers). `prod` mode talks to real servers; pick the build config with `-c` (e.g. `make build-frontend-prod`).
- **Version:** the footer shows `dev-<version>` (e.g. `dev-1.12.0`) via the public `/api/version` endpoint.
- **Dev data:** synthetic patient logins live in the local dev SQLite DB (persists on disk between restarts). See [Dev test accounts](#dev-test-accounts).

## Dev test accounts

Synthetic accounts seeded in the local dev SQLite DB (they persist across restarts). All share **one** dev password kept in `private/secrets.md` (gitignored) — not committed here.

- `test` — admin
- `clopez` — Epic sandbox (Camila Lopez): conditions / encounters / documents
- `jdoe` — Synthea: full happy-path record (encounters)
- `aheller` — Synthea (encounters)
- `bblick` — Synthea (encounters)
- `nsmart` — Oracle/Cerner sandbox (Nancy Smart): documents + allergies only (no `Patient`/`Encounter`)

## Check whether they're running

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(9090|4200)'
curl -s -o /dev/null -w "backend  %{http_code}\n" http://localhost:9090/api/version
curl -s -o /dev/null -w "frontend %{http_code}\n" http://localhost:4200/
```

A connection refused on both means dev is **not** running — start it with the two `make` commands above. (Note: a local listener on `:3000` is the separate ngdpbase "jimstest" app, **not** YourPHR.)

## Troubleshooting a local-only build/test failure

If `ng test` / `ng serve` / `make test-frontend-coverage` fails locally but **CI passes on the same commit**, the cause is almost always stale local state — not the code and not the lockfile. Work through these in order; each is cheap and safe (all three targets are gitignored and regenerate themselves).

### 1. `Cannot find module` / `Can't resolve` a path containing `.../node_modules/.../node_modules/...`

Clear the Angular build cache **first**:

```bash
make clean-frontend-cache
```

> `make dep-frontend` now clears this cache automatically whenever `frontend/yarn.lock` changes (it hashes the lockfile into `frontend/.angular/.yarn-lock-hash`), and every `serve-*` / `build-*` / `test-*` target depends on `dep-frontend`. So this failure should no longer occur after a normal `git pull` + build. Reach for the manual command if you hit it anyway, or to reclaim disk.

The cache stores **absolute** resolved paths. When a dependency bump changes how packages nest — e.g. a `resolutions` pin hoisting `@babel/runtime` out of `@angular-devkit/build-angular/node_modules/` — the cached paths point at directories that no longer exist. It lives **outside `node_modules`, so reinstalling never clears it**, and the error reads like a broken install, which sends you down the wrong path. CI never hits this because it starts with no cache.

Also worth checking its size — Angular CLI offers no maximum-size setting and never prunes, so on a long-lived checkout it can reach tens of GB (89 GB on this one before it was first cleared):

```bash
du -sh frontend/.angular/cache
```

### 2. A module genuinely missing from `node_modules`

```bash
rm -rf frontend/node_modules && make dep-frontend
```

Needed after merging any PR that changes `frontend/yarn.lock`. A plain `make dep-frontend` may report "Already up-to-date" and do nothing when the tree is inconsistent rather than incomplete — delete `node_modules` to force it.

### 3. Go equivalent

```bash
go mod vendor
```

`vendor/` is gitignored and goes stale after any `go.mod` change, producing `inconsistent vendoring` errors.

> **Verify the behaviour, not a proxy.** After any of these, re-run the actual suite and check the **exit code** — do not conclude from whether a file is now present, or from filtered command output. `grep -c` exits non-zero when it matches nothing, so a "no failures found" filter can itself look like a failure (and vice versa).

## Related

- `Makefile` — the `serve-*` / `build-*` targets.
- `AGENTS.md` — the Commands section.
- `config.yaml` — the template for `config.dev.yaml`.
