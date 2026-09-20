import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  AssetAlreadyExistsError,
  AssetNotFoundError,
  type AssetRecord,
  type AssetRepository,
} from "../contracts/asset.js";
import {
  AssetFileMissingError,
  AssetFileTypeError,
  AssetIntegrityError,
  AssetPathViolationError,
  AssetReferenceMismatchError,
  InvalidAssetWriteError,
  type AssetReferencePointer,
  type AssetStore,
  type AssetWriteInput,
} from "./store.js";

export const DEFAULT_ASSET_ROOT = resolve("data", "assets");
export const ASSET_ROOT_ENV = "ASSET_STORE_PATH";

export interface LocalAssetStoreOptions {
  readonly rootDirectory?: string;
}

const safeAssetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const mimeExtensions: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/json": ".json",
};

function toAssetUri(assetId: string): string {
  return `asset://${assetId}`;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionForMimeType(mimeType: string): string {
  return mimeExtensions[mimeType.toLowerCase()] ?? ".bin";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class LocalAssetStore implements AssetStore {
  readonly #repository: AssetRepository;
  readonly #rootDirectory: string;

  constructor(
    repository: AssetRepository,
    options: LocalAssetStoreOptions = {},
  ) {
    this.#repository = repository;
    this.#rootDirectory = resolve(
      options.rootDirectory ?? process.env[ASSET_ROOT_ENV] ?? DEFAULT_ASSET_ROOT,
    );
  }

  async put(input: AssetWriteInput): Promise<AssetRecord> {
    this.#assertWriteInput(input);

    if (this.#repository.getById(input.id)) {
      throw new AssetAlreadyExistsError(input.id);
    }

    const bytes = Buffer.from(input.bytes);
    const digest = checksum(bytes);
    const uri = toAssetUri(input.id);
    const filePath = this.#pathFor(input.id, input.mimeType);

    await mkdir(this.#rootDirectory, { recursive: true });

    try {
      await writeFile(filePath, bytes, { flag: "wx" });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new AssetAlreadyExistsError(input.id);
      }
      throw error;
    }

    try {
      return this.#repository.create({
        id: input.id,
        jobId: input.jobId,
        kind: input.kind,
        uri,
        mimeType: input.mimeType,
        checksum: digest,
        metadata: input.metadata,
      });
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
  }

  async read(assetId: string): Promise<Buffer> {
    const record = this.#requireRecord(assetId);
    const { bytes } = await this.#readVerified(record);
    return bytes;
  }

  async resolveLocalPath(asset: AssetReferencePointer): Promise<string> {
    const record = this.#requireRecord(asset.assetId);

    if (asset.uri !== record.uri) {
      throw new AssetReferenceMismatchError(
        asset.assetId,
        record.uri,
        asset.uri,
      );
    }

    const { filePath } = await this.#readVerified(record);
    return filePath;
  }

  #assertWriteInput(input: AssetWriteInput): void {
    if (
      typeof input.id !== "string" ||
      !safeAssetIdPattern.test(input.id)
    ) {
      throw new InvalidAssetWriteError(
        "id",
        "must be a bounded path-safe Publisher asset identifier",
      );
    }

    if (
      typeof input.mimeType !== "string" ||
      input.mimeType.length === 0 ||
      input.mimeType !== input.mimeType.trim()
    ) {
      throw new InvalidAssetWriteError(
        "mimeType",
        "must be a non-empty media type",
      );
    }

    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new InvalidAssetWriteError(
        "bytes",
        "must contain at least one byte",
      );
    }
  }

  #requireRecord(assetId: string): AssetRecord {
    const record = this.#repository.getById(assetId);
    if (!record) {
      throw new AssetNotFoundError(assetId);
    }
    return record;
  }

  #pathFor(assetId: string, mimeType: string): string {
    const opaqueName =
      createHash("sha256").update(assetId).digest("hex") +
      extensionForMimeType(mimeType);
    const candidate = resolve(this.#rootDirectory, opaqueName);
    const relativePath = relative(this.#rootDirectory, candidate);

    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      throw new AssetPathViolationError(assetId);
    }

    return candidate;
  }

  async #readVerified(
    record: AssetRecord,
  ): Promise<{ readonly filePath: string; readonly bytes: Buffer }> {
    const filePath = this.#pathFor(record.id, record.mimeType);

    let fileStat;
    try {
      fileStat = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new AssetFileMissingError(record.id);
      }
      throw error;
    }

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new AssetFileTypeError(record.id);
    }

    const bytes = await readFile(filePath);
    const actualChecksum = checksum(bytes);

    if (actualChecksum !== record.checksum) {
      throw new AssetIntegrityError(
        record.id,
        record.checksum,
        actualChecksum,
      );
    }

    return { filePath, bytes };
  }
}
