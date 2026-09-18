# Technical Design — Agent Publisher

## Browser Runtime

The `browser-runtime` container provides a stable, headful Chromium process running inside an Xvfb virtual framebuffer. It is the foundation for all authenticated browser sessions.

### Key decisions

| Concern | Choice | Rationale |
|---|---|---|
| Display | Xvfb on `DISPLAY=:99` | Stable virtual framebuffer; no GPU required |
| Browser | Chromium (system package) | Reproducible, no Playwright binary management needed at this layer |
| Profile | Named Docker volume at `/data/profile` | Persists session/cookies across container restarts |
| Remote Debugging | `--remote-debugging-port=9222` | Internal CDP access for agent adapters; not exposed publicly |
| noVNC | Not in scope for M1 | Added later when human-handoff UI is required |

### Internal ports

| Port | Purpose | Exposure |
|---|---|---|
| 9222 | Chrome DevTools Protocol | Compose-internal only |

### Health check

A minimal `curl` against `http://localhost:9222/json/version` confirms that Chromium has started and the debugger is accepting connections.

### Non-goals (M1)

- BrowserProvider integration
- noVNC / websockify
- Human-handoff UI
- Xiaohongshu adapter
