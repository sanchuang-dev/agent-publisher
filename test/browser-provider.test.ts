import { expect, test } from "vitest";

import type { Browser, BrowserContext, Page } from "playwright";

import {
  DEFAULT_DOCKER_CDP_ENDPOINT,
  DockerCdpBrowserProvider,
} from "../src/browser/providers/docker-cdp.js";

function pageStub(options: { closed?: boolean; onClose?: () => void } = {}): Page {
  return {
    isClosed: () => options.closed ?? false,
    close: async () => {
      options.onClose?.();
    },
  } as unknown as Page;
}

function contextStub(options: {
  pages?: Page[];
  onNewPage?: () => void;
  newPage?: Page;
} = {}): BrowserContext {
  const pages = options.pages ?? [];
  const newPage = options.newPage ?? pageStub();

  return {
    pages: () => pages,
    newPage: async () => {
      options.onNewPage?.();
      return newPage;
    },
  } as unknown as BrowserContext;
}

function browserStub(options: {
  contexts?: BrowserContext[];
  closeError?: Error;
  onClose?: () => void;
  captureDisconnected?: (disconnect: () => void) => void;
} = {}): Browser {
  const browser = {
    contexts: () => options.contexts ?? [],
    isConnected: () => true,
    once: (event: string, listener: () => void) => {
      if (event === "disconnected") {
        options.captureDisconnected?.(() => listener());
      }
      return browser;
    },
    close: async () => {
      options.onClose?.();
      if (options.closeError) {
        throw options.closeError;
      }
    },
  };

  return browser as unknown as Browser;
}

function providerWithConnection(options: {
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  browsers?: Browser[];
  resolveEndpoint?: (endpoint: string, timeoutMs: number) => Promise<string>;
  onConnect?: (endpointURL: string, connectOptions: {
    timeout: number;
    noDefaults: true;
    isLocal: false;
  }) => void;
} = {}) {
  const browsers = options.browsers ?? [
    browserStub({
      contexts: [contextStub({ pages: [pageStub()] })],
    }),
  ];
  let browserIndex = 0;

  return new DockerCdpBrowserProvider({
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.env === undefined ? {} : { env: options.env }),
    resolveEndpoint:
      options.resolveEndpoint ??
      (async () => "ws://172.18.0.2:9222/devtools/browser/test"),
    connectOverCDP: async (endpointURL, connectOptions) => {
      options.onConnect?.(endpointURL, connectOptions);
      const browser = browsers[browserIndex++];
      if (!browser) {
        throw new Error("unexpected extra connection");
      }
      return browser;
    },
  });
}

test("uses the Compose endpoint for discovery and hands the resolved WebSocket URL to Playwright", async () => {
  let seenDiscoveryEndpoint = "";
  let seenDiscoveryTimeout = -1;
  let seenConnectEndpoint = "";
  let seenConnectTimeout = -1;
  let seenNoDefaults = false;
  let seenIsLocal = true;
  let closeCalls = 0;

  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          closeCalls += 1;
        },
      }),
    ],
    resolveEndpoint: async (endpoint, timeoutMs) => {
      seenDiscoveryEndpoint = endpoint;
      seenDiscoveryTimeout = timeoutMs;
      return "ws://172.18.0.2:9222/devtools/browser/browser-id";
    },
    onConnect: (endpointURL, connectOptions) => {
      seenConnectEndpoint = endpointURL;
      seenConnectTimeout = connectOptions.timeout;
      seenNoDefaults = connectOptions.noDefaults;
      seenIsLocal = connectOptions.isLocal;
    },
  });

  await expect(provider.health()).resolves.toEqual({ status: "reachable" });

  expect(seenDiscoveryEndpoint).toBe(DEFAULT_DOCKER_CDP_ENDPOINT);
  expect(seenDiscoveryTimeout).toBe(10_000);
  expect(seenConnectEndpoint).toBe(
    "ws://172.18.0.2:9222/devtools/browser/browser-id",
  );
  expect(seenConnectTimeout).toBe(10_000);
  expect(seenNoDefaults).toBe(true);
  expect(seenIsLocal).toBe(false);
  expect(closeCalls).toBe(1);
});

test("allows the CDP endpoint to be injected through environment or explicit config", async () => {
  const seenEndpoints: string[] = [];

  const createProvider = (
    options: ConstructorParameters<typeof DockerCdpBrowserProvider>[0],
  ) =>
    new DockerCdpBrowserProvider({
      ...options,
      resolveEndpoint: async (endpoint) => {
        seenEndpoints.push(endpoint);
        return "ws://127.0.0.1:9222/devtools/browser/test";
      },
      connectOverCDP: async () =>
        browserStub({
          contexts: [contextStub({ pages: [pageStub()] })],
        }),
    });

  await createProvider({
    env: {
      BROWSER_CDP_ENDPOINT: "http://browser-runtime-alt:9333",
    },
  }).health();

  await createProvider({
    endpoint: "http://browser-runtime-explicit:9444",
    env: {
      BROWSER_CDP_ENDPOINT: "http://ignored:9555",
    },
  }).health();

  expect(seenEndpoints).toEqual([
    "http://browser-runtime-alt:9333",
    "http://browser-runtime-explicit:9444",
  ]);
});

