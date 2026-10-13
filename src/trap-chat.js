import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getDatabase } from "./database.js";

const TRAP_CHANNEL_NAME = "🚫・trap-chat";
const trapChannelIds = new Map();
const ensureInFlight = new Map();
const strikeQueues = new Map();

function isTextChannelForGuild(channel, guildId) {
  return Boolean(
    channel &&
    channel.type === ChannelType.GuildText &&
    String(channel.guildId || channel.guild?.id || "") === String(guildId)
  );
}

/**
 * Match only the persisted channel ID. A channel name is never an enforcement
 * signal: ordinary channels may contain the word "trap".
 */
export function isTrapChannelMessage(message, trapChannelId) {
  return Boolean(
    message?.guildId &&
    message?.channelId &&
    trapChannelId &&
    String(message.channelId) === String(trapChannelId)
  );
}

async function findChannelById(guild, channelId) {
  if (!channelId) return null;
  try {
    const channel = await guild.channels.fetch(String(channelId));
    return isTextChannelForGuild(channel, guild.id) ? channel : null;
  } catch (error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    if (code === 10003) return null; // Discord Unknown Channel; the saved ID is stale.
    throw error;
  }
}

function requirePermission(guild, permission, name) {
  if (!guild.members.me?.permissions.has(permission)) {
    throw new Error("Bot perlu izin " + name + " untuk membuat ulang channel trap.");
  }
}

