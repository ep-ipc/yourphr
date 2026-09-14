# Importing C-CDA / CCD (XML) documents

Many patient portals — Epic MyChart in particular — export a __C-CDA__ (Consolidated Clinical Document Architecture) XML document rather than a FHIR JSON bundle. YourPHR imports FHIR natively; C-CDA has to be converted first.

Conversion runs __entirely on your own network__, in a separate converter service. The raw document is a whole medical record in the clear, so the converter must stay internal and is never a third party.

> __Upgrading from v2 (Go)?__ The v2 settings — `cda_converter.*` in `config.yaml`, and the `YOURPHR_CDA_CONVERTER_*` / `CDA_CONVERTER_ENABLED` environment variables — are __not read by v3__. Set the two settings below instead. C-CDA import was missing entirely from v3.0.0 through v3.4.0 ([#735](https://github.com/jwilleke/yourphr/issues/735)); it came back after v3.4.0.

## Setting it up

Two steps: run the converter next to YourPHR, then tell YourPHR where it is.

### 1. Run the converter

The image is `ghcr.io/jwilleke/yourphr-cda-converter:main` (public, amd64 and arm64). It listens on port 8080 and stores nothing.

__Docker.__ Put the converter and YourPHR on the same user-defined network so YourPHR can reach it by name, and __do not publish its port__:

```bash
docker network create yourphr
docker run -d --name yourphr-cda-converter --network yourphr --restart unless-stopped \
  ghcr.io/jwilleke/yourphr-cda-converter:main
docker network connect yourphr <your-yourphr-container>
```

The default `bridge` network does not resolve container names, which is why a named network is needed.

__Kubernetes.__ See [`deploy/yourphr-cda-converter.example.yaml`](../../deploy/yourphr-cda-converter.example.yaml): a Deployment and a ClusterIP Service, with no Ingress.

### 2. Point YourPHR at it

Signed in as an admin, open __Admin → Configuration__ and set:

| Setting | Value |
|---|---|
| `yourphr.cda-converter.url` | the converter as YourPHR reaches it, e.g. `http://yourphr-cda-converter:8080` |
| `yourphr.cda-converter.enabled` | `true` (the default) |
| `yourphr.cda-converter.timeout-seconds` | `60` (the default); raise it for very large exports |

No restart is needed: the settings are read on every upload. They are ordinary settings, not environment variables ([#472](https://github.com/jwilleke/yourphr/issues/472)). An operator who wants the value in `.env` can still write `"${SOME_VAR}"` as the setting's value in `app-custom-config.json`.

To turn C-CDA import off, set `yourphr.cda-converter.enabled` to `false`. The Sources page then says it is off instead of offering a conversion.

## Checking what the server sees

The Sources page asks this before it offers to convert a file, and shows the setup steps when the answer is no:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://your-instance/api/secure/source/cda-converter/status
# {"success":true,"data":{"enabled":true,"ready":true,"setup_hint":"..."}}
```

- `enabled` — the on/off switch alone.
- `ready` — switched on __and__ an address is set. Only `ready: true` converts.

`ready` does not prove the converter is running; an upload does. If it is not, the upload says so (see Troubleshooting).

## What happens to the document

YourPHR posts the raw document to the converter (the open-source [Metriport fhir-converter](https://github.com/metriport/metriport/tree/master/packages/fhir-converter)), receives a FHIR R4 bundle, and imports it like any uploaded FHIR file.

- The patient id is derived deterministically from the document's `recordTarget/patientRole/id`, the same way v2 derived it. Re-importing the same person's documents lands on the same Patient rather than creating another, and on a migrated instance it matches the Patients v2 created.
- Uploads for the same patient go into the same source, so a re-upload updates records in place. A record another connected source already holds under the same id is left out and counted, never merged. The page says how many.
- YourPHR can reach the converter's address and nothing else through this path. It follows no redirects, and the address never appears in the patient's browser ([`src/http/internal-service.ts`](../../src/http/internal-service.ts)).

## Troubleshooting

| Message | Meaning |
|---|---|
| `C-CDA import is turned off on this server` | `yourphr.cda-converter.enabled` is `false` |
| `C-CDA import is enabled but no converter address is configured` | `yourphr.cda-converter.url` is empty — the most common case on a fresh install |
| `The converter address yourphr.cda-converter.url is not usable` | the value is not an `http://` or `https://` address, or it carries a username/password |
| `The C-CDA converter did not answer at the configured address (ECONNREFUSED)` | the converter is not running, or YourPHR cannot reach it by that name — check both containers are on the same network |
| `(ENOTFOUND)` in the same message | the host name does not resolve — on Docker, usually the default `bridge` network |
| `no answer within 60s` | a very large export; raise `yourphr.cda-converter.timeout-seconds` |
| `The C-CDA converter could not convert this document (HTTP 4xx/5xx)` | the converter rejected the document; the text after the status is the converter's own |
