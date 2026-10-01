import type { Page } from "playwright";

export interface BrowserAcquireInput {
  readonly jobId: string;
}

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

export interface BrowserAutomationAttachment {
  readonly sessionId: string;
  readonly cdpEndpoint: string;
  /**
   * Opaque, non-secret handle that binds automation to the Job-owned page.
   * It is transient browser infrastructure state and must not be persisted as
   * Publisher business state.
   */
  readonly pageRef: string;
}

export interface BrowserAutomationAttachmentProvider extends BrowserProvider {
  /**
   * Return an automation endpoint only for a session currently owned by this
   * provider instance. Callers must not construct CDP endpoints independently.
   */
  resolveAutomationAttachment(
    sessionId: string,
  ): Promise<BrowserAutomationAttachment>;
}

