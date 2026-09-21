# Agent Publisher

Company POC for agent-assisted multi-platform content production and publishing.

## Core product document

The canonical product definition is [docs/product/PRD.md](docs/product/PRD.md).

The PRD owns durable product intent, MVP boundaries, interaction model, and product decisions. Individual work-item scope and acceptance remain in GitHub Issues.

## Roadmap

The current phase/dependency roadmap is [docs/ROADMAP.md](docs/ROADMAP.md).

GitHub Issues and Organization Project #1 remain the live lifecycle source of truth; the roadmap records sequencing and dependencies rather than duplicating task status.

## Goal

Given a content intent or source material, the system should be able to:

1. prepare platform-specific text and media through reusable external AI capabilities;
2. operate an authenticated browser session;
3. hand control to a human when identity verification is required;
4. prepare the publish form and request approval before irreversible publication;
5. publish and retain evidence of the result.

Initial platform targets are Xiaohongshu, Douyin, and WeChat Official Accounts. Xiaohongshu is the first MVP path.

## Run locally with Docker

Prerequisites: Git, Docker Desktop / Docker Engine, and Node.js >= 22.19 if you also want to run the current Web UI.

```bash
git clone https://github.com/sanchuang-dev/agent-publisher.git
cd agent-publisher
git checkout dev
docker compose up -d --build
```

Open `http://127.0.0.1:6080` on the Docker host.

### Open Live View from another computer

On the Docker host, get the SSH username and LAN IP. On macOS:

```bash
whoami
ipconfig getifaddr en0
```

Then, on the other computer, run:

```bash
ssh -N -L 6080:127.0.0.1:6080 <SSH_USERNAME>@<HOST_LAN_IP>
```

Keep that terminal open and visit `http://127.0.0.1:6080` on the other computer.

The noVNC surface currently has no application-level password, so Compose keeps port `6080` on localhost by default. Use the SSH tunnel above instead of changing the mapping to `0.0.0.0`.

The current Compose setup containerizes the browser runtime only. Run the Web UI on the host when needed:

```bash
npm install
npm run dev:web
```

Stop the browser runtime with:

```bash
docker compose down
```

The Chromium profile is stored in the `browser-profile` Docker volume, so normal restarts keep the browser session.

### Run the APP-02 API runtime

The pre-publish API is an opt-in Compose profile so the Node application shares
the private Compose network with `browser-runtime`; raw CDP `9222` remains
unexposed to the host.

The product runtime now defaults to the real built-in material pipeline:

```text
brief
→ Content Secretary
→ MaterialPlan
→ Builtin Text / Image / Design providers
→ SafeRichLayout / Takumi PNG
→ LocalAssetStore (asset://...)
→ MaterialPack
→ Xiaohongshu prepare
```

Configure the existing Publisher AI runtime in the current shell before
starting `app-runtime`:

```bash
export PUBLISHER_AI_BASE_URL="https://your-openai-compatible-gateway.example/v1"
export PUBLISHER_AI_MODEL="your-model-id"
export PUBLISHER_AI_API_KEY="your-key"

docker compose --profile app up -d --build browser-runtime app-runtime
```

Generated assets, SQLite state, and Pi session files stay under the persistent
`app-data` volume. The API is available on `http://127.0.0.1:3000`; Live
View remains on `http://127.0.0.1:6080/vnc.html`. The API surface still stops
at `waiting_for_approval` and exposes no final-publish route.

If `browser-runtime` is already healthy and you only need to start/restart the
application container, do not recycle the persistent browser profile:

```bash
docker compose --profile app up -d --build --no-deps app-runtime
```

#### Controlled material smoke mode

Deterministic CI/runtime smoke can explicitly bypass AI/material generation with
`APP_MATERIAL_SOURCE=controlled_smoke`. In that mode, provide:

```text
data/controlled-material/
├── material.json
└── assets/
    ├── cover-1.png
    ├── image-1.png
    └── image-2.png
```

`material.json` must declare `"source": "controlled_smoke"` and
`"generatedFromBrief": false`. Image files are resolved from `assetId` plus
their MIME extension inside `assets/`; local paths are not taken from the JSON
payload.

For a non-Compose development environment, `npm run start:api` also defaults
to `provider_pipeline`. Configure the three `PUBLISHER_AI_*` variables and a
reachable `BROWSER_CDP_ENDPOINT`. To use a controlled fixture instead, set
`APP_MATERIAL_SOURCE=controlled_smoke` plus
`APP_CONTROLLED_MATERIAL_PATH` and `APP_CONTROLLED_ASSET_ROOT` explicitly.

### Run the real Xiaohongshu prepare smoke

