import type { ImageTextMaterialPack } from "../materials/contracts.js";
import type {
  BrowserAutomationAttachmentProvider,
  BrowserSession,
} from "../browser/provider.js";
import type { AgentToolExecutionEvent } from "./definition.js";

export const publishingSecretaryProgressKeys = [
  "starting",
  "observing",
  "navigating",
  "finding",
  "acting",
  "filling",
  "uploading",
  "waiting",
] as const;

export type PublishingSecretaryProgressKey =
  (typeof publishingSecretaryProgressKeys)[number];

export interface PublishingSecretaryProgressEvent {
  readonly key: PublishingSecretaryProgressKey;
  readonly status: "running" | "succeeded" | "failed";
}

export type PublishingSecretaryResultKind =
  | "progress"
  | "needs_identity"
  | "prepared_candidate"
  | "needs_clarification"
  | "failed";

export const publishingSecretaryIdentitySurfaces = [
  "qr_ready",
  "verification_required",
] as const;

export type PublishingSecretaryIdentitySurface =
  (typeof publishingSecretaryIdentitySurfaces)[number];

export interface PublishingSecretaryExecutionResult {
  readonly kind: PublishingSecretaryResultKind;
  readonly summary: string;
  readonly semanticMilestone: string | null;
  readonly identitySurface?: PublishingSecretaryIdentitySurface | null;
  readonly browserToolCalls: number;
}

export interface PublishingSecretaryExecutionInput {
  readonly jobId: string;
  readonly browserProvider: BrowserAutomationAttachmentProvider;
  readonly browserSession: BrowserSession;
  readonly materialPack: ImageTextMaterialPack;
  /** Observational semantic progress; failures must not affect execution. */
  readonly onProgress?: (event: PublishingSecretaryProgressEvent) => void;
}

export interface PublishingSecretaryPort {
  execute(
    input: PublishingSecretaryExecutionInput,
  ): Promise<PublishingSecretaryExecutionResult>;
}
