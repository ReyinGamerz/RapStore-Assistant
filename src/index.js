import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events,
  GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, SeparatorBuilder, TextDisplayBuilder, TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { config } from "./config.js";
import { connectDatabase, closeDatabase, getDatabase } from "./database.js";
import { refreshGuildCommands } from "./global-commands.js";
import { buildMessage, buildComponentsOnly, buildPanel } from "./ui.js";
import { isStaffMember, canAccessTicket, canManuallyCloseTicket } from "./security.js";
import { reconcileMissingTicket } from "./ticket-recovery.js";
import { wrapCategoryIndex } from "./catalog-state.js";
import { extractSingleEmojiFile, extractEmojiFilesFromZip } from "./emoji-import.js";
import { setupServer } from "./setup-server.js";
import { setupTrapChannel, handleTrapMessage } from "./trap-chat.js";
import { allocateTicketNumber, initializeOrderTicket, handleOrderInteraction, handleOrderMessage, archiveAndDeleteTicket, startOrderMaintenance } from "./order-system.js";

let client;
let shuttingDown = false;
let stopOrderMaintenance;
const EPHEMERAL = MessageFlags.Ephemeral;
const productPickerCache = new Map();
const categoryPickerCache = new Map();

function v2Payload(payload) {
  const flags = payload?.flags ?? 0;
  return buildMessage(payload?.content ?? "", { ephemeral: Boolean(flags & MessageFlags.Ephemeral) });
}
function v2EditPayload(content) { return buildComponentsOnly(content); }
function logError(context, error) { console.error(`[${context}]`, error instanceof Error ? error.message : "Unknown error"); }
async function fetchChannelOrNull(discordClient, channelId) {
  try {
    return await discordClient.channels.fetch(channelId);
  } catch (error) {
    if (Number(error?.code) === 10003) return null;
    throw error;
  }
}
async function fetchMessageOrNull(channel, messageId) {
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if ([10003, 10008].includes(Number(error?.code))) return null;
    throw error;
  }
}
function hasStaffRole(member) {
  return isStaffMember(member, [config.ids.founderRole, config.ids.adminRole]);
}
function hasFounderRole(member) {
  return Boolean(member?.roles?.cache?.has(config.ids.founderRole));
}
function configuredPanelChannelId(type) {
  return type === "catalog" ? config.channels.catalog : config.channels.adminPanel;
}
async function audit(action, interaction, details = {}) {
  try { await getDatabase().collection("audit_logs").insertOne({ action, actorId: interaction.user.id, guildId: interaction.guildId, details, createdAt: new Date() }); }
  catch (error) { logError("audit", error); }
}
function safeText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
async function allocateTicketCode() {
  const db = getDatabase();
  const tickets = db.collection("tickets");
  const orders = db.collection("orders");
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "#$&";
  for (let attempt = 0; attempt < 30; attempt++) {
    const length = 5 + (randomBytes(1)[0] % 6);
    const bytes = randomBytes(length);
    let code = "";
    for (const byte of bytes) {
      const kind = byte % 10;
      const pool = kind < 8 ? letters : kind === 8 ? digits : symbols;
      code += pool[randomBytes(1)[0] % pool.length];
    }
    const [ticketExists, orderExists] = await Promise.all([
      tickets.findOne({ ticketCode: code }, { projection: { _id: 1 } }),
      orders.findOne({ $or: [{ ticketCode: code }, { orderCode: code }] }, { projection: { _id: 1 } }),
    ]);
    if (!ticketExists && !orderExists) return code;
  }
  throw new Error("Gagal membuat ID tiket unik setelah beberapa percobaan.");
}
function buildCategoryModal(action, current = null) {
  const reference = current ? (current._id ? "id-" + String(current._id) : "name-" + encodeCategory(current.name)) : "";
  const modal=new ModalBuilder().setCustomId("rapstore:panelmodal:category:"+action+(current?":"+reference:"")).setTitle(action==="add"?"Tambah Kategori":"Edit Kategori");
  const name=new TextInputBuilder().setCustomId("nama_kategori").setLabel("Nama kategori").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  if(current?.name) name.setValue(current.name);
  const emoji=new TextInputBuilder().setCustomId("emoji_kategori").setLabel("Emoji kategori (opsional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);
  if(current?.emoji) emoji.setValue(current.emoji);
  modal.addComponents(new ActionRowBuilder().addComponents(name),new ActionRowBuilder().addComponents(emoji));
  return modal;
}
async function getProductCategories() {
  const [saved, values] = await Promise.all([
    getDatabase().collection("categories").find({}).sort({name:1}).toArray(),
    getDatabase().collection("products").distinct("category")
  ]);
  const map = new Map();
  for (const item of saved) if (item.name) map.set(safeText(item.name,80), safeText(item.emoji || "",100));
  for (const value of values) if (value) { const name=safeText(value,80); if (!map.has(name)) map.set(name,""); }
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(0,25).map(([name,emoji])=>({name,emoji}));
}
function parseDiscordEmoji(value) {
  const text = safeText(value, 100);
  const match = text.match(/^<(a?):([a-zA-Z0-9_]{2,32}):(\d{17,20})>$/);
  if (match) return { name: match[2], id: match[3], animated: match[1] === "a" };
  if (text && !text.includes("<") && !text.includes(">")) return { name: text };
  return null;
}
function categoryDisplay(category) {
  const rawName = safeText(category?.name, 80);
  const match = rawName.match(/^(<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>)\s*(.*)$/);
  return { name: match && match[2] ? match[2] : rawName, emoji: parseDiscordEmoji(category?.emoji) || (match ? parseDiscordEmoji(match[1]) : null) };
}
function renderEmoji(emoji) {
  if (!emoji) return "";
  if (emoji.id) {
    const guild = client?.guilds?.cache?.get(config.guildId);
    if (!guild?.emojis?.cache?.has(emoji.id)) return "";
    return "<" + (emoji.animated ? "a" : "") + ":" + emoji.name + ":" + emoji.id + ">";
  }
  return emoji.name || "";
}
async function findCanonicalCategory(name) {
  const wanted = safeText(name, 80).toLocaleLowerCase("id-ID");
  if (!wanted) return null;
  if (wanted === "umum") return "Umum";
  const saved = await getDatabase().collection("categories").find({}).project({name:1}).toArray();
  const fromSaved = saved.find(item => safeText(item.name,80).toLocaleLowerCase("id-ID") === wanted);
  if (fromSaved) return safeText(fromSaved.name,80);
  const values = await getDatabase().collection("products").distinct("category");
  const fromProducts = values.find(value => typeof value === "string" && safeText(value,80).toLocaleLowerCase("id-ID") === wanted);
  return fromProducts ? safeText(fromProducts,80) : null;
}
async function ensureCategoryRecord(name, emoji = "") {
  const collection = getDatabase().collection("categories");
  let record = await collection.findOne({ name });
  if (!record) {
    const result = await collection.insertOne({ name, emoji, createdAt: new Date(), migrated: true });
    record = await collection.findOne({ _id: result.insertedId });
  } else if (!record.emoji && emoji) {
    await collection.updateOne({ _id: record._id }, { $set: { emoji, updatedAt: new Date() } });
    record.emoji = emoji;
  }
  return record;
}
async function synchronizeCategoryData() {
  const db = getDatabase();
  const categories = db.collection("categories");
  const products = db.collection("products");
  let normalizedCategories = 0;
  let normalizedProducts = 0;
  const savedCategories = await categories.find({}).toArray();
  for (const record of savedCategories) {
    const display = categoryDisplay(record);
    if (display.name === record.name) continue;
    const cleanName = display.name;
    const emojiText = record.emoji || renderEmoji(display.emoji);
    const existing = await categories.findOne({ name: cleanName, _id: { $ne: record._id } });
    if (existing) {
      if (!existing.emoji && emojiText) await categories.updateOne({ _id: existing._id }, { $set: { emoji: emojiText, updatedAt: new Date() } });
      await products.updateMany({ category: record.name }, { $set: { category: cleanName, categoryEmoji: emojiText, updatedAt: new Date() } });
      await categories.deleteOne({ _id: record._id });
    } else {
      await categories.updateOne({ _id: record._id }, { $set: { name: cleanName, emoji: emojiText, updatedAt: new Date() } });
      await products.updateMany({ category: record.name }, { $set: { category: cleanName, categoryEmoji: emojiText, updatedAt: new Date() } });
    }
    normalizedCategories++;
  }
  const productCategories = await products.distinct("category");
  for (const rawName of productCategories) {
    if (typeof rawName !== "string") continue;
    const display = categoryDisplay({ name: rawName });
    if (display.name === rawName || !display.emoji) continue;
    const emojiText = renderEmoji(display.emoji);
    await products.updateMany({ category: rawName }, { $set: { category: display.name, categoryEmoji: emojiText, updatedAt: new Date() } });
    const existing = await categories.findOne({ name: display.name });
    if (existing) {
      if (!existing.emoji) await categories.updateOne({ _id: existing._id }, { $set: { emoji: emojiText, updatedAt: new Date() } });
    } else {
      await categories.insertOne({ name: display.name, emoji: emojiText, createdAt: new Date(), migrated: true });
    }
    normalizedProducts++;
  }
  if (normalizedCategories || normalizedProducts) console.log("[database] Category sync complete: " + normalizedCategories + " category records, " + normalizedProducts + " product category values normalized.");
}
function encodeCategory(category) { return Buffer.from(category, "utf8").toString("base64url"); }
function decodeCategory(encoded) { try { return Buffer.from(encoded, "base64url").toString("utf8"); } catch { return ""; } }
async function showCategoryPicker(interaction, mode, productId = "", responseMode = "reply") {
  const categories = await getProductCategories();
  if (!categories.length) {
    const payload = v2Payload({content:"Belum ada kategori. Tambahkan kategori terlebih dahulu sebelum membuat produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2});
    if (responseMode === "editReply") await interaction.editReply(payload);
    else if (responseMode === "followUp") await interaction.followUp(payload);
    else await interaction.reply(payload);
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:panelchoose:" + mode + (productId ? ":" + productId : ""))
    .setPlaceholder("Pilih kategori")
    .setMinValues(1).setMaxValues(1)
    .addOptions(categories.map(category => {
      const display = categoryDisplay(category);
      const option = { label: display.name.slice(0, 100), value: encodeCategory(category.name), description: "Gunakan kategori ini" };
      if (display.emoji && (!display.emoji.id || client?.guilds?.cache?.get(config.guildId)?.emojis?.cache?.has(display.emoji.id))) option.emoji = display.emoji;
      return option;
    }));
  const panel = buildPanel("PILIH KATEGORI", "Pilih kategori yang sudah ada. Untuk membuat atau mengganti nama kategori, gunakan tombol kategori di panel utama.");
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  const payload = { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] };
  if (responseMode === "editReply") await interaction.editReply(payload);
  else if (responseMode === "followUp") await interaction.followUp(payload);
  else await interaction.reply(payload);
}
function buildProductModal(action, category, product = null) {
  const suffix = product ? ":" + String(product._id) : "";
  const categoryToken = action === "add" && category ? ":" + encodeCategory(category) : "";
  const modal = new ModalBuilder().setCustomId("rapstore:panelmodal:" + action + suffix + categoryToken).setTitle(action === "add" ? "Tambah Produk" : "Edit Produk");
  const specs = [
    ["nama", "Nama produk", TextInputStyle.Short, true, 100, product?.name || ""],
    ["harga", "Harga (Rupiah)", TextInputStyle.Short, true, 12, product ? String(product.price) : ""],
    ["emoji_produk", "Emoji produk (opsional)", TextInputStyle.Short, false, 100, product?.emoji || ""],
  ];
  if (action === "edit") specs.push(["kategori", "Kategori (nama kategori yang sudah ada)", TextInputStyle.Short, true, 80, product?.category || category || "Umum"]);
  specs.push(["deskripsi", "Deskripsi", TextInputStyle.Paragraph, false, 500, product?.description || ""]);
  for (const [id, label, style, required, max, value] of specs) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value !== undefined && value !== null && String(value).length) input.setValue(String(value).slice(0, max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}
function buildFounderPanelPayload() {
  const panel = buildPanel("RAPSTORE — PANEL KATALOG", "Kelola kategori dan produk. Penghapusan membutuhkan konfirmasi.");
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:addcategory").setLabel("Add Kategori").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:editcategory").setLabel("Edit Kategori").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:deletecategory").setLabel("Hapus Kategori").setStyle(ButtonStyle.Danger)
  ));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:add").setLabel("Tambah Produk").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:edit").setLabel("Edit Produk").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:delete").setLabel("Hapus Produk").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rapstore:panel:list").setLabel("Daftar Produk").setStyle(ButtonStyle.Secondary)
  ));
  return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

