export const MAX_PROOF_ATTACHMENTS = 5;
export const MAX_PROOF_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAX_TRANSCRIPT_MESSAGES = 2000;
export const MAX_TRANSCRIPT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export function validateProofAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: false, reason: "Lampirkan minimal satu file bukti transfer." };
  }
  if (attachments.length > MAX_PROOF_ATTACHMENTS) {
    return { ok: false, reason: "Maksimal " + MAX_PROOF_ATTACHMENTS + " file bukti transfer dalam satu pesan." };
  }
  const totalBytes = attachments.reduce((sum, item) => sum + Math.max(0, Number(item?.size) || 0), 0);
  if (totalBytes > MAX_PROOF_TOTAL_BYTES) {
    return { ok: false, reason: "Total ukuran bukti transfer maksimal 15 MB per pesan." };
  }
  if (attachments.some(item => !item?.url || !Number.isFinite(Number(item?.size)) || Number(item.size) < 0)) {
    return { ok: false, reason: "Ada lampiran yang tidak valid. Kirim ulang file bukti transfer." };
  }
  return { ok: true, totalBytes };
}
