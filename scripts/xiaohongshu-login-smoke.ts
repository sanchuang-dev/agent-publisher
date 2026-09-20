import { DockerCdpBrowserProvider } from "../src/browser/providers/docker-cdp.js";
import {
  inspectXiaohongshuPublishEntry,
  openXiaohongshuPublishEntry,
} from "../src/platforms/xiaohongshu/login-entry.js";

function isSupportedExistingPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "creator.xiaohongshu.com" &&
      url.pathname.startsWith("/publish")
    );
  } catch {
    return false;
  }
}

if (process.env.XHS_REAL_ACCOUNT_SMOKE !== "1") {
  throw new Error(
    "Refusing real Xiaohongshu smoke without XHS_REAL_ACCOUNT_SMOKE=1.",
  );
}

const provider = new DockerCdpBrowserProvider();
const session = await provider.acquire({});

try {
  const currentUrl = session.page.url();
  const state =
    currentUrl === "about:blank"
      ? await openXiaohongshuPublishEntry(session.page, 8_000)
      : isSupportedExistingPage(currentUrl)
        ? await inspectXiaohongshuPublishEntry(session.page, 8_000)
        : (() => {
            throw new Error(
              "Refusing to navigate a non-disposable persistent browser page. " +
                "Use an about:blank page or an existing Xiaohongshu publish page.",
            );
          })();

  console.log(
    JSON.stringify({
      smoke: "xiaohongshu-login-entry",
      state: state.kind,
    }),
  );

  if (state.kind !== "authenticated") {
    console.error(
      "Authenticated publish entry not detected. Complete login/verification in the live browser and rerun the smoke.",
    );
    process.exitCode = 2;
  }
} finally {
  await provider.release(session.id);
}
