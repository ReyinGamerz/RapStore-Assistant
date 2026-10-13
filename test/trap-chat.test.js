import test from "node:test";
import assert from "node:assert/strict";
import { isTrapChannelMessage } from "../src/trap-chat.js";

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
