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

The product Docker path exposes one user-facing Web endpoint. Browser runtime,
noVNC, and CDP stay behind the application boundary during normal use.

Prerequisite: Docker Desktop / Docker Engine. Node.js is only needed for local
development or repository checks.

```bash
git clone https://github.com/sanchuang-dev/agent-publisher.git
cd agent-publisher
git checkout dev
cp .env.example .env
```

Fill the Publisher AI settings in the repository-local ignored `.env`:

```dotenv
PUBLISHER_AI_BASE_URL=https://your-openai-compatible-gateway.example/v1
PUBLISHER_AI_MODEL=your-model-id
PUBLISHER_AI_API_KEY=your-key
```

Then start the product:

```bash
docker compose up -d --build
```

The browser image uses Debian's official package source by default. If a local
network cannot reach it reliably, set `DEBIAN_MIRROR` in `.env` (for example
`mirrors.ustc.edu.cn`) before building. This is an optional network override,
not part of the runtime contract.

Open **http://127.0.0.1:3000**.

That URL owns the production Web bundle, Job API, SSE stream, and the controlled
human-takeover browser surface. Normal task operation does not require
`npm run dev:web`, `curl`, raw `:6080`, or a CDP address.

Persistent state is split intentionally:

- `app-data` keeps SQLite state, Publisher assets, and Pi session files.
- `browser-profile` keeps the Chromium profile/login session.

A normal restart preserves both volumes:

```bash
docker compose restart
```

Stop the containers without deleting persistent state with:

```bash
docker compose down
```

### Development Web with Vite HMR

Production Docker does not need Vite. For frontend development, keep the Docker
runtime running and start the development server separately:

```bash
npm install
npm run dev:web
```

Open **http://127.0.0.1:5173**. The Vite server proxies both `/api` and
`/browser-live-view` to the app runtime, including the noVNC WebSocket path, so
development keeps the same product boundary instead of reopening raw browser
ports.

### Controlled Docker smoke mode

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
`"generatedFromBrief": false`. This mode is for bounded verification; the
normal product runtime remains `provider_pipeline`.

### Troubleshooting browser runtime

The base Compose file does **not** publish raw noVNC `6080` or CDP `9222`.
Start with product-level logs and readiness:

```bash
docker compose ps
docker compose logs app-runtime browser-runtime
```

If a developer specifically needs direct noVNC for a browser-runtime diagnostic,
opt in to the localhost-only troubleshooting overlay:

```bash
docker compose -f compose.yaml -f compose.troubleshooting.yaml up -d browser-runtime
```

Then `http://127.0.0.1:6080/vnc.html` is available on the Docker host for that
diagnostic session only. Return to the normal product boundary afterwards:

```bash
docker compose up -d --force-recreate browser-runtime app-runtime
```

Raw CDP is never host-published. Inspect it only from inside the browser
container when debugging:

```bash
docker compose exec -T browser-runtime \
  curl -fsS http://127.0.0.1:9222/json/version
```

### Run the real Xiaohongshu prepare smoke

This developer smoke uses the production XHS login/prepare boundaries and still
stops at `waiting_for_approval`; it does not publish.

Because the MVP BrowserProvider lock is process-local, stop the long-running app
container before starting the one-off smoke. If human login inspection may be
needed, first enable the troubleshooting noVNC overlay described above.

```bash
docker compose stop app-runtime
docker compose run --rm --build -e XHS_REAL_ACCOUNT_SMOKE=1 \
  app-runtime npm run smoke:xhs-prepare
```

If Xiaohongshu requires QR login, 2FA, device verification, or another identity
step, use the troubleshooting noVNC surface and complete that step yourself. The
smoke automatically resumes from the same persistent browser profile when the
accepted login state is detected.

Expected bounded evidence ends at `waiting_for_approval`. The smoke does not
print cookies, tokens, QR artifacts, browser-profile contents, or raw local
asset paths, and it exposes no approval-resolution/final-publish action.

The default login wait is 5 minutes. For a bounded local smoke,
`XHS_SMOKE_LOGIN_WAIT_MS` may be set from 0 to 900000 milliseconds.

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

Do not commit the key or paste it into Issue/PR evidence. For local development and Compose, storing the three `PUBLISHER_AI_*` values in the repository-local ignored `.env` file is supported. The smoke prints only bounded provider/model/MaterialPlan/checkpoint evidence and uses a disposable local database/session directory.

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
