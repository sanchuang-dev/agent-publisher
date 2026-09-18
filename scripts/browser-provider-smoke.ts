import { DockerCdpBrowserProvider } from "../src/browser/providers/docker-cdp.js";

const expectedTitle = "Agent Publisher BrowserProvider Smoke";
const controlledUrl = `data:text/html,${encodeURIComponent(
  `<title>${expectedTitle}</title><main>browser-provider-smoke</main>`,
)}`;

async function exercise(
  provider: DockerCdpBrowserProvider,
  phase: "initial" | "reconnect",
): Promise<void> {
  const session = await provider.acquire({});

  if (session.page.url() !== "about:blank") {
    await provider.release(session.id);
    throw new Error(
      "BrowserProvider smoke refused to navigate a non-disposable persistent page",
    );
  }

  let operationError: unknown;
  let cleanupError: unknown;

  try {
    await session.page.goto(controlledUrl);
    const title = await session.page.title();
    const url = session.page.url();

    if (title !== expectedTitle) {
      throw new Error(`Unexpected title: ${title}`);
    }

    if (!url.startsWith("data:text/html,")) {
      throw new Error("Unexpected controlled page URL");
    }

    console.log(`[browser-provider-smoke] ${phase} title=${title}`);
    console.log("[browser-provider-smoke] controlled-page=ok");
  } catch (error) {
    operationError = error;
  }

  try {
    if (!session.page.isClosed()) {
      await session.page.goto("about:blank");
    }
  } catch (error) {
    cleanupError = error;
  }

  try {
    await provider.release(session.id);
  } catch (error) {
    cleanupError ??= error;
  }

  if (operationError) {
    throw operationError;
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

async function main(): Promise<void> {
  const provider = new DockerCdpBrowserProvider();

  const health = await provider.health();
  if (health.status !== "reachable") {
    throw new Error(`Browser runtime unavailable: ${health.message}`);
  }

  console.log("[browser-provider-smoke] health=reachable");
  await exercise(provider, "initial");
  await exercise(provider, "reconnect");
  console.log("[browser-provider-smoke] release-and-reconnect=ok");
}

main().catch((error: unknown) => {
  console.error(
    "[browser-provider-smoke] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
