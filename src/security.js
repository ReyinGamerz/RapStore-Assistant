export const MAX_PROOF_ATTACHMENTS = 5;
export const MAX_PROOF_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAX_TRANSCRIPT_MESSAGES = 2000;
export const MAX_TRANSCRIPT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Role checks are intentionally centralized so command, panel, ticket, and
 * payment handlers use the same strict Founder/Admin definition.
 */
export function isStaffMember(member, roleIds = []) {
  const cache = member?.roles?.cache;
  if (!cache || typeof cache.has !== "function" || !Array.isArray(roleIds)) return false;
  return roleIds.some(roleId =>
    typeof roleId === "string" && roleId.length > 0 && cache.has(roleId)
  );
}

export function canAccessTicket(ticket, userId, isStaff = false) {
  if (!ticket || !userId) return false;
  return String(ticket.buyerId || "") === String(userId) || Boolean(isStaff);
}

export function escapeDiscordMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateProofAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: false, reason: "Lampirkan minimal satu file bukti transfer." };
  }
  if (attachments.length > MAX_PROOF_ATTACHMENTS) {
    return { ok: false, reason: "Maksimal " + MAX_PROOF_ATTACHMENTS + " file bukti transfer dalam satu pesan." };
  }
  const sizes = attachments.map(item => Number(item?.size));
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 0)) {
    return { ok: false, reason: "Ada lampiran yang tidak valid. Kirim ulang file bukti transfer." };
  }
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes > MAX_PROOF_TOTAL_BYTES) {
    return { ok: false, reason: "Total ukuran bukti transfer maksimal 15 MB per pesan." };
  }
  if (attachments.some(item => !isHttpsUrl(item?.url))) {
    return { ok: false, reason: "Ada lampiran yang tidak valid. Kirim ulang file bukti transfer." };
  }
  return { ok: true, totalBytes };
}

/**
 * Resolve the durable order state after an interrupted payment-review side effect.
 * "pending" means the proof is still the current proof and awaits staff review.
 */
export function expectedProofStatus(proof, order) {
  if (!proof || proof.status !== "pending") return null;
  if (!order || String(order.latestProofId || "") !== String(proof._id || "")) return "superseded";
  if (["PROSES", "DONE"].includes(order.status) && order.paymentStatus === "verified") return "accepted";
  if (order.status === "ON HOLD" && order.paymentStatus === "rejected") return "rejected";
  if (order.status === "ON HOLD" && order.paymentStatus === "pending_review") return "pending";
  return "superseded";
}
