import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";

const TRAP_CHANNEL_NAME = "🚫・trap-chat";

export async function setupTrapChannel(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !guild.members.me?.permissions.has(PermissionFlagsBits.SendMessages) ||
      !guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error("Bot perlu izin Manage Channels, Send Messages, dan Moderate Members.");
  }
  const existing = guild.channels.cache.find(channel => channel.type === ChannelType.GuildText && channel.name === TRAP_CHANNEL_NAME);
  if (existing) return { channel: existing, created: false };

  const channel = await guild.channels.create({
    name: TRAP_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: "Anti-spam trap: pesan di channel ini akan menghasilkan timeout otomatis.",
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
    reason: "/setuptrap anti-spam trap channel",
  });
  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle("🚫 JANGAN KIRIM PESAN DI CHANNEL INI")
    .setDescription("**DO NOT SEND MESSAGES IN THIS CHANNEL**\n\nSaluran ini digunakan untuk menangkap spam bot.\n\n⚠️ Setiap pesan yang dikirim di sini akan mengakibatkan timeout otomatis.\n📩 Bot akan mengirim DM alasan dan durasi timeout jika memungkinkan.\n\n⚠️ Pesan pertama: timeout 1 hari. Jika mengulangi: timeout 7 hari. Tidak ada ban otomatis.")
    .setFooter({ text: "Anti-spam trap • RapStore Assistant" });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return { channel, created: true };
}

export async function handleTrapMessage(message) {
  if (!message.guild || message.author.bot || !message.member || message.webhookId) return false;
  if (!message.channel?.name?.toLowerCase().includes("trap")) return false;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator) ||
      message.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const strikes = message.client ? null : null;
  const db = (await import("./database.js")).getDatabase();
  const collection = db.collection("trap_strikes");
  const key = { guildId: message.guildId, userId: message.author.id };
  const previous = await collection.findOne(key);
  const count = (previous?.count || 0) + 1;
  const durationMs = count === 1 ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const until = new Date(Date.now() + durationMs);

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await message.channel.send({ content: "⚠️ Anti-spam trap mendeteksi pesan, tetapi bot tidak memiliki izin Moderate Members. Timeout tidak diterapkan.", allowedMentions: { parse: [] } });
    return true;
  }
  try {
    await message.member.timeout(durationMs, "Mengirim pesan di channel anti-spam trap");
    await collection.updateOne(key, { $set: { count, lastAt: new Date(), lastTimeoutUntil: until }, $setOnInsert: { firstAt: new Date() } }, { upsert: true });
    try {
      await message.author.send("⚠️ Lu terkena timeout di server **" + message.guild.name + "** karena mengirim pesan di channel anti-spam trap.\nDurasi: **" + (count === 1 ? "1 hari" : "7 hari") + "**.\nIni bukan ban; hubungi staff server jika menurut lu terjadi kesalahan.");
    } catch {}
    await message.channel.send({ content: "⚠️ <@" + message.author.id + "> dikenai timeout **" + (count === 1 ? "1 hari" : "7 hari") + "**. " + (count > 1 ? "Pelanggaran berulang." : "Pelanggaran pertama.") , allowedMentions: { users: [message.author.id] } });
    return true;
  } catch (error) {
    console.error("[trap-chat]", error instanceof Error ? error.message : error);
    await message.channel.send({ content: "⚠️ Gagal menerapkan timeout. Pastikan role bot berada di atas role pengguna dan bot memiliki izin Moderate Members.", allowedMentions: { parse: [] } });
    return true;
  }
}
