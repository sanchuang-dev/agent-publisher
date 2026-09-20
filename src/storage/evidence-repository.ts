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
import { JobNotFoundError, type JsonValue } from "../contracts/job.js";

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
const MAX_VALUE_LENGTH = 4096;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_DEPTH = 8;

const forbiddenKeyNames = new Set([
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "cookies",
  "idtoken",
  "localstorage",
  "password",
  "passwd",
  "pwd",
  "qrcode",
  "qrartifact",
  "refreshtoken",
  "secret",
  "sessionstorage",
  "setcookie",
  "storagestate",
  "token",
  "accesstoken",
]);

const forbiddenStringPatterns = [
  /\bauthorization\s*:\s*bearer\b/i,
  /\b(?:access_token|refresh_token|id_token|api_key|client_secret|password|passwd|cookie|set-cookie)\s*=/i,
  /\b(?:storage[_-]?state|local[_-]?storage|session[_-]?storage)\s*[:=]/i,
];

const forbiddenUriQueryKeys = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "cookie",
  "id_token",
  "password",
  "refresh_token",
  "token",
]);

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
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
      \`must be at most \${MAX_ID_LENGTH} characters\`,
    );
  }
}

function assertJsonSafe(
  value: JsonValue,
  path: string,
  depth: number,
): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new InvalidPublicationEvidenceError(
      "metadata",
      \`nesting exceeds \${MAX_METADATA_DEPTH} levels at \${path}\`,
    );
  }

  if (typeof value === "string") {
    if (forbiddenStringPatterns.some((pattern) => pattern.test(value))) {
      throw new SensitivePublicationEvidenceError(path);
    }
    return;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonSafe(item, \`\${path}[\${index}]\`, depth + 1);
    });
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenKeyNames.has(normalizeKeyName(key))) {
      throw new SensitivePublicationEvidenceError(\`\${path}.\${key}\`);
    }
    assertJsonSafe(nestedValue, \`\${path}.\${key}\`, depth + 1);
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
      "must be a JSON object",
    );
  }

  assertJsonSafe(metadata, "metadata", 0);

  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new InvalidPublicationEvidenceError(
      "metadata",
      \`must serialize to at most \${MAX_METADATA_BYTES} bytes\`,
    );
  }

  return metadata;
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
      \`must be at most \${MAX_URI_LENGTH} characters\`,
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

  for (const key of parsed.searchParams.keys()) {
    if (forbiddenUriQueryKeys.has(key.toLowerCase())) {
      throw new SensitivePublicationEvidenceError(\`uri.query.\${key}\`);
    }
  }

  if (kind === "result_url" && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidPublicationEvidenceError(
      "uri",
      "result_url must use http or https",
    );
  }

  if (["data:", "javascript:", "vbscript:"].includes(parsed.protocol)) {
    throw new InvalidPublicationEvidenceError(
      "uri",
      \`scheme \${parsed.protocol} is not allowed for evidence\`,
    );
  }

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
  if (normalized.length > MAX_VALUE_LENGTH) {
    throw new InvalidPublicationEvidenceError(
      "value",
      \`must be at most \${MAX_VALUE_LENGTH} characters\`,
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
        \`\${input.kind} requires uri\`,
      );
    }
    if (value !== null) {
      throw new InvalidPublicationEvidenceError(
        "value",
        \`\${input.kind} does not accept value\`,
      );
    }
  } else {
    if (value === null) {
      throw new InvalidPublicationEvidenceError(
        "value",
        \`\${input.kind} requires value\`,
      );
    }
    if (uri !== null) {
      throw new InvalidPublicationEvidenceError(
        "uri",
        \`\${input.kind} does not accept uri\`,
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
      this.#requireJob(normalized.jobId);

      const existing = this.#db
        .prepare("SELECT id FROM evidence WHERE id = ?")
        .get(normalized.id) as EvidenceIdRow | undefined;

      if (existing) {
        throw new PublicationEvidenceAlreadyExistsError(normalized.id);
      }

      this.#db
        .prepare(
          \`INSERT INTO evidence (
            id, job_id, kind, uri, value, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)\`,
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
          \`SELECT id, job_id, kind, uri, value, metadata_json, created_at
           FROM evidence
           WHERE job_id = ?
           ORDER BY created_at ASC, rowid ASC\`,
        )
        .all(jobId) as EvidenceRow[]
    ).map(mapEvidence);
  }

  #requireJob(jobId: string): void {
    const row = this.#db
      .prepare("SELECT id FROM jobs WHERE id = ?")
      .get(jobId) as JobLookupRow | undefined;

    if (!row) {
      throw new JobNotFoundError(jobId);
    }
  }

  #requireEvidence(evidenceId: string): PublicationEvidence {
    const row = this.#db
      .prepare(
        \`SELECT id, job_id, kind, uri, value, metadata_json, created_at
         FROM evidence
         WHERE id = ?\`,
      )
      .get(evidenceId) as EvidenceRow | undefined;

    if (!row) {
      throw new Error(\`PublicationEvidence disappeared after append: \${evidenceId}\`);
    }

    return mapEvidence(row);
  }
}
