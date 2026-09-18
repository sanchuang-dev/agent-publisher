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
  onClose?: () => void;
  captureDisconnected?: (disconnect: () => void) => void;
} = {}): Browser {
  const browser = {
    contexts: () => options.contexts ?? [],
    once: (event: string, listener: () => void) => {
      if (event === "disconnected") {
        options.captureDisconnected?.(() => listener());
      }
      return browser;
    },
    close: async () => {
      options.onClose?.();
      throw new Error("provider must not close the external CDP browser");
    },
  };

  return browser as unknown as Browser;
}

function managedTransportStub(options: { disconnectError?: Error } = {}) {
  let disconnectCalls = 0;
  let closeCalls = 0;

  const transport = {
    send: () => {},
    close: () => {
      closeCalls += 1;
    },
    disconnect: async () => {
      disconnectCalls += 1;
      if (options.disconnectError) {
        throw options.disconnectError;
      }
    },
  };

  return {
    transport,
    get disconnectCalls() {
      return disconnectCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

test("uses the Compose-internal endpoint, noDefaults, and a disconnect-only transport by default", async () => {
  let seenEndpoint = "";
  let seenTimeout = -1;
  let seenConnectTimeout = -1;
  let seenNoDefaults = false;
  let browserCloseCalls = 0;
  const transport = managedTransportStub();

  const provider = new DockerCdpBrowserProvider({
    createTransport: async (endpoint, timeoutMs) => {
      seenEndpoint = endpoint;
      seenTimeout = timeoutMs;
      return transport.transport;
    },
    connectOverCDP: async (_transport, options) => {
      seenConnectTimeout = options.timeout;
      seenNoDefaults = options.noDefaults;
      return browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          browserCloseCalls += 1;
        },
      });
    },
  });

  await expect(provider.health()).resolves.toEqual({ status: "reachable" });
  expect(seenEndpoint).toBe(DEFAULT_DOCKER_CDP_ENDPOINT);
  expect(seenTimeout).toBe(10_000);
  expect(seenConnectTimeout).toBe(10_000);
  expect(seenNoDefaults).toBe(true);
  expect(transport.disconnectCalls).toBe(1);
  expect(browserCloseCalls).toBe(0);
});

test("allows the CDP endpoint to be injected through environment or explicit config", async () => {
  const seenEndpoints: string[] = [];

  const createProvider = (
    options: ConstructorParameters<typeof DockerCdpBrowserProvider>[0],
  ) =>
    new DockerCdpBrowserProvider({
      ...options,
      createTransport: async (endpoint) => {
        seenEndpoints.push(endpoint);
        return managedTransportStub().transport;
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

test("health reports unavailable without throwing when the runtime cannot be reached", async () => {
  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      throw new Error("connection refused");
    },
  });

  await expect(provider.health()).resolves.toEqual({
    status: "unavailable",
    message: "connection refused",
  });
});

test("connector failure disconnects the app-side transport without touching external Chromium", async () => {
  const transport = managedTransportStub();
  let browserCloseCalls = 0;

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => transport.transport,
    connectOverCDP: async () => {
      const browser = browserStub({
        onClose: () => {
          browserCloseCalls += 1;
        },
      });
      void browser;
      throw new Error("handshake failed");
    },
  });

  await expect(provider.health()).resolves.toEqual({
    status: "unavailable",
    message: "handshake failed",
  });
  expect(transport.disconnectCalls).toBe(1);
  expect(browserCloseCalls).toBe(0);
});

test("acquire reuses an existing usable page and release only disconnects the app-side transport", async () => {
  let pageCloseCalls = 0;
  let newPageCalls = 0;
  let browserCloseCalls = 0;
  const transport = managedTransportStub();

  const existingPage = pageStub({
    onClose: () => {
      pageCloseCalls += 1;
    },
  });
  const context = contextStub({
    pages: [existingPage],
    onNewPage: () => {
      newPageCalls += 1;
    },
  });

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => transport.transport,
    connectOverCDP: async () =>
      browserStub({
        contexts: [context],
        onClose: () => {
          browserCloseCalls += 1;
        },
      }),
  });

  const session = await provider.acquire({});

  expect(session.page).toBe(existingPage);
  expect(session.profileRef).toBe("browser-profile");
  expect(newPageCalls).toBe(0);

  await provider.release(session.id);

  expect(transport.disconnectCalls).toBe(1);
  expect(browserCloseCalls).toBe(0);
  expect(pageCloseCalls).toBe(0);
});

test("acquire creates a page when the existing browser context has no usable page", async () => {
  let newPageCalls = 0;
  const transport = managedTransportStub();
  const createdPage = pageStub();
  const closedPage = pageStub({ closed: true });
  const context = contextStub({
    pages: [closedPage],
    newPage: createdPage,
    onNewPage: () => {
      newPageCalls += 1;
    },
  });

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => transport.transport,
    connectOverCDP: async () =>
      browserStub({
        contexts: [context],
      }),
  });

  const session = await provider.acquire({});

  expect(session.page).toBe(createdPage);
  expect(newPageCalls).toBe(1);

  await provider.release(session.id);
  expect(transport.disconnectCalls).toBe(1);
});

