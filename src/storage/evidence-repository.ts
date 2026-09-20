import {
  InvalidPublicationEvidenceError,
  PublicationEvidenceAlreadyExistsError,
  SensitivePublicationEvidenceError,
  publicationEvidenceKinds,
  type AppendPublicationEvidenceInput,
  type EvidenceRepository as EvidenceRepositoryContract,
  type PublicationEvidence,
  type PublicationEvidenceKind,
  type PublicationEvidenceMetadata,
} from "../contracts/evidence.js";
import { JobNotFoundError } from "../contracts/job.js";
import {
  publishPlatforms,
  type PublishPlatform,
} from "../contracts/publish-job.js";

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
  platform: PublishPlatform;
}

interface EvidenceIdRow {
  id: string;
}

interface EvidenceRow {
  id: string;
  job_id: string;
  kind: string;
  uri: string | null;
  value: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface NormalizedEvidenceInput {
  readonly id: string;
  readonly jobId: string;
  readonly kind: PublicationEvidenceKind;
  readonly uri: string | null;
  readonly value: string | null;
  readonly metadata: PublicationEvidenceMetadata | null;
}

const MAX_ID_LENGTH = 200;
const MAX_URI_LENGTH = 4096;
const MAX_REFERENCE_LENGTH = 512;
const MAX_METADATA_BYTES = 4 * 1024;

const allowedMetadataKeys = new Set<keyof PublicationEvidenceMetadata>([
  "platform",
  "verifiedBy",
  "mimeType",
  "purpose",
  "capturedAt",
  "sha256",
]);

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

const safeReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const safeMetadataIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const mimeTypePattern =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const sha256Pattern = /^[A-Fa-f0-9]{64}$/;

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
    throw new SensitivePublicationEvidenceError(fieldPath);
  }
}

function assertBoundedIdentity(
  field: "id" | "jobId",
  value: string,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPublicationEvidenceError(field, "must be a non-empty string");
  }

  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidPublicationEvidenceError(
      field,
      `must be at most ${MAX_ID_LENGTH} characters`,
    );
  }

  assertNoSensitiveString(value, field);

  if (!safeReferencePattern.test(value)) {
    throw new InvalidPublicationEvidenceError(
      field,
      "must be an application-generated bounded identifier",
    );
  }
}

function normalizeMetadata(
  metadata: PublicationEvidenceMetadata | null | undefined,
): PublicationEvidenceMetadata | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidPublicationEvidenceError(
      "metadata",
      "must be a flat metadata object",
    );
  }

  const normalized: {
    platform?: PublishPlatform;
    verifiedBy?: string;
    mimeType?: string;
    purpose?: string;
    capturedAt?: string;
    sha256?: string;
  } = {};

  for (const [key, rawValue] of Object.entries(metadata)) {
    if (isSensitiveKeyName(key)) {
      throw new SensitivePublicationEvidenceError(`metadata.${key}`);
    }

    if (!allowedMetadataKeys.has(key as keyof PublicationEvidenceMetadata)) {
      throw new InvalidPublicationEvidenceError(
        "metadata",
        `unsupported key: ${key}`,
      );
    }

    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      throw new InvalidPublicationEvidenceError(
        "metadata",
        `${key} must be a non-empty string`,
      );
    }

    const value = rawValue.trim();
    assertNoSensitiveString(value, `metadata.${key}`);

    switch (key) {
      case "platform":
        if (!publishPlatforms.includes(value as PublishPlatform)) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            `unsupported platform: ${value}`,
          );
        }
        normalized.platform = value as PublishPlatform;
        break;
      case "verifiedBy":
        if (
          value.length > 128 ||
          !safeMetadataIdentifierPattern.test(value)
        ) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            "verifiedBy must be a bounded identifier",
          );
        }
        normalized.verifiedBy = value;
        break;
      case "mimeType":
        if (value.length > 128 || !mimeTypePattern.test(value)) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            "mimeType must be a valid bounded media type",
          );
        }
        normalized.mimeType = value;
        break;
      case "purpose":
        if (
          value.length > 128 ||
          !safeMetadataIdentifierPattern.test(value)
        ) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            "purpose must be a bounded identifier",
          );
        }
        normalized.purpose = value;
        break;
      case "capturedAt":
        if (value.length > 64 || Number.isNaN(Date.parse(value))) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            "capturedAt must be a valid timestamp",
          );
        }
        normalized.capturedAt = value;
        break;
      case "sha256":
        if (!sha256Pattern.test(value)) {
          throw new InvalidPublicationEvidenceError(
            "metadata",
            "sha256 must be a 64-character hexadecimal digest",
          );
        }
        normalized.sha256 = value.toLowerCase();
        break;
    }
  }

  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new InvalidPublicationEvidenceError(
      "metadata",
      `must serialize to at most ${MAX_METADATA_BYTES} bytes`,
    );
  }

  return normalized;
}

