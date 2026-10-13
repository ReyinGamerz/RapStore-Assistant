import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getDatabase } from "./database.js";

const TRAP_CHANNEL_NAME = "🚫・trap-chat";
const trapChannelIds = new Map();
const ensureInFlight = new Map();

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

async function findNamedTrapChannel(guild, excludedChannelId = null) {
  const matches = channel => (
    isTextChannelForGuild(channel, guild.id) &&
    channel.id !== excludedChannelId &&
    channel.name === TRAP_CHANNEL_NAME
  );

  const cached = guild.channels.cache.find(matches);
  if (cached) return cached;

  // Fetch the complete channel list so startup recovery does not depend on
  // whether the target channel happened to be in cache.
  const channels = await guild.channels.fetch();
  return channels.find(matches) || null;
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

  // Prefer the persisted ID. Renaming the channel does not disable the trap.
  let channel = record?.channelId && String(record.channelId) !== String(excludedChannelId || "")
    ? await findChannelById(guild, record.channelId)
    : null;
  if (!channel) channel = await findNamedTrapChannel(guild, excludedChannelId);

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
 * Startup recovery is opt-in: it restores a previously saved trap, or adopts
 * an exact-name channel from older versions. It does not create a trap on
 * servers where the feature was never configured.
 */
export async function restoreTrapChannel(guild) {
  if (!guild?.id) return null;
  const collection = getDatabase().collection("trap_channels");
  const record = await collection.findOne({ guildId: String(guild.id), enabled: { $ne: false } });
  if (!record) {
    const legacyChannel = await findNamedTrapChannel(guild);
    if (!legacyChannel) return null;
  }

  try {
    const result = await ensureTrapChannel(guild);
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

export async function handleTrapMessage(message) {
  if (!message.guild || message.author.bot || !message.member || message.webhookId) return false;

  const trapChannelId = await getConfiguredTrapChannelId(message.guildId);
  if (!isTrapChannelMessage(message, trapChannelId)) return false;

  if (
    message.member.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    message.member.permissions.has(PermissionFlagsBits.ManageMessages)
  ) return false;

  const db = getDatabase();
  const collection = db.collection("trap_strikes");
  const key = { guildId: message.guildId, userId: message.author.id };
  const previous = await collection.findOne(key);
  const count = (previous?.count || 0) + 1;
  const durationMs = count === 1 ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const until = new Date(Date.now() + durationMs);

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await message.channel.send({
      content: "⚠️ Anti-spam trap mendeteksi pesan, tetapi bot tidak memiliki izin Moderate Members. Timeout tidak diterapkan.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  try {
    await message.member.timeout(durationMs, "Mengirim pesan di channel anti-spam trap");
    await collection.updateOne(
      key,
      {
        $set: { count, lastAt: new Date(), lastTimeoutUntil: until },
        $setOnInsert: { firstAt: new Date() },
      },
      { upsert: true },
    );
    try {
      await message.author.send(
        "⚠️ Lu terkena timeout di server **" + message.guild.name +
        "** karena mengirim pesan di channel anti-spam trap.\nDurasi: **" +
        (count === 1 ? "1 hari" : "7 hari") +
        "**.\nIni bukan ban; hubungi staff server jika menurut lu terjadi kesalahan.",
      );
    } catch {}
    await message.channel.send({
      content: "⚠️ <@" + message.author.id + "> dikenai timeout **" +
        (count === 1 ? "1 hari" : "7 hari") + "**. " +
        (count > 1 ? "Pelanggaran berulang." : "Pelanggaran pertama."),
      allowedMentions: { users: [message.author.id] },
    });
    return true;
  } catch (error) {
    console.error("[trap-chat]", error instanceof Error ? error.message : error);
    await message.channel.send({
      content: "⚠️ Gagal menerapkan timeout. Pastikan role bot berada di atas role pengguna dan bot memiliki izin Moderate Members.",
      allowedMentions: { parse: [] },
    });
    return true;
  }
}
