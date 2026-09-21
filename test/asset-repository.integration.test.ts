import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  AssetAlreadyExistsError,
  InvalidAssetRecordError,
  SensitiveAssetMetadataError,
  type AssetRepository as AssetRepositoryContract,
} from "../src/contracts/asset.js";
import { JobNotFoundError } from "../src/contracts/job.js";
import { AssetRepository } from "../src/storage/asset-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

describe("AssetRepository integration", () => {
  let root: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase> | null;
  let jobs: JobRepository;
  let assets: AssetRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-publisher-assets-db-"));
    databasePath = join(root, "app.db");
    db = openDatabase({ databasePath });
    jobs = new JobRepository(db);
    assets = new AssetRepository(db);

    const contract: AssetRepositoryContract = assets;
    expect(contract).toBe(assets);

    jobs.create({
      id: "job-assets",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("persists a stable asset identity and survives database reopen", () => {
    const created = assets.create({
      id: "asset-cover-001",
      jobId: "job-assets",
      kind: "image",
      uri: "asset://asset-cover-001",
      mimeType: "image/png",
      checksum: "A".repeat(64),
      metadata: {
        width: 1080,
        height: 1440,
        purpose: "cover",
        generated: true,
      },
    });

    expect(created).toMatchObject({
      id: "asset-cover-001",
      jobId: "job-assets",
      kind: "image",
      uri: "asset://asset-cover-001",
      mimeType: "image/png",
      checksum: "a".repeat(64),
      status: "ready",
      metadata: {
        width: 1080,
        height: 1440,
        purpose: "cover",
        generated: true,
      },
    });

    expect(assets.getByJob("job-assets")).toEqual([created]);

    db!.close();
    db = openDatabase({ databasePath });
    assets = new AssetRepository(db);

    expect(assets.getById("asset-cover-001")).toEqual(created);
    expect(assets.getByJob("job-assets")).toEqual([created]);
  });

  test("rejects duplicate ids instead of silently replacing durable identity", () => {
    const input = {
      id: "asset-duplicate",
      jobId: "job-assets",
      kind: "image" as const,
      uri: "asset://asset-duplicate",
      mimeType: "image/png",
      checksum: "1".repeat(64),
    };

    const first = assets.create(input);

    expect(() =>
      assets.create({
        ...input,
        checksum: "2".repeat(64),
      }),
    ).toThrow(AssetAlreadyExistsError);

    expect(assets.getById(input.id)).toEqual(first);
  });

  test("requires an existing owning job when jobId is supplied", () => {
    expect(() =>
      assets.create({
        id: "asset-missing-job",
        jobId: "missing-job",
        kind: "image",
        uri: "asset://asset-missing-job",
        mimeType: "image/png",
        checksum: "3".repeat(64),
      }),
    ).toThrow(JobNotFoundError);

    expect(assets.getById("asset-missing-job")).toBeNull();
  });

  test("requires the canonical asset URI and valid checksum", () => {
    expect(() =>
      assets.create({
        id: "asset-uri",
        jobId: "job-assets",
        kind: "image",
        uri: "https://example.invalid/asset.png",
        mimeType: "image/png",
        checksum: "4".repeat(64),
      }),
    ).toThrow(InvalidAssetRecordError);

    expect(() =>
      assets.create({
        id: "asset-checksum",
        jobId: "job-assets",
        kind: "image",
        uri: "asset://asset-checksum",
        mimeType: "image/png",
        checksum: "not-a-sha256",
      }),
    ).toThrow(InvalidAssetRecordError);
  });

  test("rejects secret-like metadata instead of persisting provider credentials", () => {
    expect(() =>
      assets.create({
        id: "asset-secret-key",
        jobId: "job-assets",
        kind: "image",
        uri: "asset://asset-secret-key",
        mimeType: "image/png",
        checksum: "5".repeat(64),
        metadata: {
          accessToken: "opaque-value",
        },
      }),
    ).toThrow(SensitiveAssetMetadataError);

    expect(() =>
      assets.create({
        id: "asset-secret-value",
        jobId: "job-assets",
        kind: "image",
        uri: "asset://asset-secret-value",
        mimeType: "image/png",
        checksum: "6".repeat(64),
        metadata: {
          source: "Authorization: Bearer definitely-sensitive",
        },
      }),
    ).toThrow(SensitiveAssetMetadataError);

    expect(assets.getByJob("job-assets")).toEqual([]);
  });
});
