import type {
  AssetKind,
  AssetMetadata,
  AssetRecord,
} from "../contracts/asset.js";

export interface AssetWriteInput {
  readonly id: string;
  readonly jobId?: string | null;
  readonly kind: AssetKind;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly metadata?: AssetMetadata | null;
}

export interface AssetReferencePointer {
  readonly assetId: string;
  readonly uri: string;
}

export class InvalidAssetWriteError extends Error {
  constructor(readonly field: "id" | "bytes" | "mimeType", message: string) {
    super(`Invalid asset write ${field}: ${message}`);
    this.name = "InvalidAssetWriteError";
  }
}

export class AssetReferenceMismatchError extends Error {
  constructor(
    readonly assetId: string,
    readonly expectedUri: string,
    readonly receivedUri: string,
  ) {
    super(
      `Asset reference mismatch for ${assetId}: expected ${expectedUri}, received ${receivedUri}`,
    );
    this.name = "AssetReferenceMismatchError";
  }
}

export class AssetFileMissingError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset file is missing: ${assetId}`);
    this.name = "AssetFileMissingError";
  }
}

export class AssetIntegrityError extends Error {
  constructor(
    readonly assetId: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `Asset checksum mismatch for ${assetId}: expected ${expectedChecksum}, received ${actualChecksum}`,
    );
    this.name = "AssetIntegrityError";
  }
}

export class AssetPathViolationError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset path escaped the configured store root: ${assetId}`);
    this.name = "AssetPathViolationError";
  }
}

export class AssetFileTypeError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset path is not a regular file: ${assetId}`);
    this.name = "AssetFileTypeError";
  }
}

export interface AssetStore {
  put(input: AssetWriteInput): Promise<AssetRecord>;
  read(assetId: string): Promise<Buffer>;
  resolveLocalPath(asset: AssetReferencePointer): Promise<string>;
}
