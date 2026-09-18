import type { Page } from "playwright";

export type BrowserAcquireInput = Record<string, never>;

export interface BrowserSession {
  readonly id: string;
  readonly page: Page;
  readonly profileRef: string;
  readonly liveView?: {
    readonly url: string;
  };
}

export type BrowserProviderHealth =
  | {
      readonly status: "reachable";
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

export interface BrowserProvider {
  acquire(input: BrowserAcquireInput): Promise<BrowserSession>;
  release(sessionId: string): Promise<void>;
  health(): Promise<BrowserProviderHealth>;
}