This smoke uses the production XHS-01 login boundary and XHS-02 image-text
prepare path with an isolated smoke Job/database and a generated non-sensitive
1080×1440 PNG. It can upload/fill/read back the real Creator form, but it has no
final-publish step and must finish at `waiting_for_approval`.

From the Docker host, run this as the exclusive application-side browser owner:

```bash
docker compose --profile app stop app-runtime && \
docker compose --profile app run --rm --build -e XHS_REAL_ACCOUNT_SMOKE=1 app-runtime npm run smoke:xhs-prepare
```

The first command intentionally stops the long-running product API container.
The MVP BrowserProvider lock is process-local, so the real-account smoke must
not run beside another application process that could drive the same persistent
Chromium profile. `browser-runtime` stays available for Live View and is
started automatically by Compose when needed.

If Xiaohongshu requires login, QR login, 2FA, or device verification, keep the
command running and open `http://127.0.0.1:6080`. Complete the identity step
yourself in Live View. The smoke only inspects the page while human takeover is
active and automatically resumes when the accepted XHS-01 login state is
detected on the same persistent browser profile.

Expected final bounded evidence looks like:

```json
{"smoke":"xiaohongshu-prepare","phase":"waiting_for_approval","status":"waiting_for_approval","actionType":"approval_required"}
```

The exact evidence also includes the isolated smoke Job id plus controlled
title/body-length/image-count fields. It does not print cookies, tokens, QR
artifacts, browser-profile contents, or raw local asset paths.

Safety behavior:

- without `XHS_REAL_ACCOUNT_SMOKE=1`, the command refuses to acquire the browser;
- an unrelated persistent browser page is not navigated away;
- missing auth/profile mismatch fails before upload mutation;
- a dirty/ambiguous composer fails closed instead of being overwritten;
- a post-mutation uncertain state enters the existing recovery/clarification
  boundary rather than uploading again;
- the browser stays on the prepared Creator page for human inspection;
- no approval resolution or final Publish action is available in this harness.

The default login wait is 5 minutes. For a bounded local smoke you may set
`XHS_SMOKE_LOGIN_WAIT_MS` to an integer from 0 to 900000 milliseconds.

### Run the Web MVP pre-publish smoke

With `browser-runtime` and `app-runtime` healthy, start the existing Web shell
on the Docker host:

```bash
npm install
npm run dev:web
```

Open `http://127.0.0.1:5173`, submit a Xiaohongshu image-text task, and keep
the task detail page open. The Web reads the real APP-02 Job/SSE projection,
shows Browser Live View only when login/verification needs human control, then
continues to the real `waiting_for_approval` summary. F3-01 stops there:
`批准发布` remains disabled and no final-publish route is called.

## Live Content Secretary model smoke

The default automated suite uses controlled Pi providers and does not require external model credentials. A real OpenAI-compatible Content Secretary smoke is an explicit manual check.

The runtime reads only these product-owned variables:

- `PUBLISHER_AI_BASE_URL`
- `PUBLISHER_AI_API_KEY`
- `PUBLISHER_AI_MODEL`

The endpoint must use HTTPS, except for an explicit loopback development endpoint.

On Windows PowerShell, set the values only in the current process and opt in to the external call:

```powershell
$env:PUBLISHER_LIVE_MODEL_SMOKE="1"
$env:PUBLISHER_AI_BASE_URL="https://your-openai-compatible-gateway.example/v1"
$env:PUBLISHER_AI_MODEL="your-model-id"
$env:PUBLISHER_AI_API_KEY="your-key"

npm run smoke:content-secretary-live

Remove-Item Env:PUBLISHER_AI_API_KEY -ErrorAction SilentlyContinue
```

Do not commit the key, put it in `.env`, or paste it into Issue/PR evidence. The smoke prints only bounded provider/model/MaterialPlan/checkpoint evidence and uses a disposable local database/session directory.

## POC boundaries

- This is not a general-purpose browser agent.
- Prefer existing capabilities and services over rebuilding image, video, browser, or model infrastructure.
- Do not design around bypassing CAPTCHA, MFA, platform risk controls, or other identity checks.
- Prefer persistent browser profiles/session state over storing raw account passwords.
- External side effects such as publish/delete should be explicit and verifiable.
- Platform automation should be isolated behind platform-specific skills/adapters.

## Engineering baseline

- Node.js + TypeScript
- Playwright for deterministic browser automation
- Agent/model capabilities used where they materially reduce brittle browser logic
- Browser runtime may be local, self-hosted, or managed behind an adapter during the POC

## Branches

The repository follows the Organization default environment flow:

```text
feat/* -> dev -> test -> prod
```

`main` is retained as a landing/governance branch and is not a production environment. Engineering work normally starts from `dev`.

See the current `sanchuang-dev/.github/AGENTS.md` for Organization-wide policy.
