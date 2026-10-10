import { createHash, createHmac } from "node:crypto";
import { config } from "./config.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, character =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

function safeFilename(value) {
  const cleaned = String(value || "attachment")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "attachment";
}

function storageSettings() {
  const storage = config.cloudStorage || {};
  const required = [
    ["B2_S3_ENDPOINT", storage.b2S3Endpoint],
    ["B2_REGION", storage.b2Region],
    ["B2_ACCESS_KEY_ID", storage.b2AccessKeyId],
    ["B2_SECRET_ACCESS_KEY", storage.b2SecretAccessKey],
    ["B2_BUCKET_NAME", storage.b2BucketName],
    ["B2_PUBLIC_BASE_URL", storage.b2PublicBaseUrl],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error("Backblaze B2 attachment storage is not configured. Set " + missing.join(", ") + " in .env; ticket deletion is blocked to prevent losing attachments.");
  }

  let endpoint;
  let publicBase;
  try {
    endpoint = new URL(storage.b2S3Endpoint);
    publicBase = new URL(storage.b2PublicBaseUrl);
  } catch {
    throw new Error("B2_S3_ENDPOINT and B2_PUBLIC_BASE_URL must be valid URLs.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname && endpoint.pathname !== "/")) {
    throw new Error("B2_S3_ENDPOINT must be the HTTPS S3 endpoint copied from bucket details, without a path, credentials, query, or fragment.");
  }
  if (publicBase.protocol !== "https:" || publicBase.username || publicBase.password || publicBase.search || publicBase.hash) {
    throw new Error("B2_PUBLIC_BASE_URL must be an HTTPS public bucket base URL without credentials, query, or fragment.");
  }
  return {
    ...storage,
    endpoint,
    publicBase: publicBase.href.replace(/\/$/, ""),
  };
}

function objectPath(bucket, key) {
  return "/" + awsEncode(bucket) + "/" + key.split("/").map(awsEncode).join("/");
}

async function uploadObject(settings, key, body, contentType) {
  const endpoint = settings.endpoint;
  const path = objectPath(settings.b2BucketName, key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = "host:" + endpoint.host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = "PUT\n" + path + "\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;
  const scope = dateStamp + "/" + settings.b2Region + "/s3/aws4_request";
  const stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256(canonicalRequest);
  const dateKey = hmac("AWS4" + settings.b2SecretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, settings.b2Region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = "AWS4-HMAC-SHA256 Credential=" + settings.b2AccessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  const response = await fetch(endpoint.origin + path, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType || "application/octet-stream",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error("Backblaze B2 upload failed (" + response.status + ")" + (detail ? ": " + detail : ""));
  }
  return settings.publicBase + "/" + key.split("/").map(awsEncode).join("/");
}

async function downloadAttachment(attachment) {
  const size = Number(attachment.size || 0);
  if (Number.isFinite(size) && size > MAX_FILE_BYTES) {
    throw new Error("Attachment '" + (attachment.name || "file") + "' exceeds the 25 MB cloud-upload limit.");
  }
  const source = String(attachment.url || "");
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("Attachment URL is invalid; cannot preserve it in the transcript.");
  }
  if (parsed.protocol !== "https:" || !/(^|\.)discordapp\.net$|(^|\.)discord\.com$|(^|\.)discordapp\.com$/i.test(parsed.hostname)) {
    throw new Error("Attachment URL is not a trusted HTTPS Discord CDN URL.");
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("Could not download attachment '" + (attachment.name || "file") + "' from Discord (HTTP " + response.status + ").");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_FILE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Attachment '" + (attachment.name || "file") + "' exceeds the 25 MB cloud-upload limit.");
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_FILE_BYTES) throw new Error("Attachment '" + (attachment.name || "file") + "' exceeds the 25 MB cloud-upload limit.");
  if (!body.length) throw new Error("Attachment '" + (attachment.name || "file") + "' downloaded as an empty file.");
  return body;
}

export async function persistTicketAttachments(messages, ticket) {
  const attachments = [];
  const seen = new Set();
  for (const message of messages) {
    for (const attachment of message.attachments?.values?.() || []) {
      if (!attachment?.url || seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      attachments.push({ messageId: message.id, attachment });
    }
  }
  const urls = new Map();
  if (!attachments.length) return urls;

  const settings = storageSettings();
  let totalBytes = 0;
  for (const { messageId, attachment } of attachments) {
    const body = await downloadAttachment(attachment);
    totalBytes += body.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Total lampiran tiket melebihi batas arsip cloud 100 MB. Tiket dipertahankan; kurangi ukuran/jumlah lampiran lalu coba tutup lagi.");
    }
    const key = "tickets/" + String(ticket._id) + "/" + messageId + "/" +
      String(attachment.id || sha256(attachment.url).slice(0, 16)) + "-" + safeFilename(attachment.name);
    const publicUrl = await uploadObject(settings, key, body, attachment.contentType || "application/octet-stream");
    urls.set(attachment.url, publicUrl);
  }
  return urls;
}