async function ensurePersistentPanel(guildId, type, channelId, payload) {
  const channel = await fetchChannelOrNull(client, channelId);
  if (!channel || typeof channel.send !== "function" || channel.guildId !== guildId) {
    throw new Error("Channel tujuan " + channelId + " tidak tersedia atau bukan milik server ini.");
  }

  const collection = getDatabase().collection("persistent_panels");
  const record = await collection.findOne({ guildId, type });
  let message = null;
  if (record) {
    if (record.channelId === channelId) {
      message = await fetchMessageOrNull(channel, record.messageId);
    } else {
      const oldChannel = await fetchChannelOrNull(client, record.channelId);
      if (oldChannel?.messages) {
        const oldMessage = await fetchMessageOrNull(oldChannel, record.messageId);
        if (oldMessage) await oldMessage.delete().catch(error => logError("old-" + type + "-panel-delete", error));
      }
    }
  }

  if (message) await message.edit(payload);
  else message = await channel.send(payload);

  const panelUpdate = {
    guildId,
    type,
    channelId: message.channelId,
    messageId: message.id,
    updatedAt: new Date(),
  };
  if (type === "catalog") {
    panelUpdate.selectedCategory = record?.selectedCategory || "";
    panelUpdate.selectedProductId = record?.selectedProductId || "";
  }
  await collection.updateOne({ guildId, type }, { $set: panelUpdate }, { upsert: true });
  return message;
}

