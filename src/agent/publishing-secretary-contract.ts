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

export interface PublishingSecretaryExecutionResult {
  readonly kind: PublishingSecretaryResultKind;
  readonly summary: string;
  readonly semanticMilestone: string | null;
  readonly browserToolCalls: number;
}

export interface PublishingSecretaryExecutionInput {
  readonly jobId: string;
  readonly browserProvider: BrowserAutomationAttachmentProvider;
  readonly browserSession: BrowserSession;
  readonly materialPack: ImageTextMaterialPack;
}

export interface PublishingSecretaryPort {
  execute(
    input: PublishingSecretaryExecutionInput,
  ): Promise<PublishingSecretaryExecutionResult>;
}
