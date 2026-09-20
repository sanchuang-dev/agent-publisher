import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ImageAssetReference } from "../src/materials/contracts.js";
import type { AssetPathResolver } from "../src/platforms/xiaohongshu/image-text-prepare.js";
import {
  AssetAlreadyExistsError,
  AssetNotFoundError,
} from "../src/contracts/asset.js";
import {
  AssetFileMissingError,
  AssetIntegrityError,
  AssetReferenceMismatchError,
  InvalidAssetWriteError,
} from "../src/assets/store.js";
import { LocalAssetStore } from "../src/assets/local-store.js";
import { AssetRepository } from "../src/storage/asset-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

describe("LocalAssetStore integration", () => {
  let root: string;
  let databasePath: string;
  let assetRoot: string;
  let db: ReturnType<typeof openDatabase> | null;
  let jobs: JobRepository;
  let repository: AssetRepository;
  let store: LocalAssetStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-publisher-local-assets-"));
    databasePath = join(root, "app.db");
    assetRoot = join(root, "assets");
    db = openDatabase({ databasePath });
    jobs = new JobRepository(db);
    repository = new AssetRepository(db);
    store = new LocalAssetStore(repository, { rootDirectory: assetRoot });

    jobs.create({
      id: "job-local-assets",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("writes bytes, returns asset:// identity, and satisfies the XHS AssetPathResolver seam", async () => {
    const bytes = Buffer.from("controlled-png-fixture");
    const record = await store.put({
      id: "asset-xhs-cover",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes,
      metadata: {
        width: 1080,
        height: 1440,
      },
    });

    expect(record).toMatchObject({
      id: "asset-xhs-cover",
      uri: "asset://asset-xhs-cover",
      mimeType: "image/png",
      kind: "image",
      status: "ready",
    });

    const reference: ImageAssetReference = {
      assetId: record.id,
      uri: record.uri,
      mimeType: record.mimeType,
      kind: "image",
      width: 1080,
      height: 1440,
    };

    const resolver: AssetPathResolver = (asset) =>
      store.resolveLocalPath(asset);
    const resolvedPath = await resolver(reference);

    expect(resolvedPath.startsWith(assetRoot)).toBe(true);
    expect(existsSync(resolvedPath)).toBe(true);
    await expect(store.read(record.id)).resolves.toEqual(bytes);
  });

  test("reopens from SQLite and resolves the same controlled file", async () => {
    const record = await store.put({
      id: "asset-reopen",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes: Buffer.from("reopen-fixture"),
    });

    const firstPath = await store.resolveLocalPath({
      assetId: record.id,
      uri: record.uri,
    });

    db!.close();
    db = openDatabase({ databasePath });
    repository = new AssetRepository(db);
    store = new LocalAssetStore(repository, { rootDirectory: assetRoot });

    const reopened = repository.getById(record.id);
    expect(reopened).not.toBeNull();

    const reopenedPath = await store.resolveLocalPath({
      assetId: reopened!.id,
      uri: reopened!.uri,
    });

    expect(reopenedPath).toBe(firstPath);
    await expect(store.read(record.id)).resolves.toEqual(
      Buffer.from("reopen-fixture"),
    );
  });

  test("does not overwrite an existing asset id", async () => {
    const original = Buffer.from("original-bytes");
    const record = await store.put({
      id: "asset-no-overwrite",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes: original,
    });

    await expect(
      store.put({
        id: "asset-no-overwrite",
        jobId: "job-local-assets",
        kind: "image",
        mimeType: "image/png",
        bytes: Buffer.from("replacement-bytes"),
      }),
    ).rejects.toBeInstanceOf(AssetAlreadyExistsError);

    await expect(store.read(record.id)).resolves.toEqual(original);
  });

  test("fails explicitly when the durable record exists but the local file is missing", async () => {
    const record = await store.put({
      id: "asset-missing-file",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes: Buffer.from("missing-file-fixture"),
    });

    const path = await store.resolveLocalPath({
      assetId: record.id,
      uri: record.uri,
    });
    unlinkSync(path);

    await expect(
      store.resolveLocalPath({
        assetId: record.id,
        uri: record.uri,
      }),
    ).rejects.toBeInstanceOf(AssetFileMissingError);
  });

  test("detects checksum corruption before exposing a path or bytes", async () => {
    const record = await store.put({
      id: "asset-corrupt",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes: Buffer.from("valid-bytes"),
    });

    const path = await store.resolveLocalPath({
      assetId: record.id,
      uri: record.uri,
    });
    writeFileSync(path, Buffer.from("tampered-bytes"));

    await expect(
      store.resolveLocalPath({
        assetId: record.id,
        uri: record.uri,
      }),
    ).rejects.toBeInstanceOf(AssetIntegrityError);
    await expect(store.read(record.id)).rejects.toBeInstanceOf(
      AssetIntegrityError,
    );
  });

  test("rejects a mismatched durable reference even when the asset id exists", async () => {
    const record = await store.put({
      id: "asset-reference",
      jobId: "job-local-assets",
      kind: "image",
      mimeType: "image/png",
      bytes: Buffer.from("reference-fixture"),
    });

    await expect(
      store.resolveLocalPath({
        assetId: record.id,
        uri: "asset://another-asset",
      }),
    ).rejects.toBeInstanceOf(AssetReferenceMismatchError);
  });

  test("rejects traversal-shaped ids before any controlled asset is persisted", async () => {
    await expect(
      store.put({
        id: "../escape",
        jobId: "job-local-assets",
        kind: "image",
        mimeType: "image/png",
        bytes: Buffer.from("escape-attempt"),
      }),
    ).rejects.toBeInstanceOf(InvalidAssetWriteError);

    expect(repository.getById("../escape")).toBeNull();
    expect(existsSync(join(root, "escape.png"))).toBe(false);
    expect(existsSync(assetRoot) ? readdirSync(assetRoot) : []).toEqual([]);
  });

  test("cleans up bytes when repository persistence rejects the owning job", async () => {
    await expect(
      store.put({
        id: "asset-missing-owner",
        jobId: "missing-job",
        kind: "image",
        mimeType: "image/png",
        bytes: Buffer.from("orphan-prevention"),
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(repository.getById("asset-missing-owner")).toBeNull();
    expect(existsSync(assetRoot) ? readdirSync(assetRoot) : []).toEqual([]);
  });

  test("missing asset ids fail explicitly", async () => {
    await expect(store.read("asset-does-not-exist")).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
  });
});
