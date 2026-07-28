# Importing C-CDA / CCD (XML) documents

Many patient portals — Epic MyChart in particular — export a **C-CDA** (Consolidated Clinical Document Architecture) XML document rather than a FHIR JSON bundle. YourPHR imports FHIR natively; C-CDA has to be converted first.

Conversion runs **entirely on your own server**, in a separate container. The raw document is PHI and is never sent to a third party.

## Why an upload fails out of the box

The converter is a **separate sidecar container that is off by default**, so a stock install rejects XML uploads with:

```text
C-CDA import is not enabled on this server.
```

That is expected on a fresh install — it is configuration, not a bug.

## Enabling it (docker compose)

All three steps are required. Doing only one or two still fails.

```bash
# 1. start the converter sidecar (it is behind a compose profile, so a plain `up` skips it)
docker compose --profile cda up -d
```

```bash
# 2. + 3. add to your .env (or .env_custom) and restart the app
YOURPHR_CDA_CONVERTER_ENABLED=true
YOURPHR_CDA_CONVERTER_URL=http://cda-converter:8080
```

```bash
docker compose up -d   # restart so the app picks up the new variables
```

Then retry the upload. The Convert dialog only offers a **Convert** button when the server reports the converter is ready.

### Watch the variable names

This is the single most common failure ([#397](https://github.com/jwilleke/yourphr/issues/397)). The **config keys** are `cda_converter.enabled` and `cda_converter.url`. The **environment variables** are those keys upper-cased with a `YOURPHR_` prefix and `.` replaced by `_`:

| Config key | Environment variable |
|---|---|
| `cda_converter.enabled` | `YOURPHR_CDA_CONVERTER_ENABLED` |
| `cda_converter.url` | `YOURPHR_CDA_CONVERTER_URL` |
| `cda_converter.timeout_seconds` | `YOURPHR_CDA_CONVERTER_TIMEOUT_SECONDS` |

`FASTEN_CDA_CONVERTER_ENABLED` and a bare `CDA_CONVERTER_ENABLED` are **silently ignored** — the prefix is `YOURPHR_`, and an unrecognized variable produces no warning.

You can also set these in `config.yaml` instead of the environment:

```yaml
cda_converter:
  enabled: true
  url: http://cda-converter:8080
  timeout_seconds: 60
```

## Checking what the server actually sees

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://your-instance/api/secure/source/cda-converter/status
# {"success":true,"data":{"enabled":true,"ready":true,"setup_hint":"..."}}
```

- `enabled` — the opt-in flag alone.
- `ready` — the flag **and** a converter address are both set. Only `ready: true` will convert.

If `enabled` is `true` but `ready` is `false`, the URL is missing — that half-configured state is easy to miss.

## Kubernetes

An example manifest is in [`deploy/yourphr-cda-converter.example.yaml`](../../deploy/yourphr-cda-converter.example.yaml). Set `cda_converter.url` to the in-cluster service address (e.g. `http://yourphr-cda-converter:8080`) and keep the service internal — do not expose it publicly.

## What the converter does

The sidecar is the open-source [Metriport fhir-converter](https://github.com/metriport/metriport/tree/master/packages/fhir-converter). YourPHR posts the raw document, receives a FHIR R4 bundle, and feeds it through the normal import pipeline. The patient id is derived deterministically from the document's `recordTarget/patientRole/id`, so re-importing the same person's documents does not create duplicate patients.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `C-CDA import is not enabled on this server` | `YOURPHR_CDA_CONVERTER_ENABLED` unset, misspelled, or wrong prefix |
| `no converter address is configured` | `YOURPHR_CDA_CONVERTER_URL` unset — the flag alone is not enough |
| `C-CDA conversion service unavailable` | sidecar not running; start it with `docker compose --profile cda up -d` |
| Conversion times out on a large export | raise `YOURPHR_CDA_CONVERTER_TIMEOUT_SECONDS` |