test("health reports unavailable without throwing when endpoint discovery fails", async () => {
  const provider = providerWithConnection({
    resolveEndpoint: async () => {
      throw new Error("connection refused");
    },
  });

  await expect(provider.health()).resolves.toEqual({
    status: "unavailable",
    message: "connection refused",
  });
});

test("health reports unavailable when Playwright cannot attach", async () => {
  const provider = new DockerCdpBrowserProvider({
    resolveEndpoint: async () =>
      "ws://172.18.0.2:9222/devtools/browser/test",
    connectOverCDP: async () => {
      throw new Error("handshake failed");
    },
  });

  await expect(provider.health()).resolves.toEqual({
    status: "unavailable",
    message: "handshake failed",
  });
});

test("acquire reuses an existing usable page and release disconnects the Playwright CDP attachment", async () => {
  let pageCloseCalls = 0;
  let newPageCalls = 0;
  let browserCloseCalls = 0;

  const existingPage = pageStub({
    onClose: () => {
      pageCloseCalls += 1;
    },
  });
  const browser = browserStub({
    contexts: [
      contextStub({
        pages: [existingPage],
        onNewPage: () => {
          newPageCalls += 1;
        },
      }),
    ],
    onClose: () => {
      browserCloseCalls += 1;
    },
  });

  const provider = providerWithConnection({ browsers: [browser] });
  const session = await provider.acquire({});

  expect(session.page).toBe(existingPage);
  expect(session.profileRef).toBe("browser-profile");
  expect(newPageCalls).toBe(0);

  await provider.release(session.id);

  expect(browserCloseCalls).toBe(1);
  expect(pageCloseCalls).toBe(0);
});

test("automation attachment is minted only for the active session owned by this provider", async () => {
  const provider = providerWithConnection({
    resolveEndpoint: async () =>
      "ws://172.18.0.2:9222/devtools/browser/owned-session",
  });
  const session = await provider.acquire({});

  await expect(
    provider.resolveAutomationAttachment(session.id),
  ).resolves.toEqual({
    sessionId: session.id,
    cdpEndpoint: "ws://172.18.0.2:9222/devtools/browser/owned-session",
  });

  await expect(
    provider.resolveAutomationAttachment("another-session"),
  ).rejects.toThrow(/currently acquired session owned by this provider/);

  await provider.release(session.id);

  await expect(
    provider.resolveAutomationAttachment(session.id),
  ).rejects.toThrow(/currently acquired session owned by this provider/);
});

test("acquire creates a page when the existing browser context has no usable page", async () => {
  let newPageCalls = 0;
  const createdPage = pageStub();
  const closedPage = pageStub({ closed: true });
  const browser = browserStub({
    contexts: [
      contextStub({
        pages: [closedPage],
        newPage: createdPage,
        onNewPage: () => {
          newPageCalls += 1;
        },
      }),
    ],
  });

  const provider = providerWithConnection({ browsers: [browser] });
  const session = await provider.acquire({});

  expect(session.page).toBe(createdPage);
  expect(newPageCalls).toBe(1);

  await provider.release(session.id);
});

test("release permits a later acquire to establish a fresh Playwright CDP attachment", async () => {
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;

  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          firstCloseCalls += 1;
        },
      }),
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          secondCloseCalls += 1;
        },
      }),
    ],
  });

  const first = await provider.acquire({});
  await provider.release(first.id);

  const second = await provider.acquire({});
  await provider.release(second.id);

  expect(firstCloseCalls).toBe(1);
  expect(secondCloseCalls).toBe(1);
});

test("failed acquire releases the single-session reservation and closes its CDP attachment", async () => {
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;

  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [],
        onClose: () => {
          firstCloseCalls += 1;
        },
      }),
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          secondCloseCalls += 1;
        },
      }),
    ],
  });

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser runtime is reachable but has no browser context/,
  );

  expect(firstCloseCalls).toBe(1);

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);

  expect(secondCloseCalls).toBe(1);
});

test("concurrent second acquire is rejected while the first acquire is still connecting", async () => {
  let finishConnect: ((browser: Browser) => void) | undefined;
  const connectGate = new Promise<Browser>((resolve) => {
    finishConnect = resolve;
  });

  const provider = new DockerCdpBrowserProvider({
    resolveEndpoint: async () =>
      "ws://172.18.0.2:9222/devtools/browser/test",
    connectOverCDP: async () => connectGate,
  });

  const firstAcquire = provider.acquire({});

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  finishConnect?.(
    browserStub({
      contexts: [contextStub({ pages: [pageStub()] })],
    }),
  );

  const first = await firstAcquire;
  await provider.release(first.id);
});

test("second acquire is rejected while an established session remains active", async () => {
  const provider = providerWithConnection();
  const first = await provider.acquire({});

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  await provider.release(first.id);
});

