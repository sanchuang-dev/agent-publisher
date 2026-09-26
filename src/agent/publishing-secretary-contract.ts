import type { ImageTextMaterialPack } from "../materials/contracts.js";
import type {
  BrowserAutomationAttachmentProvider,
  BrowserSession,
} from "../browser/provider.js";

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

export type PublishingSecretaryProgressStage =
  | "starting"
  | "observing"
  | "navigating"
  | "finding"
  | "acting"
  | "filling"
  | "uploading"
  | "waiting";

export interface PublishingSecretaryProgress {
  readonly stage: PublishingSecretaryProgressStage;
  readonly status: "running" | "succeeded" | "failed";
}

export interface PublishingSecretaryExecutionInput {
  readonly jobId: string;
  readonly browserProvider: BrowserAutomationAttachmentProvider;
  readonly browserSession: BrowserSession;
  readonly materialPack: ImageTextMaterialPack;
  readonly onProgress?: (
    progress: PublishingSecretaryProgress,
  ) => void | Promise<void>;
}

export interface PublishingSecretaryPort {
  execute(
    input: PublishingSecretaryExecutionInput,
  ): Promise<PublishingSecretaryExecutionResult>;
}
