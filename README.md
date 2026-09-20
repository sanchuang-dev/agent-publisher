# Agent Publisher

Company POC for agent-assisted multi-platform content production and publishing.

## Core product document

The canonical product definition is [docs/product/PRD.md](docs/product/PRD.md).

The PRD owns durable product intent, MVP boundaries, interaction model, and product decisions. Individual work-item scope and acceptance remain in GitHub Issues.

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

To access Live View securely from another machine, create an SSH tunnel to the Docker host:

```bash
ssh -N -L 6080:127.0.0.1:6080 <user>@<HOST-LAN-IP>
```

Then open `http://127.0.0.1:6080` on the client machine.

The noVNC surface currently has no application-level password, so the default Compose mapping keeps port `6080` bound to loopback. Do not change it to a wildcard/public bind unless an authenticated proxy or equivalent access control is added.

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