async function upsertPersistentPanel(interaction, type, payload) {
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  try {
    await ensurePersistentPanel(interaction.guildId, type, configuredPanelChannelId(type), payload);
    await interaction.editReply(v2Payload({
      content: type === "catalog"
        ? "Katalog publik disinkronkan di channel katalog."
        : "Panel publik disinkronkan di channel panel admin.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
  } catch (error) {
    logError("panel-upsert-" + type, error);
    await interaction.editReply(v2Payload({
      content: "Panel tidak bisa diperbarui. Pastikan channel tujuan tersedia dan bot memiliki izin melihat channel serta mengirim/mengelola pesan.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
  }
}

async function showFounderPanel(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Panel hanya untuk Founder/Admin.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  await upsertPersistentPanel(interaction, "panel", buildFounderPanelPayload());
}

async function handleAddEmojiCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(v2Payload({ content: "Command ini hanya bisa digunakan di server Discord.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  if (!hasFounderRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Command /addemoji hanya untuk Founder.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  if (Number(attachment.size || 0) > 20 * 1024 * 1024) {
    await interaction.reply(v2Payload({ content: "File maksimal 20 MiB. Untuk ZIP, setiap gambar emoji harus maksimal 256 KiB.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error("Gagal mengunduh lampiran dari Discord.");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 20 * 1024 * 1024) throw new Error("File maksimal 20 MiB.");

    const filename = String(attachment.name || "emoji");
    let files;
    let skipped = [];
    if (/\.zip$/i.test(filename)) {
      const result = extractEmojiFilesFromZip(data);
      files = result.files;
      skipped = result.skipped;
    } else {
      files = extractSingleEmojiFile(filename, data);
    }

    const existingNames = new Set(interaction.guild.emojis.cache.map(emoji => emoji.name));
    const added = [];
    const failed = [];
    const uploadDelayMs = 2500;
    let uploadAttempts = 0;
    for (const file of files) {
      if (existingNames.has(file.name)) {
        skipped.push(file.filename + ": nama emoji " + file.name + " sudah digunakan");
        continue;
      }
      // Keep uploads 2.5 seconds apart; honor Discord's retry_after if a 429 occurs.
      if (uploadAttempts > 0) {
        await new Promise(resolve => setTimeout(resolve, uploadDelayMs));
      }
      uploadAttempts++;
      const createEmoji = () => interaction.guild.emojis.create({
        attachment: file.data,
        name: file.name,
        reason: "Emoji import requested by Founder " + interaction.user.id,
      });
      try {
        try {
          await createEmoji();
        } catch (error) {
          const retryAfter = Number(error?.retry_after ?? error?.rawError?.retry_after ?? error?.data?.retry_after);
          const isRateLimited = Number(error?.status) === 429 || Number(error?.httpStatus) === 429 || Number(error?.statusCode) === 429;
          if (!isRateLimited || !Number.isFinite(retryAfter) || retryAfter <= 0) throw error;
          const waitMs = Math.ceil(retryAfter * 1000) + 250;
          console.warn("[addemoji] Discord rate limit for " + file.name + "; waiting " + waitMs + "ms before one retry.");
          await new Promise(resolve => setTimeout(resolve, waitMs));
          await createEmoji();
        }
        existingNames.add(file.name);
        added.push(file.name);
      } catch (error) {
        const code = error?.code ? " (kode " + error.code + ")" : "";
        failed.push(file.filename + " [" + file.name + "]: " + String(error?.message || "gagal ditambahkan").slice(0, 160) + code);
      }
      // Keep the deferred interaction visibly alive and show progress during large ZIP imports.
      const processed = added.length + failed.length;
      if (processed > 0 && processed % 5 === 0) {
        await interaction.editReply({
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [buildPanel(
            "IMPORT EMOJI BERLANGSUNG",
            "File terbaca: **" + files.length + "**\nSudah diproses: **" + processed + "/" + files.length + "**\nBerhasil: **" + added.length + "** | Gagal: **" + failed.length + "** | Dilewati: **" + skipped.length + "**\nMohon tunggu, upload masih berjalan."
          )],
        });
      }
    }

    const summarize = (label, items) => {
      if (!items.length) return [];
      const detailLimit = 18;
      const details = items.slice(0, detailLimit).map(item => String(item));
      if (items.length > detailLimit) details.push("…dan " + (items.length - detailLimit) + " lainnya");
      return ["", label + " (" + items.length + "):", ...details];
    };
    const lines = [
      "File terbaca: **" + files.length + "** | Berhasil: **" + added.length + "**",
      "Dilewati: **" + skipped.length + "** | Gagal: **" + failed.length + "**",
    ];
    lines.push(...summarize("Emoji berhasil", added.map(name => ":" + name + ":")));
    lines.push(...summarize("Gagal", failed));
    lines.push(...summarize("Dilewati", skipped));
    let report = lines.join("\n");
    if (report.length > 3900) report = report.slice(0, 3850) + "\n…Laporan dipotong karena batas tampilan Discord.";
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [buildPanel("HASIL IMPORT EMOJI", report)] });
  } catch (error) {
    logError("founder-add-emoji", error);
    await interaction.editReply(v2Payload({
      content: String(error?.message || "Import emoji gagal.").slice(0, 1800),
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
  }
}

async function handleRemoveEmojiCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(v2Payload({ content: "Command ini hanya bisa digunakan di server Discord.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  if (!hasFounderRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Command /removeemoji hanya untuk Founder.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  const mode = interaction.options.getString("mode", true);
  const emojis = [...interaction.guild.emojis.cache.values()];
  if (!emojis.length) {
    await interaction.reply(v2Payload({ content: "Server ini belum memiliki emoji yang bisa dihapus.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  if (mode === "pilih") {
    // Discord select menus allow at most 25 options each and five action rows per message.
    const chunks = [];
    for (let offset = 0; offset < emojis.length; offset += 25) {
      chunks.push(emojis.slice(offset, offset + 25));
    }
    if (chunks.length > 5) {
      await interaction.reply(v2Payload({
        content: "Server memiliki terlalu banyak emoji untuk ditampilkan sekaligus. Maksimal 125 pilihan per panel; gunakan kembali /removeemoji setelah menghapus sebagian emoji.",
        flags: EPHEMERAL | MessageFlags.IsComponentsV2,
      }));
      return;
    }
    const panel = buildPanel("HAPUS EMOJI", "Pilih satu emoji dari dropdown. Setiap dropdown menampilkan maksimal 25 emoji; dropdown tambahan dibuat otomatis untuk sisanya. Penghapusan tidak bisa dibatalkan.");
    for (let index = 0; index < chunks.length; index++) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("rapstore:emoji:remove:select:" + index)
        .setPlaceholder("Pilih emoji " + (index * 25 + 1) + "–" + (index * 25 + chunks[index].length))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(chunks[index].map(emoji => ({
          label: (emoji.name || "emoji").slice(0, 100),
          value: emoji.id,
          description: emoji.animated ? "GIF animasi" : "Emoji statis",
          emoji: { id: emoji.id },
        })));
      panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    }
    await interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
    return;
  }
  if (mode === "semua") {
    const panel = buildPanel("KONFIRMASI HAPUS SEMUA EMOJI",
      "⚠️ Kamu akan menghapus **" + emojis.length + " emoji** dari server ini. Tindakan ini tidak bisa dibatalkan.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:emoji:remove:all:confirm").setLabel("Ya, hapus semua").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rapstore:emoji:remove:all:cancel").setLabel("Batalkan").setStyle(ButtonStyle.Secondary),
    ));
    await interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
  }
}

async function handleRemoveEmojiComponent(interaction) {
  if (!interaction.inGuild() || !hasFounderRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Fitur ini hanya untuk Founder.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rapstore:emoji:remove:select:")) {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const emoji = await interaction.guild.emojis.fetch(interaction.values[0]).catch(() => null);
    if (!emoji) {
      await interaction.editReply(v2Payload({ content: "Emoji tidak ditemukan atau sudah dihapus.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    try {
      await emoji.delete("Emoji removal requested by Founder " + interaction.user.id);
      await interaction.editReply(v2Payload({ content: "Emoji **:" + safeText(emoji.name || "emoji", 80) + ":** berhasil dihapus.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    } catch (error) {
      logError("founder-remove-emoji-single", error);
      await interaction.editReply(v2Payload({ content: "Gagal menghapus emoji. Emoji terkelola mungkin tidak dapat dihapus, atau bot tidak memiliki izin Manage Expressions.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    }
    return;
  }
  if (!interaction.isButton() || !interaction.customId.startsWith("rapstore:emoji:remove:all:")) return;
  if (interaction.customId.endsWith(":cancel")) {
    await interaction.update({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [buildPanel("DIBATALKAN", "Tidak ada emoji yang dihapus.")] });
    return;
  }
  // Replace the confirmation controls immediately so the destructive action cannot be clicked repeatedly.
  await interaction.update({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [buildPanel("SEDANG MENGHAPUS EMOJI", "⏳ Penghapusan sedang berjalan. Tombol konfirmasi sudah dinonaktifkan; mohon tunggu sampai hasilnya muncul.")],
  });
  const emojis = [...interaction.guild.emojis.cache.values()];
  let deleted = 0;
  const failed = [];
  for (const emoji of emojis) {
    try {
      await emoji.delete("Bulk emoji removal requested by Founder " + interaction.user.id);
      deleted++;
    } catch (error) {
      failed.push((emoji.name || emoji.id) + ": " + String(error?.message || "gagal").slice(0, 100));
    }
  }
  const lines = ["Berhasil dihapus: **" + deleted + "**"];
  if (failed.length) lines.push("Gagal: **" + failed.length + "**", failed.slice(0, 12).join("; ").slice(0, 1500));
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [buildPanel("HASIL HAPUS EMOJI", lines.join("\\n"))] });
}

async function refreshPersistentPanels(readyClient, onlyType = null) {
  const db = getDatabase();
  const types = onlyType ? [onlyType] : ["catalog", "panel"];
  const guild = readyClient.guilds.cache.get(config.guildId) || await readyClient.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error("[persistent-panel-startup-sync] Configured GUILD_ID " + config.guildId + " is not available to this bot; skipping panel sync.");
    return;
  }
  for (const type of types) {
      try {
        const channelId = configuredPanelChannelId(type);
        const record = await db.collection("persistent_panels").findOne({ guildId: guild.id, type });
        const payload = type === "catalog"
          ? await buildCatalogPayload(record?.selectedCategory || "")
          : buildFounderPanelPayload();
        await ensurePersistentPanel(guild.id, type, channelId, payload);
      } catch (error) {
        logError("persistent-panel-startup-sync-" + type + "-" + guild.id, error);
      }
    }

  if (!onlyType) {
    const legacyPanels = await db.collection("catalog_user_panels").find({}).toArray();
    for (const record of legacyPanels) {
      try {
        const channel = await fetchChannelOrNull(readyClient, record.channelId);
        if (channel?.messages) {
          const message = await fetchMessageOrNull(channel, record.messageId);
          if (message && message.author?.id === readyClient.user?.id) await message.delete();
        }
      } catch (error) {
        logError("legacy-user-catalog-panel-cleanup", error);
      }
    }
    await db.collection("catalog_user_panels").deleteMany({});
  }
}

async function showCategoryManagePicker(interaction, mode) {
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  const categories = await getProductCategories();
  for (const category of categories) categoryPickerCache.set(interaction.user.id + ":" + mode + ":" + encodeCategory(category.name), category);
  while (categoryPickerCache.size > 500) categoryPickerCache.delete(categoryPickerCache.keys().next().value);
  const options = categories.slice(0,25).map(category => {
    const display = categoryDisplay(category);
    const option = { label: display.name.slice(0,100), value: encodeCategory(category.name), description: "Kategori: " + display.name };
    const emoji = display.emoji;
    const guild = client?.guilds?.cache?.get(config.guildId);
    if (emoji && (!emoji.id || guild?.emojis?.cache?.has(emoji.id))) option.emoji = emoji;
    return option;
  });
  if (!options.length) {
    await interaction.editReply(v2Payload({content:"Belum ada kategori.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const menu = new StringSelectMenuBuilder().setCustomId("rapstore:panelchoose:" + mode).setPlaceholder("Pilih kategori").setMinValues(1).setMaxValues(1).addOptions(options);
  const isEdit = mode === "editcategorymanage";
  const panel = buildPanel(isEdit ? "EDIT KATEGORI" : "HAPUS KATEGORI", isEdit ? "Pilih kategori untuk mengubah nama atau emoji." : "Pilih kategori yang akan dihapus. Semua produk di kategori tersebut ikut terhapus setelah konfirmasi.");
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  await interaction.editReply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
}
async function showProductPicker(interaction, mode) {
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  const products = await getDatabase().collection("products").find({}).sort({name:1}).limit(25).toArray();
  if (!products.length) {
    await interaction.editReply(v2Payload({content:"Belum ada produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  for (const product of products) productPickerCache.set(interaction.user.id + ":" + String(product._id), { product, createdAt: Date.now() });
  while (productPickerCache.size > 500) productPickerCache.delete(productPickerCache.keys().next().value);
  const menu = new StringSelectMenuBuilder().setCustomId("rapstore:panelchoose:" + mode).setPlaceholder("Pilih produk").setMinValues(1).setMaxValues(1)
    .addOptions(products.map(p => {
      const option = {label:safeText(p.name,100),value:String(p._id),description:(safeText(p.category||"Umum",80)+" • "+formatPrice(p.price)).slice(0,100)};
      const emoji = parseDiscordEmoji(p.emoji);
      if (emoji && (!emoji.id || client?.guilds?.cache?.get(config.guildId)?.emojis?.cache?.has(emoji.id))) option.emoji = emoji;
      return option;
    }));
  const isEdit = mode === "editproduct";
  const panel = buildPanel(isEdit ? "EDIT PRODUK" : "HAPUS PRODUK", isEdit ? "Pilih produk untuk langsung membuka formulir edit." : "Pilih produk yang akan dihapus.");
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  await interaction.editReply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
}
function buildDeleteConfirmation(title, body, confirmId, cancelId) {
  const panel = buildPanel(title, body);
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel("Ya, Hapus").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel("Batal").setStyle(ButtonStyle.Secondary)
  ));
  return {flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]};
}
async function handleFounderPanelButton(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[2];
  if (action === "addcategory") { await interaction.showModal(buildCategoryModal("add")); return; }
  if (action === "editcategory") { await showCategoryManagePicker(interaction, "editcategorymanage"); return; }
  if (action === "editcategoryselected" || action === "deletecategoryselected") {
    const id = parts[3] || "";
    if (!ObjectId.isValid(id)) { await interaction.reply(v2Payload({content:"Pilih kategori terlebih dahulu.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const record = await getDatabase().collection("categories").findOne({_id:new ObjectId(id)});
    if (!record) { await interaction.reply(v2Payload({content:"Kategori tidak ditemukan. Muat ulang panel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    if (action === "editcategoryselected") { await interaction.showModal(buildCategoryModal("edit",record)); return; }
    if (record.name.trim().toLocaleLowerCase("id-ID") === "umum") {
      await interaction.reply(v2Payload({content:"Kategori bawaan Umum tidak dapat dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return;
    }
    const count = await getDatabase().collection("products").countDocuments({category:record.name});
    await interaction.update(buildDeleteConfirmation("KONFIRMASI HAPUS KATEGORI", "Kategori **"+safeText(record.name,80)+"** akan dihapus bersama **"+count+" produk** di dalamnya. Tindakan ini tidak bisa dibatalkan.", "rapstore:panel:confirmdeletecategory:"+id, "rapstore:panel:canceldeletecategory"));
    return;
  }
  if (action === "editselected") {
    const id = parts[3] || "";
    if (!ObjectId.isValid(id)) { await interaction.reply(v2Payload({content:"Pilih produk terlebih dahulu.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const product = await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if (!product) { await interaction.reply(v2Payload({content:"Produk tidak ditemukan atau sudah dihapus. Muat ulang panel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    await interaction.showModal(buildProductModal("edit", product.category || "Umum", product));
    return;
  }
  if (action === "deleteselected") {
    const id = parts[3] || "";
    if (!ObjectId.isValid(id)) { await interaction.reply(v2Payload({content:"Pilih produk terlebih dahulu.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const product = await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if (!product) { await interaction.reply(v2Payload({content:"Produk tidak ditemukan atau sudah dihapus. Muat ulang panel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    await interaction.update(buildDeleteConfirmation("KONFIRMASI HAPUS PRODUK", "Produk **"+safeText(product.name,100)+"** akan dihapus dari katalog. Tindakan ini tidak bisa dibatalkan.", "rapstore:panel:confirmdeleteproduct:"+id, "rapstore:panel:canceldeleteproduct"));
    return;
  }
  if (action === "deletecategory") { await showCategoryManagePicker(interaction, "deletecategorymanage"); return; }
  if (action === "add") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    await showCategoryPicker(interaction, "addcategory", "", "editReply");
    return;
  }
  if (action === "edit") { await showProductPicker(interaction, "editproduct"); return; }
  if (action === "delete") { await showProductPicker(interaction, "deleteproduct"); return; }
  const db = getDatabase();
  if (action === "list") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const list = await db.collection("products").find({}).sort({name:1}).limit(25).toArray();
    const lines = list.map(p => "• " + safeText(p.name,80) + " [" + (p.active?"aktif":"nonaktif") + "]\nKategori: " + safeText(p.category||"Umum",80) + " • Harga " + formatPrice(p.price));
    await interaction.editReply(v2Payload({content:lines.join("\n\n").slice(0,3800)||"Belum ada produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  if (action === "confirmdeletecategory") {
    const categoryId = parts[3] || "";
    await interaction.deferUpdate();
    if (!ObjectId.isValid(categoryId)) { await interaction.editReply(v2Payload({content:"Kategori tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const categoryRecord = await db.collection("categories").findOne({_id:new ObjectId(categoryId)});
    if (!categoryRecord) { await interaction.editReply(v2Payload({content:"Kategori tidak ditemukan atau sudah dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const name = categoryRecord.name;
    if (name.trim().toLocaleLowerCase("id-ID") === "umum") {
      await interaction.editReply(v2Payload({content:"Kategori bawaan **Umum** tidak dapat dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const removedProducts = await db.collection("products").deleteMany({category:name});
    await db.collection("categories").deleteOne({_id:new ObjectId(categoryId)});
    await refreshPersistentPanels(client, "catalog");
    await audit("category.deleted",interaction,{category:name,deletedProducts:removedProducts.deletedCount});
    await interaction.editReply(v2Payload({content:"Kategori **"+name+"** dihapus beserta **"+removedProducts.deletedCount+" produk** di dalamnya.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  if (action === "confirmdeleteproduct") {
    const id = parts[3] || "";
    await interaction.deferUpdate();
    if (!ObjectId.isValid(id)) { await interaction.editReply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const product = await db.collection("products").findOne({_id:new ObjectId(id)});
    if (!product) { await interaction.editReply(v2Payload({content:"Produk tidak ditemukan atau sudah dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    await db.collection("products").deleteOne({_id:new ObjectId(id)});
    await refreshPersistentPanels(client, "catalog");
    await audit("product.deleted",interaction,{productId:id,productName:product.name,category:product.category||"Umum"});
    await interaction.editReply(v2Payload({content:"Produk **"+safeText(product.name,100)+"** berhasil dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  if (action === "canceldeletecategory" || action === "canceldeleteproduct") {
    await interaction.deferUpdate();
    await interaction.deleteReply();
  }
}
async function handleFounderPanelSelect(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const parts = interaction.customId.split(":");
  const mode = parts[2];
  if (mode === "editproductcategory") {
    const categoryName = decodeCategory(interaction.values[0]);
    const valid = (await getProductCategories()).some(item => item.name === categoryName);
    if (!valid) { await interaction.update(v2Payload({content:"Kategori tidak ditemukan. Muat ulang panel Edit Produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    await renderProductManagementPanel(interaction, categoryName, "", "update");
    return;
  }
  if (mode === "editproduct") {
    const categoryName = decodeCategory(parts[3] || "");
    const id = interaction.values[0];
    if (!ObjectId.isValid(id)) { await interaction.update(v2Payload({content:"Produk tidak valid. Pilih produk lain.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const product = await getDatabase().collection("products").findOne({_id:new ObjectId(id),category:categoryName});
    if (!product) { await interaction.update(v2Payload({content:"Produk sudah tidak tersedia di kategori ini. Pilih ulang.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    await renderProductManagementPanel(interaction, categoryName, id, "update");
    return;
  }
  if (mode === "addcategory") {
    const chosen = decodeCategory(interaction.values[0]);
    if (!chosen) {
      await interaction.reply(v2Payload({content:"Kategori tidak valid. Pilih ulang dari daftar kategori.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    await interaction.showModal(buildProductModal("add", chosen));
    return;
  }
  if (mode === "editcategorymanage") {
    const name = decodeCategory(interaction.values[0]);
    if (!name) { await interaction.update(v2Payload({content:"Kategori tidak valid. Muat ulang panel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const category = (await getProductCategories()).find(item => item.name === name);
    if (!category) { await interaction.update(v2Payload({content:"Kategori tidak ditemukan. Muat ulang panel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const record = await ensureCategoryRecord(name, category.emoji || "");
    const panel = buildPanel("EDIT KATEGORI", "Kategori dipilih: **"+safeText(name,80)+"**. Tekan Edit untuk mengubah nama/emoji, atau Hapus untuk menghapus kategori beserta produknya.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:panel:editcategoryselected:"+String(record._id)).setLabel("Edit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rapstore:panel:deletecategoryselected:"+String(record._id)).setLabel("Hapus").setStyle(ButtonStyle.Danger).setDisabled(name.trim().toLocaleLowerCase("id-ID") === "umum")
    ));
    await interaction.update({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
    return;
  }
  if (mode === "deletecategorymanage") {
    const name = decodeCategory(interaction.values[0]);
    if (!name) {
      await interaction.update(v2Payload({content:"Kategori tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    if (name.trim().toLocaleLowerCase("id-ID") === "umum") {
      await interaction.update(v2Payload({content:"Kategori bawaan **Umum** tidak dapat dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const category = (await getProductCategories()).find(item => item.name === name);
    const record = await ensureCategoryRecord(name, category?.emoji || "");
    const count = await getDatabase().collection("products").countDocuments({category:name});
    await interaction.update(buildDeleteConfirmation(
      "KONFIRMASI HAPUS KATEGORI",
      "Kategori **"+name+"** akan dihapus bersama **"+count+" produk** di dalamnya. Tindakan ini tidak bisa dibatalkan.",
      "rapstore:panel:confirmdeletecategory:"+String(record._id),
      "rapstore:panel:canceldeletecategory"
    ));
    return;
  }
  if (mode === "editproduct") {
    const id = interaction.values[0];
    if (!ObjectId.isValid(id)) {
      await interaction.reply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const cached = productPickerCache.get(interaction.user.id + ":" + id);
    let product = cached && Date.now() - cached.createdAt < 5 * 60 * 1000 ? cached.product : null;
    if (!product) product = await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if (!product) {
      await interaction.reply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    // A modal must be the initial response to this selection interaction.
    await interaction.showModal(buildProductModal("edit", product.category || "Umum", product));
    return;
  }
  if (mode === "deleteproduct") {
    const id = interaction.values[0];
    if (!ObjectId.isValid(id)) {
      await interaction.update(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const product = await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if (!product) {
      await interaction.update(v2Payload({content:"Produk tidak ditemukan atau sudah dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    await interaction.update(buildDeleteConfirmation(
      "KONFIRMASI HAPUS PRODUK",
      "Produk **"+safeText(product.name,100)+"** akan dihapus dari katalog. Tindakan ini tidak bisa dibatalkan.",
      "rapstore:panel:confirmdeleteproduct:"+id,
      "rapstore:panel:canceldeleteproduct"
    ));
    return;
  }
  await interaction.reply(v2Payload({content:"Pilihan panel tidak dikenal. Buka /panel lagi.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
}

async function handleFounderPanelModal(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  const db = getDatabase();
  const parts = interaction.customId.split(":");

  if (parts[2] === "category") {
    const categoryAction = parts[3];
    const name = safeText(interaction.fields.getTextInputValue("nama_kategori"),80);
    const emoji = safeText(interaction.fields.getTextInputValue("emoji_kategori") || "",100);
    if (!name) {
      await interaction.editReply(v2Payload({content:"Nama kategori wajib diisi.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const collection = db.collection("categories");
    if (categoryAction === "add") {
      if (await findCanonicalCategory(name)) {
        await interaction.editReply(v2Payload({content:"Kategori dengan nama tersebut sudah ada. Gunakan Edit Kategori jika ingin mengubahnya.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
        return;
      }
      await collection.insertOne({name,emoji,createdAt:new Date(),createdBy:interaction.user.id});
      await refreshPersistentPanels(client, "catalog");
      await audit("category.created",interaction,{category:name});
      await interaction.editReply(v2Payload({content:"Kategori **"+(emoji?emoji+" ":"")+name+"** berhasil dibuat.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }

    const reference = parts[4] || "";
    const isIdReference = reference.startsWith("id-") || ObjectId.isValid(reference);
    const idReference = reference.startsWith("id-") ? reference.slice(3) : reference;
    const encodedName = reference.startsWith("name-") ? reference.slice(5) : reference;
    const oldRecord = isIdReference && ObjectId.isValid(idReference)
      ? await collection.findOne({_id:new ObjectId(idReference)})
      : await collection.findOne({name:decodeCategory(encodedName)});
    const oldName = oldRecord?.name || (isIdReference ? "" : decodeCategory(encodedName));
    if (!oldName) {
      await interaction.editReply(v2Payload({content:"Kategori lama tidak ditemukan. Buka Edit Kategori lagi.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const canonical = await findCanonicalCategory(name);
    if (canonical && canonical.toLocaleLowerCase("id-ID") !== oldName.toLocaleLowerCase("id-ID")) {
      await interaction.editReply(v2Payload({content:"Nama kategori itu sudah digunakan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    await collection.updateOne({name:oldName},{$set:{name,emoji,updatedAt:new Date(),updatedBy:interaction.user.id}},{upsert:true});
    if (name !== oldName) {
      await db.collection("products").updateMany({category:oldName},{$set:{category:name,categoryEmoji:emoji,updatedAt:new Date()}});
    } else {
      await db.collection("products").updateMany({category:name},{$set:{categoryEmoji:emoji,updatedAt:new Date()}});
    }
    await refreshPersistentPanels(client, "catalog");
    await audit("category.updated",interaction,{oldName,name});
    await interaction.editReply(v2Payload({content:"Kategori berhasil diperbarui.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }

  const action = parts[2];
  if (action !== "add" && action !== "edit") return;
  const name = safeText(interaction.fields.getTextInputValue("nama"),100);
  const price = Number(interaction.fields.getTextInputValue("harga"));
  const description = safeText(interaction.fields.getTextInputValue("deskripsi") || "",500);
  const emoji = safeText(interaction.fields.getTextInputValue("emoji_produk") || "",100);

  let category;
  if (action === "add") {
    category = await findCanonicalCategory(decodeCategory(parts[3] || ""));
  } else {
    const requestedCategory = safeText(interaction.fields.getTextInputValue("kategori"),80);
    category = await findCanonicalCategory(requestedCategory);
    if (!category) {
      await interaction.editReply(v2Payload({content:"Kategori **"+requestedCategory+"** belum ada. Isi nama kategori yang sudah tersedia, atau buat dulu lewat Add Kategori.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
  }
  if (!name || !Number.isSafeInteger(price) || price < 1 || !category) {
    await interaction.editReply(v2Payload({content:"Nama dan kategori wajib valid. Harga harus berupa angka positif dan kategori harus sudah tersedia.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }

  if (action === "add") {
    const now = new Date();
    const result = await db.collection("products").insertOne({name,price,category,emoji,description,active:true,currency:"IDR",createdAt:now,updatedAt:now,createdBy:interaction.user.id});
    await refreshPersistentPanels(client, "catalog");
    await audit("product.created",interaction,{productId:String(result.insertedId),category,source:"panel"});
    await interaction.editReply(v2Payload({content:"Produk berhasil dibuat dalam kategori **"+category+"**. ID: "+result.insertedId,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }

  const id = parts[3] || "";
  if (!ObjectId.isValid(id)) {
    await interaction.editReply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const result = await db.collection("products").updateOne(
    {_id:new ObjectId(id)},
    {$set:{name,price,category,emoji,description,updatedAt:new Date(),updatedBy:interaction.user.id}}
  );
  if (!result.matchedCount) {
    await interaction.editReply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  await refreshPersistentPanels(client, "catalog");
  await audit("product.updated",interaction,{productId:id,category,source:"panel"});
  await interaction.editReply(v2Payload({content:"Produk berhasil diperbarui. Kategori sekarang: **"+category+"**.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
}

async function catalogData(db) {
  const products = db.collection("products");
  const categories = await products.distinct("category", { active: true });
  const legacyCount = await products.countDocuments({ active: true, $or: [{ category: { $exists: false } }, { category: null }, { category: "" }] });
  const normalized = [...new Set([...categories.map(category => safeText(category || "Umum", 80)), ...(legacyCount ? ["Umum"] : [])].filter(Boolean))].sort();
  return { categories: normalized, products };
}

async function buildCatalogPayload(selectedCategory = "", selectedProductId = "") {
  const db = getDatabase();
  const { categories, products } = await catalogData(db);
  const category = categories.includes(selectedCategory) ? selectedCategory : (categories[0] || "");
  const list = category
    ? await products.find(category === "Umum"
      ? { active: true, $or: [{ category: "Umum" }, { category: { $exists: false } }, { category: null }, { category: "" }] }
      : { active: true, category }).sort({ name: 1 }).limit(25).toArray()
    : [];
  const selectedProduct = selectedProductId ? list.find(p => String(p._id) === selectedProductId) : null;

  const lines = [];
  if (!category) {
    lines.push("Pilih kategori dari menu di bawah untuk melihat katalog produk.");
  } else {
    const categoryRecord = await db.collection("categories").findOne({ name: category });
    const categoryInfo = categoryDisplay({ name: category, emoji: categoryRecord?.emoji || list.find(p => p.categoryEmoji)?.categoryEmoji || "" });
    const renderedCategoryEmoji = renderEmoji(categoryInfo.emoji);
    const emojiText = renderedCategoryEmoji ? renderedCategoryEmoji + " " : "";
    lines.push("**Category:** " + emojiText + categoryInfo.name, "");
    if (!list.length) {
      lines.push("Belum ada produk aktif di kategori ini.");
    } else {
      for (const product of list) {
        const retail = Number(product.price || 0);
        const name = safeText(product.name, 100);
        const isServerBoost = /server\s*boost/i.test(name);
        const displayName = isServerBoost
          ? name.replace(/\b(\d+x)\b/g, "`$1`").replace(/\b(\d+)\s+Month\b/gi, "`$1` Month")
          : name;
        lines.push("**" + (safeText(product.emoji,100) ? safeText(product.emoji,100) + " " : "") + displayName + "**");
        lines.push("<:alur:1558458209977499740> **Harga:** `" + formatPrice(retail).replace(/^Rp\s*/, "Rp") + "`", "");
      }
    }
  }

  const panel = buildPanel("");
  panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("### <:rap5:1558864967812390952> RAPSTORE — CATALOG"));
  panel.addSeparatorComponents(new SeparatorBuilder());
  panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n").slice(0, 3900)));
  panel.addSeparatorComponents(new SeparatorBuilder());

  const categoryRecords = await getProductCategories();
  const categoryEmojiMap = new Map(categoryRecords.map(item => [item.name, item.emoji]));
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:catalog:category")
    .setPlaceholder(category ? ("Kategori: " + categoryDisplay({name:category,emoji:categoryEmojiMap.get(category)}).name).slice(0, 150) : "Pilih Kategori")
    .setMinValues(1).setMaxValues(1)
    .addOptions((categories.length ? categories : ["Belum ada kategori"]).slice(0, 25).map(c => {
      const display = categoryDisplay({name:c,emoji:categoryEmojiMap.get(c)});
      const option = { label: display.name.slice(0, 100), value: c, description: "Buka katalog kategori " + display.name, default: Boolean(category) && c === category };
      if (display.emoji && (!display.emoji.id || client?.guilds?.cache?.get(config.guildId)?.emojis?.cache?.has(display.emoji.id))) option.emoji = display.emoji;
      return option;
    }));
  if (!categories.length) categoryMenu.setDisabled(true);

  const productMenu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:catalog:product")
    .setPlaceholder(selectedProduct ? safeText(selectedProduct.name, 150) : "Pilih Produk")
    .setMinValues(1).setMaxValues(1);
  const productOptions = list.slice(0, 25).map(p => {
    const option = {
      label: safeText(p.name, 100),
      value: String(p._id),
      description: ("Lihat informasi produk • " + formatPrice(p.price)).slice(0, 100),
      default: Boolean(selectedProduct) && String(p._id) === String(selectedProduct._id),
    };
    const emoji = parseDiscordEmoji(p.emoji);
    if (emoji && (!emoji.id || client?.guilds?.cache?.get(config.guildId)?.emojis?.cache?.has(emoji.id))) option.emoji = emoji;
    return option;
  });
  if (productOptions.length) productMenu.addOptions(productOptions);
  else productMenu.addOptions([{
    label: category ? "Tidak ada produk" : "Pilih kategori dulu",
    value: "none",
    description: "Pilih kategori untuk melihat produk yang tersedia",
  }]).setDisabled(true);



  panel.addActionRowComponents(new ActionRowBuilder().addComponents(categoryMenu));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(productMenu));
  const categoryIndex = category ? categories.indexOf(category) : -1;
  const pageLabel = categories.length ? (Math.max(0, categoryIndex) + 1) + "/" + categories.length : "0/0";
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("rapstore:catalog:category-page:prev:" + Math.max(0, categoryIndex))
      .setLabel("PREV")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(categories.length <= 1),
    new ButtonBuilder()
      .setCustomId("rapstore:catalog:category-page:counter:" + Math.max(0, categoryIndex))
      .setLabel(pageLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("rapstore:catalog:category-page:next:" + Math.max(0, categoryIndex))
      .setLabel("NEXT")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(categories.length <= 1),
  ));
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [panel],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
}

async function persistCatalogSelection(interaction, selectedCategory, selectedProductId = "") {
  await getDatabase().collection("persistent_panels").updateOne(
    { guildId: interaction.guildId, type: "catalog" },
    { $set: { selectedCategory: safeText(selectedCategory, 80), selectedProductId: String(selectedProductId || ""), updatedAt: new Date() } },
  );
}

async function handleCatalogSelection(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(v2Payload({ content: "Katalog hanya bisa digunakan di server Discord.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }

  const db = getDatabase();
  const isCategory = interaction.customId === "rapstore:catalog:category";
  if (isCategory) {
    const requestedCategory = safeText(interaction.values[0], 80);
    const { categories } = await catalogData(db);
    const category = categories.includes(requestedCategory) ? requestedCategory : (categories[0] || "");
    await interaction.update(await buildCatalogPayload(category, ""));
    await persistCatalogSelection(interaction, category, "");
    return;
  }

  if (interaction.customId === "rapstore:catalog:product") {
    const id = String(interaction.values[0] || "");
    if (id === "none") {
      await interaction.reply(v2Payload({ content: "Pilih kategori terlebih dahulu, lalu pilih produk.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    if (!ObjectId.isValid(id)) {
      await interaction.reply(v2Payload({ content: "Produk tidak valid. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const product = await db.collection("products").findOne({ _id: new ObjectId(id), active: true });
    if (!product) {
      await interaction.reply(v2Payload({ content: "Produk tidak ditemukan atau sudah tidak aktif. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const category = safeText(product.category || "Umum", 80);
    const unitPrice = Number(product.price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) {
      await interaction.reply(v2Payload({ content: "Harga produk ini belum valid. Hubungi Founder/Admin agar harga diperbaiki sebelum memesan.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }

    await interaction.update(await buildCatalogPayload(category, id));
    await persistCatalogSelection(interaction, category, id);
    const confirmPanel = buildPanel(
      "KONFIRMASI PESANAN",
      "Lu memilih produk **" + safeText(product.name, 100) + "** dengan harga **" + formatPrice(product.price) + "**.\n\nLanjutkan untuk membuat tiket order, atau batalkan jika berubah pikiran.",
    );
    confirmPanel.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:catalog:order:confirm:" + id).setLabel("Ya, Lanjutkan").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rapstore:catalog:order:cancel:" + id).setLabel("Batalkan").setStyle(ButtonStyle.Secondary),
    ));
    await interaction.followUp({
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
      components: [confirmPanel],
      allowedMentions: { parse: [], users: [], roles: [] },
    });
  }
}

async function handleCatalogPageButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(v2Payload({ content: "Navigasi katalog hanya bisa digunakan di server Discord.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  const parts = String(interaction.customId || "").split(":");
  const action = parts[3] || "";
  const requestedIndex = Number(parts[4]);
  if (!["prev", "next"].includes(action)) {
    await interaction.reply(v2Payload({ content: "Navigasi kategori tidak valid. Buka ulang katalog lalu coba lagi.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }

  const { categories } = await catalogData(getDatabase());
  const saved = await getDatabase().collection("persistent_panels").findOne({
    guildId: interaction.guildId,
    type: "catalog",
    messageId: interaction.message.id,
  });
  const currentIndex = saved && categories.includes(saved.selectedCategory)
    ? categories.indexOf(saved.selectedCategory)
    : requestedIndex;
  const nextIndex = wrapCategoryIndex(currentIndex, action, categories.length);
  const category = nextIndex >= 0 ? categories[nextIndex] : "";
  await interaction.update(await buildCatalogPayload(category, ""));
  await persistCatalogSelection(interaction, category, "");
}

async function createCatalogOrderTicket(interaction, selectedProductId) {
  const db = getDatabase();
  if (!ObjectId.isValid(selectedProductId)) {
    await interaction.editReply(v2Payload({
      content: "Produk tidak valid atau sudah tidak tersedia. Buka katalog dan pilih produk lagi.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
    return;
  }
  const selectedProduct = await db.collection("products").findOne({ _id: new ObjectId(selectedProductId), active: true });
  if (!selectedProduct) {
    await interaction.editReply(v2Payload({
      content: "Produk sudah tidak tersedia. Buka katalog lalu pilih produk aktif lagi.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
    return;
  }
    const reservations = db.collection("ticket_reservations");
    const reservationTime = new Date();
    await reservations.deleteMany({ createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } });
    try {
      await reservations.insertOne({ guildId: interaction.guildId, buyerId: interaction.user.id, interactionId: interaction.id, createdAt: reservationTime });
    } catch (error) {
      if (error?.code === 11000) {
        await interaction.editReply(v2Payload({
          content: "Permintaan tiket lu sedang diproses. Tunggu sebentar lalu cek daftar tiket sebelum mencoba lagi.",
          flags: EPHEMERAL | MessageFlags.IsComponentsV2,
        }));
        return;
      }
      throw error;
    }
    let progressMessage = interaction.message || null;
    const reportProgress = async (title, body) => {
      const payload = { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [buildPanel(title, body)] };
      if (progressMessage) await interaction.editReply(payload);
      else progressMessage = await interaction.followUp({ ...payload, fetchReply: true });
    };
    try {
      await reportProgress("TIKET SEDANG DIBUAT", "Permintaan lu sedang diproses. Tunggu sebentar ya — jangan tekan tombol konfirmasi berulang kali.");
      const activeTickets = await db.collection("tickets").find({ guildId: interaction.guildId, buyerId: interaction.user.id, status: "open" }).toArray();
      let existing = null;
      for (const activeTicket of activeTickets) {
        let liveChannel;
        try { liveChannel = await interaction.guild.channels.fetch(activeTicket.channelId); }
        catch (error) { if (Number(error?.code) === 10003) liveChannel = null; else throw error; }
        if (liveChannel) { existing ||= activeTicket; continue; }
        await reconcileMissingTicket({
          db,
          guildId: interaction.guildId,
          activeTicket,
          actorId: interaction.user.id,
        });
      }
      if (existing) {
        await reportProgress("TIKET SUDAH ADA", "Lu sudah punya tiket yang masih terbuka: <#" + existing.channelId + ">. Selesaikan tiket itu sebelum membuat tiket baru.");
        return;
      }
      const ticketType = "order_now";
      const ticketNumber = await allocateTicketNumber("order");
      const ticketCode = await allocateTicketCode();
      const channel = await interaction.guild.channels.create({
        name: ticketNumber.channelName, type: ChannelType.GuildText, parent: config.ids.orderCategory || undefined,
        topic: "RapStore " + ticketType + "; ticket " + ticketCode + "; buyer " + interaction.user.id,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: config.ids.founderRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: config.ids.adminRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ],
      });
      try {
        const ticketInsert = await db.collection("tickets").insertOne({
          guildId: interaction.guildId, buyerId: interaction.user.id, channelId: channel.id, type: ticketType,
          ticketNumber: ticketNumber.number, ticketPrefix: "rap", ticketCode,
          productId: selectedProduct ? String(selectedProduct._id) : null, productName: selectedProduct ? safeText(selectedProduct.name, 100) : null,
          status: "open", createdAt: new Date(),
        });
        await initializeOrderTicket({ channel, interaction, ticketId: ticketInsert.insertedId, ticketCode, selectedProduct });
      } catch (error) {
        await db.collection("tickets").deleteOne({ channelId: channel.id }).catch(error => logError("ticket-create-rollback", error));
        await db.collection("orders").deleteMany({ channelId: channel.id, status: "ON HOLD" })
          .catch(error => logError("ticket-create-order-rollback", error));
        await channel.delete("Failed to initialize catalog ticket")
          .catch(error => logError("ticket-create-channel-rollback", error));
        throw error;
      }
      await reportProgress("TIKET BERHASIL DIBUAT", "✓ Tiket lu sudah siap: <#" + channel.id + ">.");
    } catch (error) {
      logError("ticket-create", error);
      await reportProgress("TIKET GAGAL DIBUAT", "Bot belum berhasil membuat tiket. Coba lagi beberapa saat; jika berulang, hubungi Founder/Admin.").catch(() => {});
    } finally {
      await reservations.deleteOne({ guildId: interaction.guildId, buyerId: interaction.user.id, interactionId: interaction.id }).catch(error => logError("ticket-reservation-release", error));
    }
}


function formatPrice(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID");
}

async function handleTicketButton(interaction) {
  if (!interaction.inGuild() || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply(v2Payload({content:"Tombol tiket hanya bisa digunakan di channel tiket server.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const db = getDatabase();
  const ticket = await db.collection("tickets").findOne({guildId:interaction.guildId,channelId:interaction.channelId,status:"open"});
  if (!ticket) {
    await interaction.reply(v2Payload({content:"Data tiket tidak ditemukan atau tiket sudah ditutup.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const staff = hasStaffRole(interaction.member);
  if (!canAccessTicket(ticket, interaction.user.id, staff)) {
    await interaction.reply(v2Payload({content:"Hanya pembuat tiket atau Founder/Admin yang dapat menutup tiket ini.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  const getOrderCloseBlock = async () => {
    const order = await db.collection("orders").findOne({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    if (canManuallyCloseTicket(order)) return "";
    if (order.status === "ON HOLD") {
      return "Pesanan masih **ON HOLD**. Batalkan pesanan melalui tombol **Batalkan Pesanan** terlebih dahulu; tiket tidak akan dihapus selama pesanan masih aktif.";
    }
    if (order.status === "PROSES") {
      return "Pesanan sedang **PROSES**. Selesaikan dengan **Tandai DONE** setelah pekerjaan selesai. Jika benar-benar harus membatalkan, Founder/Admin dapat menggunakan **!close** untuk membatalkan dan mengarsipkan pesanan secara eksplisit.";
    }
    if (order.status === "DONE") {
      return "Pesanan sudah **DONE**. Gunakan tombol **VOUCH** atau tunggu proses vouch otomatis; tiket tidak boleh dihapus sebelum alur vouch dan transcript selesai.";
    }
    return "Status pesanan belum aman untuk menutup tiket. Periksa pesanan bersama Founder/Admin.";
  };
  if (interaction.customId === "rapstore:ticket:close") {
    const closeBlock = await getOrderCloseBlock();
    if (closeBlock) {
      await interaction.reply(v2Payload({content:closeBlock,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const confirm = buildPanel("KONFIRMASI TUTUP TIKET","Yakin ingin menutup tiket ini? Channel akan dikunci dan ditandai sebagai selesai.");
    confirm.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:ticket:confirmclose").setLabel("Ya, Tutup Tiket").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rapstore:ticket:cancelclose").setLabel("Batal").setStyle(ButtonStyle.Secondary)
    ));
    await interaction.reply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[confirm]});
    return;
  }
  if (interaction.customId === "rapstore:ticket:cancelclose") {
    await interaction.deferUpdate();
    await interaction.deleteReply();
    return;
  }
  if (interaction.customId === "rapstore:ticket:confirmclose") {
    await interaction.deferUpdate();
    const freshTicket = await db.collection("tickets").findOne({guildId:interaction.guildId,channelId:interaction.channelId,status:"open"});
    if (!freshTicket) {
      await interaction.editReply(v2Payload({content:"Tiket sudah ditutup sebelumnya.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const closeBlock = await getOrderCloseBlock();
    if (closeBlock) {
      await interaction.editReply(v2Payload({content:closeBlock,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    try {
      await archiveAndDeleteTicket({
        channel: interaction.channel, ticket: freshTicket, client,
        closedBy: interaction.user.id, reason: "manual_ticket_close",
      });
      await interaction.followUp(v2Payload({content:"Tiket ditutup. Transcript HTML sudah disimpan dan channel tiket dihapus.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      await audit("ticket.closed",interaction,{ticketId:String(freshTicket._id),channelId:interaction.channelId,buyerId:freshTicket.buyerId});
    } catch (error) {
      logError("ticket-archive-delete", error);
      await interaction.followUp(v2Payload({content:"Tiket belum dihapus karena transcript gagal disimpan. Pastikan TRANSCRIPT_CHANNEL_ID sudah benar dan bot punya izin mengirim file serta menghapus channel.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    }
  }
}

async function handleCatalogOrderButton(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(v2Payload({
      content: "Konfirmasi order hanya bisa digunakan di server Discord.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
    return;
  }
  const parts = String(interaction.customId || "").split(":");
  const action = parts[3] || "";
  const productId = parts[4] || "";
  if (action === "cancel") {
    await interaction.deferUpdate();
    await interaction.deleteReply();
    return;
  }
  if (action !== "confirm" || !productId) {
    await interaction.reply(v2Payload({
      content: "Konfirmasi tidak valid. Pilih produk dari katalog lalu coba lagi.",
      flags: EPHEMERAL | MessageFlags.IsComponentsV2,
    }));
    return;
  }
  await interaction.deferUpdate();
  await createCatalogOrderTicket(interaction, productId);
}

async function handleSetupTrapCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Perintah ini hanya bisa digunakan di server Discord.", flags: MessageFlags.Ephemeral });
    return;
  }
  const member = interaction.member;
  const allowed = member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) || hasFounderRole(member);
  if (!allowed) {
    await interaction.reply({ content: "Hanya Founder/Admin server yang bisa menjalankan /setuptrap.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await setupTrapChannel(interaction.guild);
    await interaction.editReply({ content: (result.created ? "Channel trap berhasil dibuat: " : "Channel trap sudah ada: ") + "<#" + result.channel.id + ">\nTimeout otomatis: 1 hari untuk pelanggaran pertama, 7 hari jika mengulangi. Tidak ada ban otomatis." });
  } catch (error) {
    logError("setuptrap", error);
    await interaction.editReply({ content: "Gagal menyiapkan trap chat: " + String(error?.message || "error tidak diketahui").slice(0, 1200) });
  }
}

async function handleSetupServerCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Perintah ini hanya bisa digunakan di server Discord.", flags: MessageFlags.Ephemeral });
    return;
  }
  const member = interaction.member;
  const allowed = member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    hasFounderRole(member);
  if (!allowed) {
    await interaction.reply({ content: "Hanya Founder/Admin server yang punya izin Administrator atau Manage Server yang bisa menjalankan /setupserver.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.options.getBoolean("konfirmasi_hapus", true)) {
    await interaction.reply({ content: "Setup dibatalkan. Untuk melanjutkan, jalankan /setupserver dengan konfirmasi_hapus: true.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await setupServer(interaction.guild);
    await interaction.editReply({
      content: "Setup server selesai. Role yang diperiksa/dibuat: " + result.roles +
        "\nKategori dibuat: " + result.categories +
        "\nChannel dibuat: " + result.channels +
        "\n\nCatatan: semua channel/category sebelumnya dihapus. Periksa lagi permission dan role bot sebelum membuka server ke member.",
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logError("setupserver", error);
    await interaction.editReply({ content: "Setup server gagal: " + String(error?.message || "error tidak diketahui").slice(0, 1500) });
  }
}

async function handleBulkProductImport(interaction) {
  if (!interaction.inGuild() || !hasFounderRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Import produk massal hanya untuk Founder di server toko.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  const attachment = interaction.options.getAttachment("file", true);
  if (!/\.csv$/i.test(String(attachment.name || ""))) {
    await interaction.reply(v2Payload({ content: "Lampirkan file .csv. Kolom wajib: name,price,category. Kolom opsional: emoji,description.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  if (Number(attachment.size || 0) > 2 * 1024 * 1024) {
    await interaction.reply(v2Payload({ content: "File CSV maksimal 2 MiB.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error("Gagal mengunduh CSV dari Discord.");
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 2 * 1024 * 1024) throw new Error("File CSV maksimal 2 MiB.");
    const { parseProductCsv } = await import("./product-import.js");
    const parsed = parseProductCsv(raw.toString("utf8"));
    const db = getDatabase();
    const categoryMap = new Map((await getProductCategories()).map(item => [item.name.toLocaleLowerCase("id-ID"), item.name]));
    const unknown = [...new Set(parsed.map(item => item.category).filter(name => !categoryMap.has(name.toLocaleLowerCase("id-ID"))))];
    if (unknown.length) throw new Error("Kategori belum ada di database: " + unknown.join(", ") + ". Buat kategori lewat /panel terlebih dahulu. Tidak ada produk yang diimport.");
    for (const item of parsed) item.category = categoryMap.get(item.category.toLocaleLowerCase("id-ID"));
    const existing = await db.collection("products").find({}, { projection: { name: 1, category: 1 } }).toArray();
    const keys = new Set(existing.map(item => String(item.name || "").toLocaleLowerCase("id-ID") + "\u0000" + String(item.category || "").toLocaleLowerCase("id-ID")));
    const unique = [];
    let duplicates = 0;
    for (const item of parsed) {
      const key = item.name.toLocaleLowerCase("id-ID") + "\u0000" + item.category.toLocaleLowerCase("id-ID");
      if (keys.has(key)) { duplicates++; continue; }
      keys.add(key);
      unique.push(item);
    }
    if (!unique.length) {
      await interaction.editReply(v2Payload({ content: "Tidak ada produk baru untuk ditambahkan. Semua " + parsed.length + " baris sudah ada (duplikat dilewati).", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const now = new Date();
    const documents = unique.map(item => ({ ...item, active: true, currency: "IDR", createdAt: now, updatedAt: now, createdBy: interaction.user.id }));
    const result = await db.collection("products").insertMany(documents, { ordered: true });
    await refreshPersistentPanels(client, "catalog");
    await audit("products.bulk_imported", interaction, { inserted: result.insertedCount, duplicates, filename: safeText(attachment.name, 120) });
    await interaction.editReply(v2Payload({ content: "Import produk selesai.\nBerhasil ditambahkan: **" + result.insertedCount + "**\nDuplikat dilewati: **" + duplicates + "**\nTotal baris valid: **" + parsed.length + "**\nKatalog publik sudah disegarkan.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
  } catch (error) {
    logError("bulk-product-import", error);
    await interaction.editReply(v2Payload({ content: "Import dibatalkan: " + String(error?.message || "kesalahan tidak diketahui").slice(0, 1700) + "\nTidak ada produk yang ditambahkan jika validasi gagal.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
  }
}

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === "setupserver") {
    await handleSetupServerCommand(interaction); return;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === "setuptrap") {
    await handleSetupTrapCommand(interaction); return;
  }
  if (interaction.inGuild() && interaction.guildId !== config.guildId) {
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Bot ini hanya aktif di server toko yang dikonfigurasi.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
      (interaction.customId.startsWith("rapstore:order:") || interaction.customId.startsWith("rapstore:payment:") || interaction.customId.startsWith("rapstore:vouch:"))) {
    await handleOrderInteraction(interaction, client); return;
  }
  if ((interaction.isButton() && interaction.customId.startsWith("rapstore:emoji:remove:")) ||
      (interaction.isStringSelectMenu() && interaction.customId === "rapstore:emoji:remove:select")) {
    await handleRemoveEmojiComponent(interaction); return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:catalog:category-page:")) {
    await handleCatalogPageButton(interaction); return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:catalog:order:")) {
    await handleCatalogOrderButton(interaction); return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:ticket:")) {
    await handleTicketButton(interaction); return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:panel:")) {
    await handleFounderPanelButton(interaction); return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rapstore:panelchoose:")) {
    await handleFounderPanelSelect(interaction); return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("rapstore:panelmodal:")) {
    await handleFounderPanelModal(interaction); return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rapstore:catalog:")) {
    await handleCatalogSelection(interaction); return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "panel") { await showFounderPanel(interaction); return; }
  if (interaction.commandName === "importproduk") { await handleBulkProductImport(interaction); return; }
  if (interaction.commandName === "addemoji") { await handleAddEmojiCommand(interaction); return; }
  if (interaction.commandName === "removeemoji") { await handleRemoveEmojiCommand(interaction); return; }
  if (interaction.commandName === "catalog") {
    if (!interaction.inGuild()) { await interaction.reply(v2Payload({ content: "Katalog publik hanya bisa dibuat di channel server.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
    if (!hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({ content: "Command /catalog hanya untuk Founder/Admin. Member cukup menggunakan pesan katalog publik yang sudah tersedia.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
    const savedCatalog = await getDatabase().collection("persistent_panels").findOne({ guildId: interaction.guildId, type: "catalog" });
    await upsertPersistentPanel(interaction, "catalog", await buildCatalogPayload(savedCatalog?.selectedCategory || "", savedCatalog?.selectedProductId || ""));
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  try { await stopOrderMaintenance?.(); } catch (error) { logError("maintenance-shutdown", error); process.exitCode = 1; }
  client?.destroy();
  try { await closeDatabase(); } catch (error) { logError("shutdown", error); process.exitCode = 1; }
}

async function main() {
  await connectDatabase(config.mongoUri, config.mongoDbName);
  await synchronizeCategoryData();
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on(Events.InteractionCreate, interaction => {
    void handleInteraction(interaction).catch(async error => {
      const code = Number(error?.code);
      if (code === 10062 || error?.code === "Unknown interaction") {
        console.warn("[interaction] Interaction expired or was already acknowledged; ask the user to run /catalog again.");
        return;
      }
      logError("interaction", error);
      if (!interaction.isRepliable()) return;
      const message = "Terjadi kesalahan saat memproses permintaan. Coba lagi; jika berulang, hubungi Founder/Admin.";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(v2EditPayload(message));
        } else {
          await interaction.reply(v2Payload({ content: message, flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
        }
      } catch (replyError) {
        if (Number(replyError?.code) !== 10062 && replyError?.code !== "Unknown interaction") logError("interaction-error-response", replyError);
      }
    });
  });
  client.on(Events.GuildChannelDelete, channel => {
    void (async () => {
      const db = getDatabase();
      const guildId = channel.guild?.id || null;
      const filter = guildId
        ? { guildId, channelId: channel.id, status: "open" }
        : { channelId: channel.id, status: "open" };
      const tickets = await db.collection("tickets").find(filter).toArray();
      // Bot-driven archival marks the ticket as closing/closed before deleting the channel.
      // Only treat deletion of an open ticket as unexpected loss.
      if (!tickets.length) return;

      const now = new Date();
      await db.collection("tickets").updateMany(filter, {
        $set: {
          status: "deleted",
          closedAt: now,
          closeReason: "discord_channel_deleted",
          cleanupAt: now,
          transcriptStatus: "unavailable",
        },
      });
      const orderFilter = guildId ? { guildId, channelId: channel.id } : { channelId: channel.id };
      await db.collection("orders").updateMany(
        { ...orderFilter, status: "ON HOLD" },
        { $set: { status: "CANCELLED", paymentStatus: "cancelled", cancelledAt: now, cancelledBy: client.user.id, cancelReason: "ticket_channel_deleted", transcriptStatus: "unavailable", updatedAt: now } },
      );
      await db.collection("payment_proofs").updateMany(
        { ...orderFilter, status: "pending" },
        { $set: { status: "superseded", supersededAt: now, supersededReason: "ticket_channel_deleted", updatedAt: now }, $unset: { reviewSendingAt: "" } },
      );
      // Preserve paid/in-progress order states, but mark missing transcripts for manual review.
      await db.collection("orders").updateMany(
        { ...orderFilter, status: "PROSES", ticketClosedAt: { $exists: false } },
        { $set: { ticketCloseBlockedAt: now, ticketCloseBlockedReason: "channel_missing_before_archive", ticketChannelMissingAt: now, transcriptStatus: "unavailable", updatedAt: now }, $unset: { closeProcessingAt: "" } },
      );
      // Do not block a DONE order before maintenance has had a chance to publish its vouch.
      await db.collection("orders").updateMany(
        { ...orderFilter, status: "DONE", ticketClosedAt: { $exists: false } },
        { $set: { ticketChannelMissingAt: now, transcriptStatus: "unavailable", updatedAt: now }, $unset: { closeProcessingAt: "" } },
      );
      await db.collection("audit_logs").insertOne({
        action: "ticket.channel_deleted",
        actorId: null,
        guildId: guildId || tickets[0].guildId,
        details: { channelId: channel.id, ticketIds: tickets.map(ticket => String(ticket._id)), reason: "channel_deleted_in_discord", transcriptStatus: "unavailable" },
        createdAt: now,
      }).catch(error => console.error("[audit-log-write]", error?.message || error));
      console.warn("[tickets] Unexpectedly deleted open ticket channel; records preserved and cleanup metadata updated:", channel.id);
    })().catch(error => logError("ticket-channel-delete-cleanup", error));
  });
  client.on(Events.MessageCreate, message => {
    if (message.guildId !== config.guildId) return;
    void handleTrapMessage(message).catch(error => logError("trap-chat", error));
    void handleOrderMessage(message, client).catch(error => logError("order-message", error));
  });
  client.once(Events.ClientReady, readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}; MongoDB Atlas ready.`);
    void refreshPersistentPanels(readyClient).catch(error => logError("persistent-panel-startup-sync", error));
  });
  const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));
  await client.login(config.discordToken);
  const readyClient = client.isReady() ? client : await ready;
  stopOrderMaintenance = startOrderMaintenance(client);
  try {
    if (!readyClient.guilds.cache.has(config.guildId)) throw new Error("Bot tidak tergabung di GUILD_ID " + config.guildId);
    await refreshGuildCommands({ guildIds: [...readyClient.guilds.cache.keys()] });
  } catch (error) {
    logError("global-command-refresh", error);
    console.error("Bot tetap berjalan, tetapi refresh global slash commands belum selesai. Periksa izin aplikasi bot dan jalankan npm run commands:refresh lagi.");
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
main().catch(async error => {
  logError("startup", error);
  client?.destroy();
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
