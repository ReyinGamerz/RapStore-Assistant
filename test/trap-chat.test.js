import test from "node:test";
import assert from "node:assert/strict";
import { isTrapChannelMessage } from "../src/trap-chat.js";

const trapModule = await import("../src/trap-chat.js");

const message = (channelId, channelName = "general") => ({
  guildId: "guild-1",
  channelId,
  channel: { id: channelId, name: channelName, guildId: "guild-1" },
});

test("only the persisted trap channel ID matches", () => {
  assert.equal(isTrapChannelMessage(message("trap-123", "🚫・trap-chat"), "trap-123"), true);
  assert.equal(isTrapChannelMessage(message("ordinary-456", "general"), "trap-123"), false);
});

test("a different channel containing the word trap is not a trap", () => {
  assert.equal(isTrapChannelMessage(message("channel-789", "trap-discussion"), "trap-123"), false);
  assert.equal(isTrapChannelMessage(message("channel-789", "backup-trap"), "trap-123"), false);
});

test("renaming the configured channel does not disable the trap", () => {
  assert.equal(isTrapChannelMessage(message("trap-123", "my-renamed-channel"), "trap-123"), true);
});

test("missing channel IDs fail closed", () => {
  assert.equal(isTrapChannelMessage(message("channel-1"), null), false);
  assert.equal(isTrapChannelMessage({ guildId: "guild-1" }, "trap-123"), false);
  assert.equal(isTrapChannelMessage({ channelId: "trap-123" }, "trap-123"), false);
});

test("startup restoration requires a persisted channel record", async () => {
  assert.equal(typeof trapModule.restoreConfiguredTrapChannel, "function");
  let ensureCalls = 0;
  const result = await trapModule.restoreConfiguredTrapChannel(
    { id: "guild-1" },
    {
      trapChannels: { findOne: async () => null },
      ensure: async () => { ensureCalls++; return { channel: { id: "wrong-channel" } }; },
    },
  );
  assert.equal(result, null);
  assert.equal(ensureCalls, 0);
});

test("concurrent strikes are counted atomically and timeout applications stay ordered", async () => {
  assert.equal(typeof trapModule.applyTrapStrike, "function");
  const state = { record: null, legacy: null };
  const collection = {
    async findOne(filter) {
      if (filter.counterId) return state.record ? { ...state.record } : null;
      return state.legacy ? { ...state.legacy } : null;
    },
    async findOneAndUpdate(filter, update) {
      if (!state.record) state.record = { counterId: filter.counterId, count: 0, legacyCount: 0 };
      state.record.count += update.$inc.count;
      return { value: { ...state.record } };
    },
    async updateOne(_filter, update) {
      if (update.$inc?.count) state.record.count += update.$inc.count;
      if (update.$set?.lastTimeoutUntil) state.record.lastTimeoutUntil = update.$set.lastTimeoutUntil;
    },
  };
  const durations = [];
  let active = 0;
  let peakActive = 0;
  const logger = { error() {} };
  const makeMessage = () => ({
    guildId: "guild-1",
    author: { id: "user-1" },
    member: {
      async timeout(duration) {
        active++;
        peakActive = Math.max(peakActive, active);
        durations.push(duration);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
      },
    },
  });

  await Promise.all(Array.from({ length: 8 }, () =>
    trapModule.applyTrapStrike(makeMessage(), { collection, logger }),
  ));

  assert.equal(state.record.count, 8);
  assert.equal(peakActive, 1);
  assert.deepEqual(durations, [86_400_000, ...Array(7).fill(604_800_000)]);
});

test("a MongoDB reservation failure is reported separately and does not timeout the member", async () => {
  assert.equal(typeof trapModule.applyTrapStrike, "function");
  let timeoutCalls = 0;
  const errors = [];
  const collection = {
    async findOne() { throw new Error("database unavailable"); },
    async findOneAndUpdate() { throw new Error("database unavailable"); },
  };
  const result = await trapModule.applyTrapStrike({
    guildId: "guild-1",
    author: { id: "user-1" },
    member: { async timeout() { timeoutCalls++; } },
  }, { collection, logger: { error: (...args) => errors.push(args) } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "database");
  assert.equal(timeoutCalls, 0);
  assert.match(String(errors[0]?.[0]), /MongoDB strike reservation failed/);
});

test("a post-timeout metadata write failure is logged as persistence failure, without retrying timeout", async () => {
  assert.equal(typeof trapModule.applyTrapStrike, "function");
  let timeoutCalls = 0;
  const errors = [];
  const state = { record: { counterId: "trap-strike:guild-1:user-1", count: 0, legacyCount: 0 } };
  const collection = {
    async findOne() { return { ...state.record }; },
    async findOneAndUpdate(_filter, update) {
      state.record.count += update.$inc.count;
      return { value: { ...state.record } };
    },
    async updateOne() { throw new Error("database unavailable"); },
  };
  const result = await trapModule.applyTrapStrike({
    guildId: "guild-1",
    author: { id: "user-1" },
    member: { async timeout() { timeoutCalls++; } },
  }, { collection, logger: { error: (...args) => errors.push(args) } });

  assert.equal(result.ok, true);
  assert.equal(timeoutCalls, 1);
  assert.match(String(errors[0]?.[0]), /Discord timeout succeeded.*MongoDB metadata update failed/);
});

test("a Discord timeout failure is not retried and its reserved strike is rolled back", async () => {
  assert.equal(typeof trapModule.applyTrapStrike, "function");
  let timeoutCalls = 0;
  const state = { record: null };
  const collection = {
    async findOne(filter) { return filter.counterId ? state.record : null; },
    async findOneAndUpdate(filter, update) {
      if (!state.record) state.record = { counterId: filter.counterId, count: 0, legacyCount: 0 };
      state.record.count += update.$inc.count;
      return { value: { ...state.record } };
    },
    async updateOne(_filter, update) { state.record.count += update.$inc.count; },
  };
  const result = await trapModule.applyTrapStrike({
    guildId: "guild-1",
    author: { id: "user-1" },
    member: { async timeout() { timeoutCalls++; throw new Error("Discord rejected timeout"); } },
  }, { collection, logger: { error() {} } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(timeoutCalls, 1);
  assert.equal(state.record.count, 0);
});
