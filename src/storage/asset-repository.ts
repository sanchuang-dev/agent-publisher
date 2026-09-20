import {
  AssetAlreadyExistsError,
  InvalidAssetRecordError,
  SensitiveAssetMetadataError,
  assetKinds,
  assetStatuses,
  type AssetKind,
  type AssetMetadata,
  type AssetMetadataValue,
  type AssetRecord,
  type AssetRepository as AssetRepositoryContract,
  type AssetStatus,
  type CreateAssetRecordInput,
} from "../contracts/asset.js";
import { JobNotFoundError } from "../contracts/job.js";

interface RunResult {
  readonly changes: number;
}

interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseHandle {
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}

interface JobLookupRow {
  id: string;
}

interface AssetRow {
  id: string;
  job_id: string | null;
  kind: string;
  uri: string;
  mime_type: string | null;
  checksum: string | null;
  metadata_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface NormalizedAssetInput {
  readonly id: string;
  readonly jobId: string | null;
  readonly kind: AssetKind;
  readonly uri: string;
  readonly mimeType: string;
  readonly checksum: string;
  readonly metadata: AssetMetadata | null;
}

const MAX_ID_LENGTH = 200;
const MAX_JOB_ID_LENGTH = 200;
const MAX_URI_LENGTH = 512;
const MAX_MIME_TYPE_LENGTH = 128;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_METADATA_BYTES = 4 * 1024;

const assetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const metadataKeyPattern = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const mimeTypePattern =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const sha256Pattern = /^[A-Fa-f0-9]{64}$/;

const sensitiveExactKeyNames = new Set([
  "sid",
  "sessionid",
  "jsessionid",
  "phpsessid",
  "csrftoken",
  "xsrftoken",
]);

const sensitiveKeyMarkers = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "credential",
  "apikey",
  "authorization",
  "bearer",
  "jwt",
  "privatekey",
  "storagestate",
  "localstorage",
  "sessionstorage",
  "qrcode",
  "qrartifact",
] as const;

const sensitiveStringPatterns = [
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\bbearer\s+\S+/i,
  /\b(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|password|passwd|cookie|set-cookie|session[-_]?id|jsessionid|phpsessid|sid|csrf[-_]?token|xsrf[-_]?token)\s*=/i,
  /\b(?:storage[-_]?state|local[-_]?storage|session[-_]?storage)\s*[:=]/i,
  /\b(?:cookie|set-cookie)\s*:/i,
];

const jwtLikePattern =
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:$|[^A-Za-z0-9_-])/;

const selectColumns = `
  id, job_id, kind, uri, mime_type, checksum,
  metadata_json, status, created_at, updated_at
`;

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKeyName(key: string): boolean {
  const normalized = normalizeKeyName(key);
  return (
    sensitiveExactKeyNames.has(normalized) ||
    sensitiveKeyMarkers.some((marker) => normalized.includes(marker))
  );
}

function decodeRepeated(value: string): string {
  let decoded = value;

  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }

  return decoded;
}

function assertNoSensitiveString(value: string, fieldPath: string): void {
  const decoded = decodeRepeated(value);
  if (
    sensitiveStringPatterns.some((pattern) => pattern.test(decoded)) ||
    jwtLikePattern.test(decoded)
  ) {
    throw new SensitiveAssetMetadataError(fieldPath);
  }
}

function normalizeId(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidAssetRecordError("id", "must be a non-empty string");
  }

  if (value.length > MAX_ID_LENGTH || !assetIdPattern.test(value)) {
    throw new InvalidAssetRecordError(
      "id",
      `must be at most ${MAX_ID_LENGTH} characters and contain only safe identifier characters`,
    );
  }

  return value;
}

function normalizeJobId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_JOB_ID_LENGTH ||
    value !== value.trim()
  ) {
    throw new InvalidAssetRecordError(
      "jobId",
      `must be a non-empty bounded Job identifier of at most ${MAX_JOB_ID_LENGTH} characters`,
    );
  }

  return value;
}

function normalizeKind(value: AssetKind): AssetKind {
  if (!assetKinds.includes(value)) {
    throw new InvalidAssetRecordError("kind", "is unsupported");
  }
  return value;
}

function normalizeUri(assetId: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidAssetRecordError("uri", "must be a non-empty URI");
  }

  if (value.length > MAX_URI_LENGTH) {
    throw new InvalidAssetRecordError(
      "uri",
      `must be at most ${MAX_URI_LENGTH} characters`,
    );
  }

  const expected = `asset://${assetId}`;
  if (value !== expected) {
    throw new InvalidAssetRecordError(
      "uri",
      `must be the canonical Publisher-owned reference ${expected}`,
    );
  }

  return value;
}

function normalizeMimeType(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MIME_TYPE_LENGTH ||
    !mimeTypePattern.test(value)
  ) {
    throw new InvalidAssetRecordError(
      "mimeType",
      "must be a valid bounded media type",
    );
  }

  return value.toLowerCase();
}

function normalizeChecksum(value: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new InvalidAssetRecordError(
      "checksum",
      "must be a 64-character hexadecimal SHA-256 digest",
    );
  }

  return value.toLowerCase();
}

