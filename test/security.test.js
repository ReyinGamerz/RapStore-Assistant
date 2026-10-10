import test from "node:test";
import assert from "node:assert/strict";
import { validateProofAttachments, MAX_PROOF_ATTACHMENTS, MAX_PROOF_TOTAL_BYTES } from "../src/security.js";

test("accepts a small valid proof attachment", () => {
  assert.deepEqual(validateProofAttachments([{ url: "https://cdn.example/proof.png", size: 1024 }]), { ok: true, totalBytes: 1024 });
});
test("rejects missing attachments", () => {
  assert.equal(validateProofAttachments([]).ok, false);
});
test("rejects excessive attachment count", () => {
  const files = Array.from({ length: MAX_PROOF_ATTACHMENTS + 1 }, () => ({ url: "https://cdn.example/a.png", size: 1 }));
  assert.match(validateProofAttachments(files).reason, /Maksimal/);
});
test("rejects total size above the configured limit", () => {
  assert.equal(validateProofAttachments([{ url: "https://cdn.example/a.png", size: MAX_PROOF_TOTAL_BYTES + 1 }]).ok, false);
});
test("rejects malformed attachment metadata", () => {
  assert.equal(validateProofAttachments([{ url: "", size: 20 }]).ok, false);
});
