import test from "node:test";
import assert from "node:assert/strict";
import { reconcileMissingTicket } from "../src/ticket-recovery.js";

test("missing-channel recovery updates ticket, order, and proof records with one defined timestamp", async () => {
  const calls = [];
  const db = {
    collection(name) {
      return {
        updateOne: async (...args) => { calls.push({ collection: name, method: "updateOne", args }); return { modifiedCount: 1 }; },
        updateMany: async (...args) => { calls.push({ collection: name, method: "updateMany", args }); return { modifiedCount: 1 }; },
      };
    },
  };
  const now = new Date("2026-10-10T12:00:00.000Z");
  const activeTicket = { _id: "ticket-1", channelId: "channel-1" };
  const result = await reconcileMissingTicket({ db, guildId: "guild-1", activeTicket, actorId: "buyer-1", now });

  assert.equal(result, now);
  assert.equal(calls.length, 5);
  const ticketUpdate = calls.find(call => call.collection === "tickets").args[1].$set;
  assert.equal(ticketUpdate.status, "deleted");
  assert.equal(ticketUpdate.closedAt, now);
  assert.equal(ticketUpdate.cleanupAt, now);
  const cancelledOrder = calls.find(call => call.collection === "orders" && call.args[0].status === "ON HOLD");
  assert.equal(cancelledOrder.args[1].$set.cancelledAt, now);
  assert.equal(cancelledOrder.args[1].$set.cancelledBy, "buyer-1");
  const supersededProof = calls.find(call => call.collection === "payment_proofs");
  assert.equal(supersededProof.args[1].$set.supersededAt, now);
  assert.equal(calls.filter(call => call.collection === "orders").length, 3);
});

test("missing-channel recovery rejects incomplete identifiers before writing", async () => {
  let writes = 0;
  const db = { collection: () => ({ updateOne: async () => { writes++; }, updateMany: async () => { writes++; } }) };
  await assert.rejects(
    reconcileMissingTicket({ db, guildId: "guild-1", activeTicket: { _id: "ticket-1" }, actorId: "buyer-1" }),
    TypeError,
  );
  assert.equal(writes, 0);
});
