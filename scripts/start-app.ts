import type { MvpPrepublishApplication } from "../src/app/mvp-prepublish-application.js";
import {
  createConfiguredMvpPrepublishApplication,
  resolveApplicationHost,
  resolveApplicationPort,
} from "../src/app/runtime-config.js";

let application: MvpPrepublishApplication | null = null;
let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  process.stderr.write(`Agent Publisher API stopping after ${signal}.\n`);
  await application?.stop();
}

async function main(): Promise<void> {
  application = await createConfiguredMvpPrepublishApplication(process.env);
  const host = resolveApplicationHost(process.env);
  const port = resolveApplicationPort(process.env);
  const origin = await application.start({ host, port });

  process.stdout.write(`Agent Publisher API listening at ${origin}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(signal)
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          process.stderr.write(
            "Agent Publisher API shutdown failed: " +
              (error instanceof Error ? error.message : String(error)) +
              "\n",
          );
          process.exit(1);
        });
    });
  }
}

void main().catch(async (error: unknown) => {
  process.stderr.write(
    "Agent Publisher API failed to start: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );

  try {
    await application?.stop();
  } finally {
    process.exitCode = 1;
  }
});
