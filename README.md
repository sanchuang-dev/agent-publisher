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

## Run with Docker

Prerequisites: Git and Docker Desktop / Docker Engine.

The product runtime is a two-container composition behind **one user-facing Web endpoint**:

```text
http://127.0.0.1:3000
├─ production Web UI
├─ /api/*                Job API + SSE
└─ /browser-live-view/*  controlled human-takeover surface

Compose-private only
├─ browser-runtime:6080  noVNC upstream
└─ browser-runtime:9222  CDP
```

Clone the repository, configure the Publisher AI runtime, and start Compose:

```bash
git clone https://github.com/sanchuang-dev/agent-publisher.git
cd agent-publisher
git checkout dev
cp .env.example .env
```

Edit `.env` and set the existing OpenAI-compatible runtime values:

```dotenv
PUBLISHER_AI_BASE_URL=https://your-openai-compatible-gateway.example/v1
PUBLISHER_AI_MODEL=your-model-id
PUBLISHER_AI_API_KEY=your-key
```

Then start the product:

```bash
docker compose up -d --build
```

Open **http://127.0.0.1:3000**. Normal task creation, status/SSE updates, and identity takeover all stay inside that Web origin. Do not open or publish raw noVNC/CDP ports.

Generated assets, SQLite state, and Pi session files remain in the persistent `app-data` volume. Chromium login/profile state remains in the persistent `browser-profile` volume, so normal container restarts preserve both application and browser state.

Development may still use Vite HMR with `npm run dev:web`; its `/api` and `/browser-live-view` paths proxy through the same application boundary rather than teaching the UI about raw browser ports.

### Troubleshooting and engineering smokes

Inspect service health and logs only when diagnosing a deployment:

```bash
docker compose ps
docker compose logs app-runtime browser-runtime
```

The browser's noVNC `6080` and CDP `9222` ports are intentionally Compose-internal. If a diagnostic needs to inspect them, run the diagnostic from inside the Compose network rather than publishing those ports to users.

For deterministic runtime/CI checks, `APP_MATERIAL_SOURCE=controlled_smoke` may explicitly bypass AI material generation using `data/controlled-material/material.json` plus its controlled assets. This is a testing path, not the normal product flow.

The real Xiaohongshu prepare smoke remains an engineering harness and must be the exclusive application-side browser owner:

```bash
docker compose stop app-runtime && \
docker compose run --rm --build -e XHS_REAL_ACCOUNT_SMOKE=1 app-runtime npm run smoke:xhs-prepare
```

It may upload/fill/read back the real Creator form but still stops at `waiting_for_approval`; it does not publish. Identity verification should be completed through the product Web takeover surface when the running product flow requests it.

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
