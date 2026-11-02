/** Stream through docker exec stdin; read existing Atlas metadata and S3 HEAD only. Never loads application bootstrap. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import path from "node:path";

const report = {observedAt: new Date().toISOString(), scope: "live source attachment metadata versus existing S3 objects",
  sourceFrozen: false, applicationDataWrites: 0, objectWrites: 0, objectBytesDownloaded: 0, keysOrBucketsChanged: false,
  contentHashVerified: false, concurrency: 4, anomalies: []};
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
let mongo, s3;
try {
  if (process.env.MELDIQ_READONLY_S3_AUDIT !== "1" || process.env.DATABASE_MODE !== "atlas" || !(process.env.MONGODB_DOMAINS ?? "").split(",").map(value => value.trim()).includes("files")) throw new Error("Explicit Atlas files read-only audit required");
  if (process.env.STORAGE_BACKEND !== "s3" || !process.env.S3_BUCKET || !(process.env.S3_REGION || process.env.AWS_REGION) || !process.env.MONGODB_DB?.trim()) throw new Error("Existing S3 and explicit source database configuration required");
  const {MongoClient} = await import("mongodb");
  const {S3Client, HeadObjectCommand} = await import("@aws-sdk/client-s3");
  const region = (process.env.S3_REGION ?? process.env.AWS_REGION).trim();
  let prefix = (process.env.S3_PREFIX ?? "orbit/").trim();
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const credentials = process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.S3_ACCESS_KEY_ID.trim(), secretAccessKey: process.env.S3_SECRET_ACCESS_KEY.trim(),
    ...(process.env.S3_SESSION_TOKEN ? {sessionToken: process.env.S3_SESSION_TOKEN.trim()} : {}),
  } : undefined;
  s3 = new S3Client({region, credentials, endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true", maxAttempts: 2,
    requestHandler: {connectionTimeout: 5000, requestTimeout: 10000, httpsAgent: {keepAlive: true, maxSockets: 4}}});
  mongo = new MongoClient(process.env.MONGODB_URI, {maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 10000, appName: "meldiq-supabase-readonly-s3-audit"});
  await mongo.connect();
  const attachments = mongo.db(process.env.MONGODB_DB.trim()).collection("attachments");
  report.sourceCountStart = await attachments.countDocuments({}, {maxTimeMS: 10000});
  if (!report.sourceCountStart) throw new Error("Known source attachment metadata is unexpectedly empty");
  if (report.sourceCountStart > 5000) throw new Error("Source exceeds bounded audit scope; prepare a reviewed paged run");
  const rows = await attachments.find({}, {projection: {_id: 1, id: 1, size: 1, created_at: 1, expires_at: 1, conversation_id: 1, uploader_user_id: 1},
    batchSize: 200, maxTimeMS: 20000, readConcern: {level: "majority"}}).toArray();
  rows.sort((a, b) => String(a._id).localeCompare(String(b._id), "en"));
  report.sourceRecords = rows.length;
  report.sourceMetadataSha256 = hash(JSON.stringify(rows.map(row => [String(row._id), row.id, String(row.size), String(row.created_at), String(row.expires_at)])));
  report.region = region;
  report.localReadFallbackConfigured = process.env.STORAGE_READ_FALLBACK?.trim() === "local";
  report.localFallbackByteMatches = 0;
  report.localFallbackReadableMatches = 0;
  report.localFallbackExpectedBytes = "0";
  report.bucketAndPrefixSha256 = hash(`${process.env.S3_BUCKET.trim()}\n${prefix}`);
  report.headSucceeded = 0; report.exactByteLengthMatches = 0; report.expectedBytes = "0";
  report.http403Indeterminate = 0; report.http404NotFound = 0; report.otherHeadErrors = 0;
  const proofs = [], sizes = [], unresolved = [];
  const localDirectory = process.env.ATTACHMENT_DIR ?? path.join(process.env.DATA_DIR ?? path.resolve("data"), "attachments");
  let index = 0;
  await Promise.all(Array.from({length: 4}, async () => {
    while (index < rows.length) {
      const row = rows[index++], id = row.id ?? row._id, bytes = Number(String(row.size));
      const keyDigest = hash(String(id));
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(bytes) || bytes < 0 || String(row._id) !== id) {
        report.anomalies.push({keyDigest, kind: "invalid_source_metadata"}); continue;
      }
      sizes.push(BigInt(bytes));
      try {
        const result = await s3.send(new HeadObjectCommand({Bucket: process.env.S3_BUCKET.trim(), Key: `${prefix}attachments/${id}`}), {abortSignal: AbortSignal.timeout(12000)});
        report.headSucceeded++;
        proofs.push({keyDigest, bytes: result.ContentLength, etagSha256: typeof result.ETag === "string" ? hash(result.ETag) : null,
          lastModified: result.LastModified?.toISOString() ?? null});
        if (result.ContentLength === bytes) report.exactByteLengthMatches++;
        else report.anomalies.push({keyDigest, kind: "size_mismatch", expectedBytes: bytes, actualBytes: result.ContentLength ?? null});
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 403) report.http403Indeterminate++;
        else if (status === 404) report.http404NotFound++;
        else report.otherHeadErrors++;
        const anomaly = {keyDigest, kind: status === 403 ? "forbidden_or_missing" : status === 404 ? "not_found" : "head_failed", httpStatus: Number.isInteger(status) ? status : null};
        if (status === 404) {
          // Matches the existing LocalBlobStore path; stat reads no object bytes and creates no directories.
          const local = await fs.stat(path.join(localDirectory, id)).catch(() => null);
          anomaly.localFileExists = !!local?.isFile();
          anomaly.localBytesMatch = !!local?.isFile() && local.size === bytes;
          anomaly.localReadable = !!local?.isFile() && await fs.access(path.join(localDirectory, id), fsConstants.R_OK).then(() => true, () => false);
          if (report.localReadFallbackConfigured && anomaly.localBytesMatch) report.localFallbackByteMatches++;
          if (report.localReadFallbackConfigured && anomaly.localBytesMatch && anomaly.localReadable) {
            report.localFallbackReadableMatches++;
            report.localFallbackExpectedBytes = (BigInt(report.localFallbackExpectedBytes) + BigInt(bytes)).toString();
          }
          anomaly.expiredMetadata = Number(String(row.expires_at)) <= Date.now();
          anomaly.createdAt = Number.isSafeInteger(Number(String(row.created_at))) ? Number(String(row.created_at)) : null;
          unresolved.push({row, anomaly});
        }
        report.anomalies.push(anomaly);
      }
    }
  }));
  report.expectedBytes = sizes.reduce((sum, value) => sum + value, 0n).toString();
  proofs.sort((a, b) => a.keyDigest.localeCompare(b.keyDigest, "en"));
  report.objectMetadataProofSha256 = hash(JSON.stringify(proofs));
  const source = mongo.db(process.env.MONGODB_DB.trim());
  const conversations = new Set((await source.collection("conversations").find({_id: {$in: [...new Set(unresolved.map(item => item.row.conversation_id))]}}, {projection: {_id: 1}, maxTimeMS: 10000}).toArray()).map(row => String(row._id)));
  const users = new Set((await source.collection("users").find({_id: {$in: [...new Set(unresolved.map(item => item.row.uploader_user_id))]}}, {projection: {_id: 1}, maxTimeMS: 10000}).toArray()).map(row => String(row._id)));
  for (const item of unresolved) {
    item.anomaly.conversationExists = conversations.has(String(item.row.conversation_id));
    item.anomaly.uploaderExists = users.has(String(item.row.uploader_user_id));
  }
  report.sourceCountEnd = await attachments.countDocuments({}, {maxTimeMS: 10000});
  report.allReferencedS3ObjectsMatched = report.anomalies.length === 0 && rows.length === report.sourceCountStart && rows.length === report.sourceCountEnd;
  report.currentStorageAvailabilityPassed = report.exactByteLengthMatches + report.localFallbackReadableMatches === rows.length && rows.length === report.sourceCountStart && rows.length === report.sourceCountEnd;
  report.ok = report.allReferencedS3ObjectsMatched;
} catch (error) {
  report.ok = false;
  report.errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{3,40}$/.test(error.code) ? error.code : "audit_failed";
} finally {
  await mongo?.close().catch(() => {});
  s3?.destroy();
  report.completedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.ok) process.exitCode = 1;
}
