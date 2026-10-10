/**
 * Reconcile durable records when an open ticket references a channel that
 * Discord definitively reports as missing. All related records share one
 * timestamp so the cleanup can be traced as a single recovery operation.
 */
export async function reconcileMissingTicket({ db, guildId, activeTicket, actorId, now = new Date() }) {
  if (!db || !guildId || !activeTicket?._id || !activeTicket?.channelId) {
    throw new TypeError("Database, guild ID, and active ticket identifiers are required.");
  }

  await db.collection("tickets").updateOne(
    { _id: activeTicket._id, status: "open" },
    { $set: { status: "deleted", closedAt: now, closeReason: "discord_channel_missing", cleanupAt: now, transcriptStatus: "unavailable" } },
  );
  await db.collection("orders").updateMany(
    { guildId, channelId: activeTicket.channelId, status: "ON HOLD" },
    { $set: { status: "CANCELLED", paymentStatus: "cancelled", cancelledAt: now, cancelledBy: actorId, cancelReason: "ticket_channel_missing", updatedAt: now } },
  );
  await db.collection("payment_proofs").updateMany(
    { guildId, channelId: activeTicket.channelId, status: "pending" },
    { $set: { status: "superseded", supersededAt: now, supersededReason: "ticket_channel_missing", updatedAt: now }, $unset: { reviewSendingAt: "" } },
  );
  await db.collection("orders").updateMany(
    { guildId, channelId: activeTicket.channelId, status: "PROSES", ticketClosedAt: { $exists: false } },
    { $set: { ticketCloseBlockedAt: now, ticketCloseBlockedReason: "channel_missing_before_archive", ticketChannelMissingAt: now, transcriptStatus: "unavailable", updatedAt: now }, $unset: { closeProcessingAt: "" } },
  );
  // Keep DONE orders eligible for their one-time vouch publication.
  await db.collection("orders").updateMany(
    { guildId, channelId: activeTicket.channelId, status: "DONE", ticketClosedAt: { $exists: false } },
    { $set: { ticketChannelMissingAt: now, transcriptStatus: "unavailable", updatedAt: now }, $unset: { closeProcessingAt: "" } },
  );

  return now;
}