test("release permits a later acquire to establish a fresh app-side connection", async () => {
  let connectCalls = 0;
  const transports = [managedTransportStub(), managedTransportStub()];

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      const next = transports[connectCalls];
      if (!next) {
        throw new Error("unexpected extra connection");
      }
      return next.transport;
    },
    connectOverCDP: async () => {
      connectCalls += 1;
      return browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      });
    },
  });

  const first = await provider.acquire({});
  await provider.release(first.id);

  const second = await provider.acquire({});
  await provider.release(second.id);

  expect(connectCalls).toBe(2);
  expect(transports[0]?.disconnectCalls).toBe(1);
  expect(transports[1]?.disconnectCalls).toBe(1);
});

test("failed acquire releases the single-session reservation and disconnects only its app-side transport", async () => {
  const transports = [managedTransportStub(), managedTransportStub()];
  let connectAttempt = 0;
  let browserCloseCalls = 0;

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      const transport = transports[connectAttempt];
      if (!transport) {
        throw new Error("unexpected extra transport request");
      }
      return transport.transport;
    },
    connectOverCDP: async () => {
      connectAttempt += 1;
      return browserStub({
        contexts:
          connectAttempt === 1
            ? []
            : [contextStub({ pages: [pageStub()] })],
        onClose: () => {
          browserCloseCalls += 1;
        },
      });
    },
  });

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser runtime is reachable but has no browser context/,
  );

  expect(transports[0]?.disconnectCalls).toBe(1);
  expect(browserCloseCalls).toBe(0);

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);

  expect(transports[1]?.disconnectCalls).toBe(1);
});

test("concurrent second acquire is rejected while the first acquire is still connecting", async () => {
  const transport = managedTransportStub();
  let finishConnect: ((browser: Browser) => void) | undefined;
  const connectGate = new Promise<Browser>((resolve) => {
    finishConnect = resolve;
  });

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => transport.transport,
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
  expect(transport.disconnectCalls).toBe(1);
});

test("second acquire is rejected while an established session remains active", async () => {
  const transport = managedTransportStub();

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => transport.transport,
    connectOverCDP: async () =>
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
  });

  const first = await provider.acquire({});

  await expect(provider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );

  await provider.release(first.id);
  expect(transport.disconnectCalls).toBe(1);
});

test("unexpected browser disconnect clears the active session so reconnect can acquire again", async () => {
  const transports = [managedTransportStub(), managedTransportStub()];
  let transportIndex = 0;
  let disconnectFirstBrowser: (() => void) | undefined;

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      const transport = transports[transportIndex++];
      if (!transport) {
        throw new Error("unexpected extra transport request");
      }
      return transport.transport;
    },
    connectOverCDP: async () =>
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
        captureDisconnected: (disconnect) => {
          disconnectFirstBrowser ??= disconnect;
        },
      }),
  });

  await provider.acquire({});
  expect(disconnectFirstBrowser).toBeTypeOf("function");

  disconnectFirstBrowser?.();
  expect(transports[0]?.disconnectCalls).toBe(1);

  const reconnected = await provider.acquire({});
  await provider.release(reconnected.id);

  expect(transports[1]?.disconnectCalls).toBe(1);
});


test("single-session lease spans multiple provider instances in the same process", async () => {
  const firstTransport = managedTransportStub();
  const secondTransport = managedTransportStub();
  let secondTransportRequests = 0;

  const firstProvider = new DockerCdpBrowserProvider({
    createTransport: async () => firstTransport.transport,
    connectOverCDP: async () =>
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
  });

  const secondProvider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      secondTransportRequests += 1;
      return secondTransport.transport;
    },
    connectOverCDP: async () =>
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
  });

  const first = await firstProvider.acquire({});

  await expect(secondProvider.acquire({})).rejects.toThrow(
    /Browser session already active/,
  );
  expect(secondTransportRequests).toBe(0);

  await secondProvider.release(first.id);
  expect(firstTransport.disconnectCalls).toBe(1);

  const second = await secondProvider.acquire({});
  await secondProvider.release(second.id);

  expect(secondTransportRequests).toBe(1);
  expect(firstTransport.disconnectCalls).toBe(1);
  expect(secondTransport.disconnectCalls).toBe(1);
});


test("release clears the process-wide lease even when transport disconnect fails", async () => {
  const failingTransport = managedTransportStub({
    disconnectError: new Error("disconnect failed"),
  });
  const recoveredTransport = managedTransportStub();
  let transportAttempt = 0;

  const provider = new DockerCdpBrowserProvider({
    createTransport: async () => {
      const transport =
        transportAttempt++ === 0 ? failingTransport : recoveredTransport;
      return transport.transport;
    },
    connectOverCDP: async () =>
      browserStub({
        contexts: [contextStub({ pages: [pageStub()] })],
      }),
  });

  const first = await provider.acquire({});

  await expect(provider.release(first.id)).rejects.toThrow("disconnect failed");
  expect(failingTransport.disconnectCalls).toBe(1);

  const recovered = await provider.acquire({});
  await provider.release(recovered.id);

  expect(recoveredTransport.disconnectCalls).toBe(1);
});