test("unexpected browser disconnect clears the active session so reconnect can acquire again", async () => {
  let disconnectFirstBrowser: (() => void) | undefined;

  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        captureDisconnected: (disconnect) => {
          disconnectFirstBrowser = disconnect;
        },
      }),
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
    ],
  });

  await provider.acquire({});
  expect(disconnectFirstBrowser).toBeTypeOf("function");

  disconnectFirstBrowser?.();

  const reconnected = await provider.acquire({});
  await provider.release(reconnected.id);
});

test("single-session lease spans provider instances without transferring release ownership", async () => {
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;

  const firstProvider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          firstCloseCalls += 1;
        },
      }),
    ],
  });
  const secondProvider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          secondCloseCalls += 1;
        },
      }),
    ],
  });

  const first = await firstProvider.acquire({});

  await expect(secondProvider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  await expect(secondProvider.release(first.id)).rejects.toThrow(
    /owned by another provider instance/,
  );
  expect(firstCloseCalls).toBe(0);

  await firstProvider.release(first.id);
  expect(firstCloseCalls).toBe(1);

  const second = await secondProvider.acquire({});
  await secondProvider.release(second.id);
  expect(secondCloseCalls).toBe(1);
});

test("unknown and stale release ids do not disturb the active lease", async () => {
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;

  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          firstCloseCalls += 1;
        },
      }),
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          secondCloseCalls += 1;
        },
      }),
    ],
  });

  const first = await provider.acquire({});

  await provider.release("unknown-session");
  expect(firstCloseCalls).toBe(0);
  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  await provider.release(first.id);
  expect(firstCloseCalls).toBe(1);

  const second = await provider.acquire({});

  await provider.release(first.id);
  expect(secondCloseCalls).toBe(0);
  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  await provider.release(second.id);
  expect(secondCloseCalls).toBe(1);
});

test("release clears the process-wide lease even when Playwright disconnect fails", async () => {
  const failingBrowser = browserStub({
    contexts: [contextStub({ pages: [pageStub()] })],
    closeError: new Error("disconnect failed"),
  });
  const recoveredBrowser = browserStub({
    contexts: [contextStub({ pages: [pageStub()] })],
  });

  const provider = providerWithConnection({
    browsers: [failingBrowser, recoveredBrowser],
  });

  const first = await provider.acquire({});
  await expect(provider.release(first.id)).rejects.toThrow("disconnect failed");

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);
});

test("release keeps the single-session lease until Playwright transport teardown settles", async () => {
  let finishClose: (() => void) | undefined;
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let closeCalls = 0;

  const firstBrowser = browserStub({
    contexts: [contextStub({ pages: [pageStub()] })],
  });
  (firstBrowser as unknown as { close: () => Promise<void> }).close =
    async () => {
      closeCalls += 1;
      await closeGate;
    };

  const provider = providerWithConnection({
    browsers: [
      firstBrowser,
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
    ],
  });

  const first = await provider.acquire({});
  const releasePromise = provider.release(first.id);

  await Promise.resolve();
  expect(closeCalls).toBe(1);
  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  finishClose?.();
  await releasePromise;

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);
});

test("disconnect during acquisition releases the reservation instead of returning a dead session", async () => {
  let browserAttempt = 0;
  let disconnectDuringAcquire: (() => void) | undefined;
  let firstCloseCalls = 0;

  const provider = new DockerCdpBrowserProvider({
    resolveEndpoint: async () =>
      "ws://172.18.0.2:9222/devtools/browser/test",
    connectOverCDP: async () => {
      browserAttempt += 1;

      if (browserAttempt === 1) {
        return browserStub({
          contexts: [
            contextStub({
              pages: [],
              newPage: pageStub(),
              onNewPage: () => {
                disconnectDuringAcquire?.();
              },
            }),
          ],
          captureDisconnected: (disconnect) => {
            disconnectDuringAcquire = disconnect;
          },
          onClose: () => {
            firstCloseCalls += 1;
          },
        });
      }

      return browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      });
    },
  });

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session disconnected during acquisition/,
  );
  expect(firstCloseCalls).toBe(1);

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);
});

test("concurrent release calls share one teardown and keep the lease until it finishes", async () => {
  let finishClose: (() => void) | undefined;
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let closeCalls = 0;

  const firstBrowser = browserStub({
    contexts: [contextStub({ pages: [pageStub()] })],
  });
  (firstBrowser as unknown as { close: () => Promise<void> }).close =
    async () => {
      closeCalls += 1;
      await closeGate;
    };

  const provider = providerWithConnection({
    browsers: [
      firstBrowser,
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
    ],
  });

  const session = await provider.acquire({});
  const firstRelease = provider.release(session.id);
  const secondRelease = provider.release(session.id);

  await Promise.resolve();
  expect(closeCalls).toBe(1);
  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  finishClose?.();
  await Promise.all([firstRelease, secondRelease]);

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);
});

test("failed acquire still releases the reservation when Playwright cleanup also fails", async () => {
  const provider = providerWithConnection({
    browsers: [
      browserStub({
        contexts: [],
        closeError: new Error("cleanup failed"),
      }),
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
    ],
  });

  await expect(provider.acquire({})).rejects.toThrow(
    /acquisition failed and the app-side CDP connection could not be released/,
  );

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);
});