function normalizeUri(
  kind: PublicationEvidenceKind,
  uri: string | null | undefined,
): string | null {
  if (uri === undefined || uri === null) {
    return null;
  }

  if (typeof uri !== "string" || uri.trim().length === 0) {
    throw new InvalidPublicationEvidenceError("uri", "must be a non-empty URI");
  }

  const normalized = uri.trim();
  if (normalized.length > MAX_URI_LENGTH) {
    throw new InvalidPublicationEvidenceError(
      "uri",
      `must be at most ${MAX_URI_LENGTH} characters`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new InvalidPublicationEvidenceError("uri", "must be an absolute URI");
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new SensitivePublicationEvidenceError("uri.credentials");
  }

  if (
    kind === "result_url" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw new InvalidPublicationEvidenceError(
      "uri",
      "result_url must use http or https",
    );
  }

  if (
    kind === "artifact_uri" &&
    !["file:", "https:", "http:"].includes(parsed.protocol)
  ) {
    throw new InvalidPublicationEvidenceError(
      "uri",
      "artifact_uri must use file, http, or https",
    );
  }

  for (const [key, queryValue] of parsed.searchParams.entries()) {
    if (isSensitiveKeyName(key)) {
      throw new SensitivePublicationEvidenceError(`uri.query.${key}`);
    }
    assertNoSensitiveString(queryValue, `uri.query.${key}.value`);
  }

  assertNoSensitiveString(
    `${parsed.pathname}${parsed.hash}`,
    "uri.path_or_fragment",
  );

  return normalized;
}

function normalizeValue(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPublicationEvidenceError(
      "value",
      "must be a non-empty string",
    );
  }

  const normalized = value.trim();
  if (normalized.length > MAX_REFERENCE_LENGTH) {
    throw new InvalidPublicationEvidenceError(
      "value",
      `must be at most ${MAX_REFERENCE_LENGTH} characters`,
    );
  }

  assertNoSensitiveString(normalized, "value");

  if (!safeReferencePattern.test(normalized)) {
    throw new InvalidPublicationEvidenceError(
      "value",
      "must be a bounded reference identifier",
    );
  }

  return normalized;
}

function normalizeInput(
  input: AppendPublicationEvidenceInput,
): NormalizedEvidenceInput {
  assertBoundedIdentity("id", input.id);
  assertBoundedIdentity("jobId", input.jobId);

  if (!publicationEvidenceKinds.includes(input.kind)) {
    throw new InvalidPublicationEvidenceError("kind", "is unsupported");
  }

  const uri = normalizeUri(input.kind, input.uri);
  const value = normalizeValue(input.value);
  const metadata = normalizeMetadata(input.metadata);

  if (input.kind === "result_url" || input.kind === "artifact_uri") {
    if (uri === null) {
      throw new InvalidPublicationEvidenceError(
        "uri",
        `${input.kind} requires uri`,
      );
    }
    if (value !== null) {
      throw new InvalidPublicationEvidenceError(
        "value",
        `${input.kind} does not accept value`,
      );
    }
  } else {
    if (value === null) {
      throw new InvalidPublicationEvidenceError(
        "value",
        `${input.kind} requires value`,
      );
    }
    if (uri !== null) {
      throw new InvalidPublicationEvidenceError(
        "uri",
        `${input.kind} does not accept uri`,
      );
    }
  }

  return {
    id: input.id,
    jobId: input.jobId,
    kind: input.kind,
    uri,
    value,
    metadata,
  };
}

function mapEvidence(row: EvidenceRow): PublicationEvidence {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind as PublicationEvidenceKind,
    uri: row.uri,
    value: row.value,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as PublicationEvidenceMetadata)
      : null,
    createdAt: row.created_at,
  };
}

/**
 * SQLite implementation over the evidence table owned by the accepted
 * initial-schema migration. The repository is append-only: once persisted,
 * evidence can only be read through this boundary.
 */
export class EvidenceRepository implements EvidenceRepositoryContract {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  append(input: AppendPublicationEvidenceInput): PublicationEvidence {
    const normalized = normalizeInput(input);
    const createdAt = new Date().toISOString();

    const insert = this.#db.transaction(() => {
      const job = this.#requireJob(normalized.jobId);

      if (
        normalized.metadata?.platform !== undefined &&
        normalized.metadata.platform !== job.platform
      ) {
        throw new InvalidPublicationEvidenceError(
          "metadata",
          "platform must match the owning Job",
        );
      }

      const existing = this.#db
        .prepare("SELECT id FROM evidence WHERE id = ?")
        .get(normalized.id) as EvidenceIdRow | undefined;

      if (existing) {
        throw new PublicationEvidenceAlreadyExistsError(normalized.id);
      }

      this.#db
        .prepare(
          `INSERT INTO evidence (
            id, job_id, kind, uri, value, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.id,
          normalized.jobId,
          normalized.kind,
          normalized.uri,
          normalized.value,
          normalized.metadata === null
            ? null
            : JSON.stringify(normalized.metadata),
          createdAt,
        );
    });

    insert();
    return this.#requireEvidence(normalized.id);
  }

  getByJob(jobId: string): readonly PublicationEvidence[] {
    this.#requireJob(jobId);

    return (
      this.#db
        .prepare(
          `SELECT id, job_id, kind, uri, value, metadata_json, created_at
           FROM evidence
           WHERE job_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(jobId) as EvidenceRow[]
    ).map(mapEvidence);
  }

  #requireJob(jobId: string): JobLookupRow {
    const row = this.#db
      .prepare("SELECT id, platform FROM jobs WHERE id = ?")
      .get(jobId) as JobLookupRow | undefined;

    if (!row) {
      throw new JobNotFoundError(jobId);
    }

    return row;
  }

  #requireEvidence(evidenceId: string): PublicationEvidence {
    const row = this.#db
      .prepare(
        `SELECT id, job_id, kind, uri, value, metadata_json, created_at
         FROM evidence
         WHERE id = ?`,
      )
      .get(evidenceId) as EvidenceRow | undefined;

    if (!row) {
      throw new Error(
        `PublicationEvidence disappeared after append: ${evidenceId}`,
      );
    }

    return mapEvidence(row);
  }
}
