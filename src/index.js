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
import { refreshGlobalCommands } from "./global-commands.js";
import { buildMessage, buildComponentsOnly, buildPanel } from "./ui.js";
import { isStaffMember, canAccessTicket, canManuallyCloseTicket } from "./security.js";
import { reconcileMissingTicket } from "./ticket-recovery.js";
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
function v2SendPayload(content) { return buildMessage(content); }
function logError(context, error) { console.error(`[${context}]`, error instanceof Error ? error.message : "Unknown error"); }
function hasStaffRole(member) {
  return isStaffMember(member, [config.ids.founderRole, config.ids.adminRole]);
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
  if (emoji.id) return "<" + (emoji.animated ? "a" : "") + ":" + emoji.name + ":" + emoji.id + ">";
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
      if (display.emoji) option.emoji = display.emoji;
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

async function upsertPersistentPanel(interaction, type, payload) {
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  const db = getDatabase();
  const collection = db.collection("persistent_panels");
  let record = await collection.findOne({ guildId: interaction.guildId, type });
  let message = null;
  if (record) {
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (channel) message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (message) await message.edit(payload);
  }
  if (!message) {
    if (!interaction.channel || typeof interaction.channel.send !== "function") {
      await interaction.editReply(v2Payload({ content: "Jalankan command ini di channel teks server agar panel publik bisa dibuat.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    message = await interaction.channel.send(payload);
    const panelUpdate = { guildId: interaction.guildId, type, channelId: message.channelId, messageId: message.id, updatedAt: new Date() };
    if (type === "catalog") Object.assign(panelUpdate, { selectedCategory: "", selectedProductId: "" });
    await collection.updateOne({ guildId: interaction.guildId, type }, { $set: panelUpdate }, { upsert: true });
  } else {
    const panelUpdate = { updatedAt: new Date() };
    if (type === "catalog") Object.assign(panelUpdate, { selectedCategory: "", selectedProductId: "" });
    await collection.updateOne({ guildId: interaction.guildId, type }, { $set: panelUpdate });
  }
  await interaction.editReply(v2Payload({
    content: type === "catalog" ? "Katalog publik berhasil disinkronkan." : "Panel katalog publik berhasil disinkronkan.",
    flags: EPHEMERAL | MessageFlags.IsComponentsV2,
  }));
}

async function showFounderPanel(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Panel hanya untuk Founder/Admin.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  // The management panel must never be posted publicly. Keep it ephemeral to the staff member.
  await interaction.reply({
    ...buildFounderPanelPayload(),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function refreshPersistentPanels(readyClient, onlyType = null) {
  const db = getDatabase();
  const filter = onlyType ? { type: onlyType } : {};
  const records = await db.collection("persistent_panels").find(filter).toArray();
  for (const record of records) {
    try {
      // Remove old public management panels left by versions that exposed /panel.
      if (record.type === "panel") {
        const oldChannel = await readyClient.channels.fetch(record.channelId).catch(() => null);
        if (!oldChannel?.messages) {
          console.error("[persistent-panel] Cannot access legacy public panel channel; keeping cleanup record to retry.");
          continue;
        }
        const oldMessage = await oldChannel.messages.fetch(record.messageId).catch(() => null);
        if (oldMessage) {
          try {
            await oldMessage.delete();
          } catch (error) {
            logError("legacy-public-panel-delete", error);
            console.error("[persistent-panel] Could not delete legacy public panel; keeping cleanup record to retry.");
            continue;
          }
        }
        await db.collection("persistent_panels").deleteOne({ _id: record._id });
        console.log("[persistent-panel] Removed legacy public management panel; /panel is now ephemeral.");
        continue;
      }
      const payload = record.type === "catalog"
        ? await buildCatalogPayload(record.selectedCategory || "", record.selectedProductId || "")
        : null;
      if (!payload) continue;
      const channel = await readyClient.channels.fetch(record.channelId).catch(() => null);
      if (!channel || typeof channel.send !== "function") { console.error("[persistent-panel] Saved channel unavailable for " + record.type); continue; }
      let message = await channel.messages.fetch(record.messageId).catch(() => null);
      if (message) {
        await message.edit(payload);
      } else {
        message = await channel.send(payload);
        await db.collection("persistent_panels").updateOne({ _id: record._id }, { $set: { messageId: message.id, channelId: message.channelId, updatedAt: new Date() } });
      }
    } catch (error) { logError("persistent-panel-sync-" + record.type, error); }
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
    if (display.emoji) option.emoji = display.emoji;
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
      if (emoji) option.emoji = emoji;
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
    const {ObjectId}=await import("mongodb");
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
    const {ObjectId}=await import("mongodb");
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
    const cached = categoryPickerCache.get(interaction.user.id + ":" + mode + ":" + interaction.values[0]);
    const category = cached || (await getProductCategories()).find(item => item.name === name);
    await interaction.showModal(buildCategoryModal("edit",{name,emoji:category?.emoji||""}));
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
  const {ObjectId} = await import("mongodb");
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
    const {ObjectId} = await import("mongodb");
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
  const {ObjectId} = await import("mongodb");
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
  const category = categories.includes(selectedCategory) ? selectedCategory : "";
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
        lines.push("<:alur:1553800809198649344> **Harga:** `" + formatPrice(retail).replace(/^Rp\s*/, "Rp") + "`", "");
      }
    }
  }

  const panel = buildPanel("");
  panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("### 🛍️ RAPSTORE — CATALOG"));
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
      if (display.emoji) option.emoji = display.emoji;
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
    if (emoji) option.emoji = emoji;
    return option;
  });
  if (productOptions.length) productMenu.addOptions(productOptions);
  else productMenu.addOptions([{
    label: category ? "Tidak ada produk" : "Pilih kategori dulu",
    value: "none",
    description: "Pilih kategori untuk melihat produk yang tersedia",
  }]).setDisabled(true);

  const ticketMenu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:catalog:ticket")
    .setPlaceholder("Pilih Tujuan Tiket")
    .setMinValues(1).setMaxValues(1)
    .addOptions([
      {
        label: "ORDER SEKARANG",
        value: selectedProduct ? ("order_now:" + String(selectedProduct._id)) : "order_now",
        description: "Buat tiket untuk melakukan pemesanan",
      },
      {
        label: "TANYA-TANYA DULU",
        value: selectedProduct ? ("product_question:" + String(selectedProduct._id)) : "product_question",
        description: "Buat tiket untuk bertanya sebelum memesan",
      },
    ]);

  panel.addActionRowComponents(new ActionRowBuilder().addComponents(categoryMenu));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(productMenu));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(ticketMenu));
  return { flags: MessageFlags.IsComponentsV2, components: [panel] };
}

async function handleCatalogSelection(interaction) {
  await interaction.deferUpdate();
  const db = getDatabase();
  const panels = db.collection("persistent_panels");
  if (interaction.customId === "rapstore:catalog:category") {
    const category = safeText(interaction.values[0], 80);
    await panels.updateOne({ guildId: interaction.guildId, type: "catalog" }, { $set: { selectedCategory: category, selectedProductId: "", updatedAt: new Date() } });
    await interaction.message.edit(await buildCatalogPayload(category, ""));
    return;
  }
  if (interaction.customId === "rapstore:catalog:product") {
    const id = interaction.values[0];
    if (id === "none") {
      await interaction.followUp(v2Payload({ content: "Pilih kategori terlebih dahulu, lalu pilih produk.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    if (!ObjectId.isValid(id)) {
      await interaction.followUp(v2Payload({ content: "Produk tidak valid. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const product = await db.collection("products").findOne({ _id: new ObjectId(id), active: true });
    if (!product) {
      await interaction.followUp(v2Payload({ content: "Produk tidak ditemukan atau sudah tidak aktif. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const category = safeText(product.category || "Umum", 80);
    await panels.updateOne({ guildId: interaction.guildId, type: "catalog" }, { $set: { selectedCategory: category, selectedProductId: id, updatedAt: new Date() } });
    await interaction.message.edit(await buildCatalogPayload(category, id));
    return;
  }
  if (interaction.customId === "rapstore:catalog:ticket") {
    const [ticketType, selectedProductId] = String(interaction.values[0] || "").split(":");
    if (!["order_now", "product_question"].includes(ticketType)) {
      await interaction.followUp(v2Payload({ content: "Tujuan tiket tidak valid. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    if (!interaction.inGuild()) {
      await interaction.followUp(v2Payload({ content: "Tiket hanya bisa dibuat di server Discord.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const { ObjectId } = await import("mongodb");
    let selectedProduct = null;
    if (selectedProductId) {
      if (!ObjectId.isValid(selectedProductId)) {
        await interaction.followUp(v2Payload({ content: "Produk tidak valid. Pilih produk dari katalog lalu coba lagi.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
        return;
      }
      selectedProduct = await db.collection("products").findOne({ _id: new ObjectId(selectedProductId), active: true });
      if (!selectedProduct) {
        await interaction.followUp(v2Payload({ content: "Produk sudah tidak tersedia. Perbarui katalog lalu coba lagi.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
        return;
      }
    }
    const reservations = db.collection("ticket_reservations");
    const reservationTime = new Date();
    await reservations.deleteMany({ createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } });
    try {
      await reservations.insertOne({ guildId: interaction.guildId, buyerId: interaction.user.id, interactionId: interaction.id, createdAt: reservationTime });
    } catch (error) {
      if (error?.code === 11000) {
        await interaction.followUp(v2Payload({ content: "Permintaan tiket lu sedang diproses. Tunggu sebentar lalu cek daftar tiket sebelum mencoba lagi.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
        return;
      }
      throw error;
    }
    let progressMessage = null;
    const reportProgress = async (title, body) => {
      const payload = { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [buildPanel(title, body)] };
      if (progressMessage) await interaction.webhook.editMessage(progressMessage.id, payload);
      else progressMessage = await interaction.followUp({ ...payload, fetchReply: true });
    };
    try {
      await reportProgress("TIKET SEDANG DIBUAT", "Permintaan lu sedang diproses. Tunggu sebentar ya — jangan klik dropdown berulang kali.");
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
      const isOrder = ticketType === "order_now";
      const ticketNumber = await allocateTicketNumber(isOrder ? "order" : "question");
      const ticketCode = await allocateTicketCode();
      const channel = await interaction.guild.channels.create({
        name: ticketNumber.channelName, type: ChannelType.GuildText, parent: config.ids.supportCategory || undefined,
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
          ticketNumber: ticketNumber.number, ticketPrefix: isOrder ? "rap" : "tanya", ticketCode,
          productId: selectedProduct ? String(selectedProduct._id) : null, productName: selectedProduct ? safeText(selectedProduct.name, 100) : null,
          status: "open", createdAt: new Date(),
        });
        if (isOrder) {
          await initializeOrderTicket({ channel, interaction, ticketNumber: ticketNumber.number, ticketId: ticketInsert.insertedId, ticketCode, selectedProduct });
        } else {
          const productLine = selectedProduct ? "\nProduk yang dipilih: **" + safeText(selectedProduct.name, 100) + "**" : "\nProduk belum dipilih dari katalog.";
          const intro = "Halo <@" + interaction.user.id + ">! Silakan tulis pertanyaan produk lu di sini.";
          const ticketWelcome = buildPanel("RAPSTORE — TANYA-TANYA DULU", intro + productLine + "\n\nJangan kirim password atau data sensitif.");
          ticketWelcome.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("rapstore:ticket:close").setLabel("Tutup Tiket").setStyle(ButtonStyle.Danger)));
          await channel.send({ flags: MessageFlags.IsComponentsV2, components: [ticketWelcome] });
        }
      } catch (error) {
        await db.collection("tickets").deleteOne({ channelId: channel.id }).catch(() => {});
        await db.collection("orders").deleteMany({ channelId: channel.id, status: "ON HOLD" }).catch(() => {});
        await channel.delete("Failed to initialize catalog ticket").catch(() => {});
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

async function handleInteraction(interaction) {
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
      (interaction.customId.startsWith("rapstore:order:") || interaction.customId.startsWith("rapstore:payment:") || interaction.customId.startsWith("rapstore:vouch:"))) {
    await handleOrderInteraction(interaction, client); return;
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
  if (interaction.commandName === "catalog") {
    if (!interaction.inGuild()) { await interaction.reply(v2Payload({ content: "Katalog publik hanya bisa dibuat di channel server.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
    if (!hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({ content: "Command /catalog hanya untuk Founder/Admin. Member cukup menggunakan pesan katalog publik yang sudah tersedia.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
    await upsertPersistentPanel(interaction, "catalog", await buildCatalogPayload());
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
      }).catch(() => {});
      console.warn("[tickets] Unexpectedly deleted open ticket channel; records preserved and cleanup metadata updated:", channel.id);
    })().catch(error => logError("ticket-channel-delete-cleanup", error));
  });
  client.on(Events.MessageCreate, message => {
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
    await refreshGlobalCommands({ guildIds: [...readyClient.guilds.cache.keys()] });
  } catch (error) {
    logError("global-command-refresh", error);
    console.error("Bot tetap berjalan, tetapi refresh global slash commands atau pembersihan command guild lama belum selesai. Periksa izin aplikasi bot dan jalankan npm run commands:refresh lagi.");
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