async function saveTrapChannel(guildId, channelId) {
  await getDatabase().collection("trap_channels").updateOne(
    { guildId: String(guildId) },
    {
      $set: {
        guildId: String(guildId),
        channelId: String(channelId),
        enabled: true,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  trapChannelIds.set(String(guildId), String(channelId));
}

async function ensureTrapChannelInternal(guild, excludedChannelId = null) {
  if (!guild?.id) throw new Error("Server Discord tidak valid.");

  const collection = getDatabase().collection("trap_channels");
  const record = await collection.findOne({ guildId: String(guild.id), enabled: { $ne: false } });

  // Only a persisted channel ID establishes identity. Never adopt a channel
  // solely because it has the trap's display name.
  let channel = record?.channelId && String(record.channelId) !== String(excludedChannelId || "")
    ? await findChannelById(guild, record.channelId)
    : null;

  let created = false;
  if (!channel) {
    requirePermission(guild, PermissionFlagsBits.ManageChannels, "Manage Channels");
    requirePermission(guild, PermissionFlagsBits.SendMessages, "Send Messages");
    requirePermission(guild, PermissionFlagsBits.ModerateMembers, "Moderate Members");

    channel = await guild.channels.create({
      name: TRAP_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: "Anti-spam trap: pesan di channel ini akan menghasilkan timeout otomatis.",
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
      reason: "RapStore Assistant: create or recover anti-spam trap channel",
    });
    created = true;
  }

  // Persist as soon as the channel is known. If posting the notice fails, the
  // ID is still recoverable on the next restart or /setuptrap invocation.
  await saveTrapChannel(guild.id, channel.id);

  if (created) {
    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle("🚫 JANGAN KIRIM PESAN DI CHANNEL INI")
      .setDescription(
        "**DO NOT SEND MESSAGES IN THIS CHANNEL**\n\n" +
        "Saluran ini digunakan untuk menangkap spam bot.\n\n" +
        "⚠️ Setiap pesan yang dikirim di sini akan mengakibatkan timeout otomatis.\n" +
        "📩 Bot akan mengirim DM alasan dan durasi timeout jika memungkinkan.\n\n" +
        "⚠️ Pesan pertama: timeout 1 hari. Jika mengulangi: timeout 7 hari. Tidak ada ban otomatis.",
      )
      .setFooter({ text: "Anti-spam trap • RapStore Assistant" });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  return { channel, created };
}

function ensureTrapChannel(guild, excludedChannelId = null) {
  const guildId = String(guild.id);
  const inFlight = ensureInFlight.get(guildId);
  if (inFlight) {
    // A deletion event can race with startup recovery. If the in-flight work
    // resolves to the channel that was just deleted, run recovery again after
    // the current lock has been released.
    if (excludedChannelId) {
      return inFlight.then(result =>
        String(result.channel.id) === String(excludedChannelId)
          ? ensureTrapChannel(guild, excludedChannelId)
          : result
      );
    }
    return inFlight;
  }

  const promise = ensureTrapChannelInternal(guild, excludedChannelId)
    .finally(() => {
      if (ensureInFlight.get(guildId) === promise) ensureInFlight.delete(guildId);
    });
  ensureInFlight.set(guildId, promise);
  return promise;
}

/**
 * Explicit command: reuse the saved channel (or exact-name legacy channel),
 * otherwise create one. Repeated calls are safe and do not create duplicates.
 */
export async function setupTrapChannel(guild) {
  const result = await ensureTrapChannel(guild);
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error("Bot perlu izin Moderate Members agar timeout trap berfungsi.");
  }
  return result;
}

/**
 * Startup recovery is opt-in: it restores only a previously saved trap ID and
 * does not adopt by name or create a trap on unconfigured servers.
 */
export async function restoreTrapChannel(guild) {
  if (!guild?.id) return null;
  const collection = getDatabase().collection("trap_channels");
  return restoreConfiguredTrapChannel(guild, { trapChannels: collection });
}

export async function restoreConfiguredTrapChannel(guild, { trapChannels, ensure = ensureTrapChannel } = {}) {
  if (!guild?.id || !trapChannels?.findOne) return null;
  const record = await trapChannels.findOne({ guildId: String(guild.id), enabled: { $ne: false } });
  if (!record?.channelId) return null;
  try {
    const result = await ensure(guild);
    console.log(
      "[trap-chat] Restored trap channel for guild " + guild.id + ": " +
      result.channel.id + (result.created ? " (recreated)" : ""),
    );
    return result;
  } catch (error) {
    // Keep the saved intent in MongoDB so a later restart can retry recovery.
    console.error("[trap-chat] Could not restore trap channel for guild " + guild.id + ":", error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * If the configured channel is deleted while the bot is online, immediately
 * create a replacement. If Discord permissions prevent this, the persistent
 * record remains intact and startup recovery can retry later.
 */
export async function handleTrapChannelDelete(channel, client) {
  const guildId = String(channel?.guildId || channel?.guild?.id || "");
  if (!guildId || !channel?.id) return false;

  const collection = getDatabase().collection("trap_channels");
  const record = await collection.findOne({
    guildId,
    channelId: String(channel.id),
    enabled: { $ne: false },
  });
  if (!record) return false;

  trapChannelIds.delete(guildId);
  const guild = channel.guild || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error("[trap-chat] Trap channel was deleted, but its guild is unavailable. Startup recovery will retry.");
    return true;
  }

  try {
    const result = await ensureTrapChannel(guild, String(channel.id));
    console.warn("[trap-chat] Configured trap channel was deleted; replacement created:", result.channel.id);
  } catch (error) {
    console.error("[trap-chat] Trap channel was deleted and automatic recovery failed. The saved configuration is retained:", error instanceof Error ? error.message : error);
  }
  return true;
}

async function getConfiguredTrapChannelId(guildId) {
  const key = String(guildId);
  if (trapChannelIds.has(key)) return trapChannelIds.get(key);

  const record = await getDatabase().collection("trap_channels").findOne(
    { guildId: key, enabled: { $ne: false } },
    { projection: { channelId: 1 } },
  );
  const channelId = record?.channelId ? String(record.channelId) : null;
  trapChannelIds.set(key, channelId);
  return channelId;
}

function withStrikeQueue(key, operation) {
  const previous = strikeQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  strikeQueues.set(key, current);

  return previous.catch(() => {}).then(operation).finally(() => {
    release();
    if (strikeQueues.get(key) === current) strikeQueues.delete(key);
  });
}

function returnedDocument(result) {
  return result?.value ?? result;
}

async function incrementStrikeCount(collection, guildId, userId, now) {
  const key = { guildId: String(guildId), userId: String(userId) };
  const counterId = "trap-strike:" + key.guildId + ":" + key.userId;
  const existing = await collection.findOne({ counterId }, { projection: { _id: 1 } });
  let legacyCount = 0;
  if (!existing) {
    // Preserve the highest count from pre-counter records without deleting or
    // rewriting them. The sparse unique counterId index protects concurrent
    // first writes while leaving all legacy rows intact.
    const legacy = await collection.findOne(key, { sort: { count: -1 }, projection: { count: 1 } });
    const candidate = Number(legacy?.count || 0);
    if (Number.isSafeInteger(candidate) && candidate > 0) legacyCount = candidate;
  }

  const filter = { counterId };
  const update = {
    $inc: { count: 1 },
    $set: { guildId: key.guildId, userId: key.userId, lastAt: now },
    $setOnInsert: { counterId, legacyCount, firstAt: now },
  };
  let result;
  try {
    result = await collection.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" });
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    // A simultaneous first upsert won the sparse unique index race; apply this
    // message's increment to the row it created rather than retrying an insert.
    result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after" });
  }

  const document = returnedDocument(result);
  const count = Number(document?.legacyCount || 0) + Number(document?.count || 0);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("MongoDB returned an invalid trap strike count.");
  return { counterId, count };
}

export async function applyTrapStrike(message, { collection, logger = console } = {}) {
  if (!collection || !message?.guildId || !message?.author?.id || !message?.member) {
    return { ok: false, reason: "invalid-input" };
  }

  const key = String(message.guildId) + ":" + String(message.author.id);
  return withStrikeQueue(key, async () => {
    const now = new Date();
    let strike;
    try {
      strike = await incrementStrikeCount(collection, message.guildId, message.author.id, now);
    } catch (error) {
      logger.error("[trap-chat] MongoDB strike reservation failed; Discord timeout was not attempted:", error instanceof Error ? error.message : error);
      return { ok: false, reason: "database" };
    }

    const durationMs = strike.count === 1 ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const until = new Date(now.getTime() + durationMs);
    try {
      await message.member.timeout(durationMs, "Mengirim pesan di channel anti-spam trap");
    } catch (error) {
      logger.error("[trap-chat] Discord timeout application failed:", error instanceof Error ? error.message : error);
      try {
        await collection.updateOne({ counterId: strike.counterId }, { $inc: { count: -1 }, $set: { lastTimeoutFailureAt: new Date() } });
      } catch (rollbackError) {
        logger.error("[trap-chat] MongoDB strike rollback failed after Discord timeout failure:", rollbackError instanceof Error ? rollbackError.message : rollbackError);
      }
      return { ok: false, reason: "timeout" };
    }

    try {
      await collection.updateOne({ counterId: strike.counterId }, { $set: { lastTimeoutUntil: until } });
    } catch (error) {
      logger.error("[trap-chat] Discord timeout succeeded, but MongoDB metadata update failed:", error instanceof Error ? error.message : error);
    }
    return { ok: true, count: strike.count, durationMs, until };
  });
}

export async function handleTrapMessage(message) {
  if (!message.guild || message.author.bot || !message.member || message.webhookId) return false;

  const trapChannelId = await getConfiguredTrapChannelId(message.guildId);
  if (!isTrapChannelMessage(message, trapChannelId)) return false;

  if (
    message.member.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    message.member.permissions.has(PermissionFlagsBits.ManageMessages)
  ) return false;

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await message.channel.send({
      content: "⚠️ Anti-spam trap mendeteksi pesan, tetapi bot tidak memiliki izin Moderate Members. Timeout tidak diterapkan.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const result = await applyTrapStrike(message, { collection: getDatabase().collection("trap_strikes") });
  if (!result.ok) {
    await message.channel.send({
      content: result.reason === "database"
        ? "⚠️ Gagal mencatat pelanggaran ke database. Timeout tidak dicoba; beri tahu staff server."
        : "⚠️ Gagal menerapkan timeout. Pastikan role bot berada di atas role pengguna dan bot memiliki izin Moderate Members.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  try {
    await message.author.send(
      "⚠️ Lu terkena timeout di server **" + message.guild.name +
      "** karena mengirim pesan di channel anti-spam trap.\nDurasi: **" +
      (result.count === 1 ? "1 hari" : "7 hari") +
      "**.\nIni bukan ban; hubungi staff server jika menurut lu terjadi kesalahan.",
    );
  } catch {}
  await message.channel.send({
    content: "⚠️ <@" + message.author.id + "> dikenai timeout **" +
      (result.count === 1 ? "1 hari" : "7 hari") + "**. " +
      (result.count > 1 ? "Pelanggaran berulang." : "Pelanggaran pertama."),
    allowedMentions: { users: [message.author.id] },
  });
  return true;
}
