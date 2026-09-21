export const assetKinds = ["image", "video", "design"] as const;

export type AssetKind = (typeof assetKinds)[number];

export const assetStatuses = ["ready"] as const;

export type AssetStatus = (typeof assetStatuses)[number];

export type AssetMetadataValue = string | number | boolean | null;
export type AssetMetadata = Readonly<Record<string, AssetMetadataValue>>;

export interface AssetRecord {
  readonly id: string;
  readonly jobId: string | null;
  readonly kind: AssetKind;
  readonly uri: string;
  readonly mimeType: string;
  readonly checksum: string;
  readonly metadata: AssetMetadata | null;
  readonly status: AssetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAssetRecordInput {
  readonly id: string;
  readonly jobId?: string | null;
  readonly kind: AssetKind;
  readonly uri: string;
  readonly mimeType: string;
  readonly checksum: string;
  readonly metadata?: AssetMetadata | null;
}

export class InvalidAssetRecordError extends Error {
  constructor(
    readonly field:
      | "id"
      | "jobId"
      | "kind"
      | "uri"
      | "mimeType"
      | "checksum"
      | "metadata"
      | "status",
    message: string,
  ) {
    super(`Invalid asset ${field}: ${message}`);
    this.name = "InvalidAssetRecordError";
  }
}

export class SensitiveAssetMetadataError extends Error {
  constructor(readonly fieldPath: string) {
    super(`Asset metadata contains forbidden sensitive material at ${fieldPath}`);
    this.name = "SensitiveAssetMetadataError";
  }
}

export class AssetAlreadyExistsError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset already exists: ${assetId}`);
    this.name = "AssetAlreadyExistsError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset not found: ${assetId}`);
    this.name = "AssetNotFoundError";
  }
}

/**
 * Driver-agnostic persistence boundary for Publisher-owned asset identities.
 *
 * The repository stores metadata and stable asset:// references. Asset bytes
 * belong to AssetStore implementations and must not be embedded in SQLite.
 */
export interface AssetRepository {
  create(input: CreateAssetRecordInput): AssetRecord;
  getById(id: string): AssetRecord | null;
  getByJob(jobId: string): readonly AssetRecord[];
}
