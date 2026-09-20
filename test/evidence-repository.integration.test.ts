import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  InvalidPublicationEvidenceError,
  PublicationEvidenceAlreadyExistsError,
  SensitivePublicationEvidenceError,
  type EvidenceRepository as EvidenceRepositoryContract,
  type PublicationEvidenceMetadata,
} from "../src/contracts/evidence.js";
import { JobNotFoundError } from "../src/contracts/job.js";
import { openDatabase } from "../src/storage/db.js";
import { EvidenceRepository } from "../src/storage/evidence-repository.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-evidence-"));
  return { root, databasePath: join(root, "app.db") };
}

function unsafeMetadata(value: unknown): PublicationEvidenceMetadata {
  return value as PublicationEvidenceMetadata;
}

describe("EvidenceRepository integration", () => {
  let root: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase> | null;
  let jobs: JobRepository;
  let evidence: EvidenceRepository;

  beforeEach(() => {
    ({ root, databasePath } = makeTempDb());
    db = openDatabase({ databasePath });
    jobs = new JobRepository(db);
    evidence = new EvidenceRepository(db);

    const contract: EvidenceRepositoryContract = evidence;
    expect(contract).toBe(evidence);

    jobs.create({
      id: "job-evidence",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("append/read survives reopen and preserves bounded publication result fields", () => {
    const resultUrl = evidence.append({
      id: "evidence-result-url",
      jobId: "job-evidence",
      kind: "result_url",
      uri: "https://www.xiaohongshu.com/explore/post-123",
      metadata: {
        platform: "xiaohongshu",
        verifiedBy: "deterministic_result_page",
      },
    });

    const contentId = evidence.append({
      id: "evidence-content-id",
      jobId: "job-evidence",
      kind: "content_id",
      value: "post-123",
    });

    const artifact = evidence.append({
      id: "evidence-artifact",
      jobId: "job-evidence",
      kind: "artifact_uri",
      uri: "file:///tmp/agent-publisher/evidence/post-123.png",
      metadata: {
        mimeType: "image/png",
        purpose: "final_confirmation",
        capturedAt: "2026-09-20T05:00:00.000Z",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    expect(resultUrl).toMatchObject({
      id: "evidence-result-url",
      jobId: "job-evidence",
      kind: "result_url",
      uri: "https://www.xiaohongshu.com/explore/post-123",
      value: null,
      metadata: {
        platform: "xiaohongshu",
        verifiedBy: "deterministic_result_page",
      },
    });
    expect(contentId.value).toBe("post-123");
    expect(artifact).toMatchObject({
      uri: "file:///tmp/agent-publisher/evidence/post-123.png",
      metadata: {
        mimeType: "image/png",
        purpose: "final_confirmation",
        capturedAt: "2026-09-20T05:00:00.000Z",
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    db!.close();
    db = openDatabase({ databasePath });
    evidence = new EvidenceRepository(db);

    const reopened = evidence.getByJob("job-evidence");
    expect(reopened.map((item) => item.id)).toEqual([
      "evidence-result-url",
      "evidence-content-id",
      "evidence-artifact",
    ]);
    expect(reopened[0]).toEqual(resultUrl);
    expect(reopened[1]).toEqual(contentId);
    expect(reopened[2]).toEqual(artifact);
  });

  test("multiple evidence records for one job append in stable order without overwriting prior records", () => {
    evidence.append({
      id: "evidence-1",
      jobId: "job-evidence",
      kind: "content_id",
      value: "post-1",
    });
    evidence.append({
      id: "evidence-2",
      jobId: "job-evidence",
      kind: "confirmation_ref",
      value: "confirmation-1",
    });
    evidence.append({
      id: "evidence-3",
      jobId: "job-evidence",
      kind: "result_url",
      uri: "https://example.test/posts/post-1",
    });

    expect(evidence.getByJob("job-evidence").map((item) => item.id)).toEqual([
      "evidence-1",
      "evidence-2",
      "evidence-3",
    ]);

    expect(
      db!
        .prepare("SELECT COUNT(*) AS count FROM evidence WHERE job_id = ?")
        .get("job-evidence"),
    ).toEqual({ count: 3 });

    expect(() =>
      evidence.append({
        id: "evidence-2",
        jobId: "job-evidence",
        kind: "confirmation_ref",
        value: "replacement",
      }),
    ).toThrow(PublicationEvidenceAlreadyExistsError);

    expect(evidence.getByJob("job-evidence")[1]).toMatchObject({
      id: "evidence-2",
      value: "confirmation-1",
    });
  });

  test("secret/session payload classes are rejected before persistence", () => {
    const forbiddenInputs = [
      {
        id: "evidence-cookie-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ cookies: "redacted" }),
      },
      {
        id: "evidence-access-token-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ accessToken: "redacted" }),
      },
      {
        id: "evidence-session-id-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ sessionId: "redacted" }),
      },
      {
        id: "evidence-auth-token-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ authToken: "redacted" }),
      },
      {
        id: "evidence-session-token-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ sessionToken: "redacted" }),
      },
      {
        id: "evidence-secret-key",
        kind: "confirmation_ref" as const,
        value: "confirmed",
        metadata: unsafeMetadata({ secretKey: "redacted" }),
      },
      {
        id: "evidence-uri-token",
        kind: "result_url" as const,
        uri: "https://example.test/result?access_token=redacted",
      },
      {
        id: "evidence-uri-token-camel",
        kind: "result_url" as const,
        uri: "https://example.test/result?accessToken=redacted",
      },
      {
        id: "evidence-query-value-token",
        kind: "result_url" as const,
        uri: "https://example.test/result?state=access_token%3Dredacted",
      },
      {
        id: "evidence-fragment-token",
        kind: "result_url" as const,
        uri: "https://example.test/result#refreshToken=redacted",
      },
      {
        id: "evidence-value-token",
        kind: "confirmation_ref" as const,
        value: "access_token=redacted",
      },
      {
        id: "evidence-value-authorization",
        kind: "confirmation_ref" as const,
        value: "Authorization: Bearer redacted",
      },
      {
        id: "evidence-value-bearer",
        kind: "confirmation_ref" as const,
        value: "Bearer redacted",
      },
      {
        id: "evidence-value-jsessionid",
        kind: "confirmation_ref" as const,
        value: "JSESSIONID=redacted",
      },
      {
        id: "evidence-value-jwt",
        kind: "confirmation_ref" as const,
        value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
      },
    ];

    for (const input of forbiddenInputs) {
      expect(() =>
        evidence.append({
          jobId: "job-evidence",
          ...input,
        }),
      ).toThrow(SensitivePublicationEvidenceError);
    }

    expect(evidence.getByJob("job-evidence")).toEqual([]);
  });

  test("evidence and job identities cannot carry sensitive or free-form material", () => {
    expect(() =>
      evidence.append({
        id: "access_token=redacted",
        jobId: "job-evidence",
        kind: "content_id",
        value: "post-1",
      }),
    ).toThrow(SensitivePublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
        jobId: "job-evidence",
        kind: "content_id",
        value: "post-1",
      }),
    ).toThrow(SensitivePublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "evidence-safe",
        jobId: "cookie: session=redacted",
        kind: "content_id",
        value: "post-1",
      }),
    ).toThrow(SensitivePublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "evidence with spaces",
        jobId: "job-evidence",
        kind: "content_id",
        value: "post-1",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(evidence.getByJob("job-evidence")).toEqual([]);
  });

  test("metadata and reference fields are allowlisted and bounded", () => {
    expect(() =>
      evidence.append({
        id: "unsupported-metadata",
        jobId: "job-evidence",
        kind: "confirmation_ref",
        value: "confirmed",
        metadata: unsafeMetadata({ note: "arbitrary payload" }),
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "nested-metadata",
        jobId: "job-evidence",
        kind: "confirmation_ref",
        value: "confirmed",
        metadata: unsafeMetadata({
          verifiedBy: { method: "deterministic_result_page" },
        }),
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "free-form-reference",
        jobId: "job-evidence",
        kind: "confirmation_ref",
        value: "published successfully with arbitrary prose",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "platform-mismatch",
        jobId: "job-evidence",
        kind: "result_url",
        uri: "https://example.test/posts/post-1",
        metadata: {
          platform: "douyin",
        },
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(evidence.getByJob("job-evidence")).toEqual([]);
  });

  test("evidence kinds enforce their bounded uri/value shape", () => {
    expect(() =>
      evidence.append({
        id: "missing-url",
        jobId: "job-evidence",
        kind: "result_url",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "content-id-with-uri",
        jobId: "job-evidence",
        kind: "content_id",
        value: "post-123",
        uri: "https://example.test/not-allowed",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "bad-result-scheme",
        jobId: "job-evidence",
        kind: "result_url",
        uri: "file:///tmp/result.html",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(() =>
      evidence.append({
        id: "bad-artifact-scheme",
        jobId: "job-evidence",
        kind: "artifact_uri",
        uri: "ftp://example.test/evidence.png",
      }),
    ).toThrow(InvalidPublicationEvidenceError);

    expect(evidence.getByJob("job-evidence")).toEqual([]);
  });

  test("append and reads require an existing job", () => {
    expect(() =>
      evidence.append({
        id: "missing-job-evidence",
        jobId: "missing-job",
        kind: "content_id",
        value: "post-123",
      }),
    ).toThrow(JobNotFoundError);

    expect(() => evidence.getByJob("missing-job")).toThrow(JobNotFoundError);
  });
});
