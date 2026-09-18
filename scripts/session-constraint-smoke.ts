/**
 * M1-04 single-session constraint smoke.
 *
 * Verifies:
 *   1. A second concurrent acquire is rejected with a clear error.
 *   2. After release the provider accepts a fresh acquire (release → reacquire).
 *
 * Run against a live browser-runtime container:
 *   npx tsx scripts/session-constraint-smoke.ts
 */
import { DockerCdpBrowserProvider } from "../src/browser/providers/docker-cdp.js";

async function main(): Promise<void> {
  const provider = new DockerCdpBrowserProvider();

  const health = await provider.health();
  if (health.status !== "reachable") {
    throw new Error(`Browser runtime unavailable: ${health.message}`);
  }
  console.log("[session-constraint-smoke] health=reachable");

  // Phase 1: acquire a session then attempt a concurrent second acquire.
  const first = await provider.acquire({});
  console.log(`[session-constraint-smoke] first-session id=${first.id}`);

  try {
    await provider.acquire({});
    throw new Error(
      "Expected second acquire to throw but it succeeded — single-session constraint is missing",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /already active/i.test(error.message)
    ) {
      console.log(
        "[session-constraint-smoke] concurrent-acquire-rejected=ok",
      );
    } else {
      throw error;
    }
  }

  // Phase 2: release then reacquire.
  await provider.release(first.id);
  console.log("[session-constraint-smoke] first-session released");

  const second = await provider.acquire({});
  console.log(`[session-constraint-smoke] second-session id=${second.id}`);
  await provider.release(second.id);
  console.log(
    "[session-constraint-smoke] release-reacquire=ok",
  );
}

main().catch((error: unknown) => {
  console.error(
    "[session-constraint-smoke] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