function normalizeMetadataValue(
  key: string,
  rawValue: AssetMetadataValue,
): AssetMetadataValue {
  if (rawValue === null || typeof rawValue === "boolean") {
    return rawValue;
  }

  if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue)) {
      throw new InvalidAssetRecordError(
        "metadata",
        `${key} must be a finite number`,
      );
    }
    return rawValue;
  }

  if (typeof rawValue === "string") {
    if (rawValue.length > MAX_METADATA_STRING_LENGTH) {
      throw new InvalidAssetRecordError(
        "metadata",
        `${key} must be at most ${MAX_METADATA_STRING_LENGTH} characters`,
      );
    }
    assertNoSensitiveString(rawValue, `metadata.${key}`);
    return rawValue;
  }

  throw new InvalidAssetRecordError(
    "metadata",
    `${key} must be a string, number, boolean, or null`,
  );
}

function normalizeMetadata(
  metadata: AssetMetadata | null | undefined,
): AssetMetadata | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidAssetRecordError(
      "metadata",
      "must be a flat metadata object",
    );
  }

  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new InvalidAssetRecordError(
      "metadata",
      `must contain at most ${MAX_METADATA_KEYS} keys`,
    );
  }

  const normalized: Record<string, AssetMetadataValue> = {};
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      !metadataKeyPattern.test(key)
    ) {
      throw new InvalidAssetRecordError(
        "metadata",
        `invalid metadata key: ${key}`,
      );
    }

    if (isSensitiveKeyName(key)) {
      throw new SensitiveAssetMetadataError(`metadata.${key}`);
    }

    normalized[key] = normalizeMetadataValue(key, value);
  }

  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new InvalidAssetRecordError(
      "metadata",
      `must serialize to at most ${MAX_METADATA_BYTES} bytes`,
    );
  }

  return normalized;
}

function normalizeInput(input: CreateAssetRecordInput): NormalizedAssetInput {
  const id = normalizeId(input.id);

  return {
    id,
    jobId: normalizeJobId(input.jobId),
    kind: normalizeKind(input.kind),
    uri: normalizeUri(id, input.uri),
    mimeType: normalizeMimeType(input.mimeType),
    checksum: normalizeChecksum(input.checksum),
    metadata: normalizeMetadata(input.metadata),
  };
}

function parseMetadata(json: string | null): AssetMetadata | null {
  if (json === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidAssetRecordError(
      "metadata",
      "persisted metadata_json is not valid JSON",
    );
  }

  return normalizeMetadata(parsed as AssetMetadata);
}

function mapAsset(row: AssetRow): AssetRecord {
  if (!assetKinds.includes(row.kind as AssetKind)) {
    throw new InvalidAssetRecordError("kind", "persisted kind is unsupported");
  }
  if (!assetStatuses.includes(row.status as AssetStatus)) {
    throw new InvalidAssetRecordError(
      "status",
      "persisted asset status is unsupported",
    );
  }
  if (row.mime_type === null) {
    throw new InvalidAssetRecordError("mimeType", "persisted value is missing");
  }
  if (row.checksum === null) {
    throw new InvalidAssetRecordError("checksum", "persisted value is missing");
  }

  const id = normalizeId(row.id);
  return {
    id,
    jobId: normalizeJobId(row.job_id),
    kind: normalizeKind(row.kind as AssetKind),
    uri: normalizeUri(id, row.uri),
    mimeType: normalizeMimeType(row.mime_type),
    checksum: normalizeChecksum(row.checksum),
    metadata: parseMetadata(row.metadata_json),
    status: row.status as AssetStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQLite implementation over the assets table owned by the initial schema.
 * Asset bytes remain outside SQLite and are managed by AssetStore.
 */
export class AssetRepository implements AssetRepositoryContract {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  create(input: CreateAssetRecordInput): AssetRecord {
    const normalized = normalizeInput(input);

    const insert = this.#db.transaction(() => {
      if (normalized.jobId !== null) {
        this.#requireJob(normalized.jobId);
      }

      if (this.getById(normalized.id)) {
        throw new AssetAlreadyExistsError(normalized.id);
      }

      const now = new Date().toISOString();
      const result = this.#db
        .prepare(
          `INSERT INTO assets (
            id, job_id, kind, uri, mime_type, checksum,
            metadata_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        )
        .run(
          normalized.id,
          normalized.jobId,
          normalized.kind,
          normalized.uri,
          normalized.mimeType,
          normalized.checksum,
          normalized.metadata === null
            ? null
            : JSON.stringify(normalized.metadata),
          now,
          now,
        );

      if (result.changes !== 1) {
        throw new Error(`Asset insert did not persist: ${normalized.id}`);
      }
    });

    insert();
    return this.#requireAsset(normalized.id);
  }

  getById(id: string): AssetRecord | null {
    const row = this.#db
      .prepare(`SELECT ${selectColumns} FROM assets WHERE id = ?`)
      .get(id) as AssetRow | undefined;

    return row ? mapAsset(row) : null;
  }

  getByJob(jobId: string): readonly AssetRecord[] {
    this.#requireJob(jobId);

    return (
      this.#db
        .prepare(
          `SELECT ${selectColumns}
           FROM assets
           WHERE job_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(jobId) as AssetRow[]
    ).map(mapAsset);
  }

  #requireJob(jobId: string): JobLookupRow {
    const row = this.#db
      .prepare("SELECT id FROM jobs WHERE id = ?")
      .get(jobId) as JobLookupRow | undefined;

    if (!row) {
      throw new JobNotFoundError(jobId);
    }

    return row;
  }

  #requireAsset(assetId: string): AssetRecord {
    const asset = this.getById(assetId);
    if (!asset) {
      throw new Error(`Asset disappeared after create: ${assetId}`);
    }
    return asset;
  }
}
