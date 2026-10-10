import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessTicket,
  escapeDiscordMarkdown,
  isStaffMember,
  validateProofAttachments,
  MAX_PROOF_ATTACHMENTS,
  MAX_PROOF_TOTAL_BYTES,
} from "../src/security.js";

const staffRoles = ["founder-role", "admin-role"];
const member = (...ids) => ({ roles: { cache: { has: id => ids.includes(id) } } });

test("accepts a small valid proof attachment", () => {
  assert.deepEqual(
    validateProofAttachments([{ url: "https://cdn.discordapp.com/attachments/proof.png", size: 1024 }]),
    { ok: true, totalBytes: 1024 },
  );
});

test("rejects missing attachments", () => {
  assert.equal(validateProofAttachments([]).ok, false);
  assert.equal(validateProofAttachments(null).ok, false);
});

test("rejects excessive attachment count", () => {
  const files = Array.from({ length: MAX_PROOF_ATTACHMENTS + 1 }, () => ({
    url: "https://cdn.discordapp.com/attachments/a.png", size: 1,
  }));
  assert.match(validateProofAttachments(files).reason, /Maksimal/);
});

test("rejects total size above the configured limit", () => {
  assert.equal(
    validateProofAttachments([{ url: "https://cdn.discordapp.com/attachments/a.png", size: MAX_PROOF_TOTAL_BYTES + 1 }]).ok,
    false,
  );
});

test("rejects malformed URLs and file sizes", () => {
  assert.equal(validateProofAttachments([{ url: "", size: 20 }]).ok, false);
  assert.equal(validateProofAttachments([{ url: "http://example.com/proof.png", size: 20 }]).ok, false);
  assert.equal(validateProofAttachments([{ url: "https://example.com/proof.png", size: -1 }]).ok, false);
  assert.equal(validateProofAttachments([{ url: "https://example.com/proof.png", size: 1.5 }]).ok, false);
  assert.equal(validateProofAttachments([{ url: "https://example.com/proof.png", size: Number.NaN }]).ok, false);
});

test("accepts several files while enforcing the aggregate limit", () => {
  const files = [
    { url: "https://cdn.discordapp.com/attachments/a.png", size: 100 },
    { url: "https://cdn.discordapp.com/attachments/b.png", size: 200 },
  ];
  assert.deepEqual(validateProofAttachments(files), { ok: true, totalBytes: 300 });
});

test("only configured Founder/Admin roles count as staff", () => {
  assert.equal(isStaffMember(member("founder-role"), staffRoles), true);
  assert.equal(isStaffMember(member("admin-role"), staffRoles), true);
  assert.equal(isStaffMember(member("member-role"), staffRoles), false);
  assert.equal(isStaffMember(null, staffRoles), false);
  assert.equal(isStaffMember(member("member-role"), [""]), false);
  assert.equal(isStaffMember(member("anything"), []), false);
});

test("ticket access is restricted to its owner or verified staff", () => {
  const ticket = { buyerId: "buyer-1" };
  assert.equal(canAccessTicket(ticket, "buyer-1", false), true);
  assert.equal(canAccessTicket(ticket, "another-user", true), true);
  assert.equal(canAccessTicket(ticket, "another-user", false), false);
  assert.equal(canAccessTicket(null, "buyer-1", true), false);
  assert.equal(canAccessTicket(ticket, "", true), false);
});

test("escapes user-controlled Markdown syntax in file names", () => {
  assert.equal(escapeDiscordMarkdown("a](<@&123>)_x_.png"), "a\\]\\(\\<@&123\\>\\)\\_x\\_\\.png");
});

import { expectedProofStatus } from "../src/security.js";

test("reconciles interrupted payment review from authoritative order state", () => {
  const proof = { _id: "proof-1", status: "pending" };
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-1", status: "PROSES", paymentStatus: "verified" }), "accepted");
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-1", status: "DONE", paymentStatus: "verified" }), "accepted");
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-1", status: "ON HOLD", paymentStatus: "rejected" }), "rejected");
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-1", status: "ON HOLD", paymentStatus: "pending_review" }), "pending");
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-2", status: "ON HOLD", paymentStatus: "pending_review" }), "superseded");
  assert.equal(expectedProofStatus(proof, { latestProofId: "proof-1", status: "CANCELLED", paymentStatus: "cancelled" }), "superseded");
  assert.equal(expectedProofStatus({ ...proof, status: "accepted" }, { latestProofId: "proof-1", status: "PROSES", paymentStatus: "verified" }), null);
  assert.equal(expectedProofStatus(proof, null), "superseded");
});
