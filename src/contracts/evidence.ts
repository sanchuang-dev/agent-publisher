import type { PublishPlatform } from "./publish-job.js";

export const publicationEvidenceKinds = [
  "result_url",
  "content_id",
  "confirmation_ref",
  "artifact_uri",
] as const;

export type PublicationEvidenceKind = (typeof publicationEvidenceKinds)[number];

export interface PublicationEvidenceMetadata {
  readonly platform?: PublishPlatform;
  readonly verifiedBy?: string;
  readonly mimeType?: string;
  readonly purpose?: string;
  readonly capturedAt?: string;
  readonly sha256?: string;
}

export interface PublicationEvidence {
  readonly id: string;
  readonly jobId: string;
  readonly kind: PublicationEvidenceKind;
  readonly uri: string | null;
  readonly value: string | null;
  readonly metadata: PublicationEvidenceMetadata | null;
  readonly createdAt: string;
}

export interface AppendPublicationEvidenceInput {
  readonly id: string;
  readonly jobId: string;
  readonly kind: PublicationEvidenceKind;
  readonly uri?: string | null;
  readonly value?: string | null;
  readonly metadata?: PublicationEvidenceMetadata | null;
}

export class InvalidPublicationEvidenceError extends Error {
  constructor(
    readonly field: "id" | "jobId" | "kind" | "uri" | "value" | "metadata",
    message: string,
  ) {
    super(`Invalid publication evidence ${field}: ${message}`);
    this.name = "InvalidPublicationEvidenceError";
  }
}

export class SensitivePublicationEvidenceError extends Error {
  constructor(readonly fieldPath: string) {
    super(`Publication evidence contains forbidden sensitive material at ${fieldPath}`);
    this.name = "SensitivePublicationEvidenceError";
  }
}

export class PublicationEvidenceAlreadyExistsError extends Error {
  constructor(readonly evidenceId: string) {
    super(`PublicationEvidence already exists: ${evidenceId}`);
    this.name = "PublicationEvidenceAlreadyExistsError";
  }
}

/**
 * Driver-agnostic append-only persistence boundary for publication-result
 * evidence. Metadata is intentionally narrow and must be extended explicitly;
 * arbitrary browser/session/transcript payloads are not part of this contract.
 * The contract intentionally has no update/delete API so evidence is immutable
 * after creation.
 */
export interface EvidenceRepository {
  append(input: AppendPublicationEvidenceInput): PublicationEvidence;
  getByJob(jobId: string): readonly PublicationEvidence[];
}
