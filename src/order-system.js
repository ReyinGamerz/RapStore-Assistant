import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { config } from "./config.js";
import { getDatabase } from "./database.js";
import { buildPanel } from "./ui.js";

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_AMOUNT = 25;

function clean(value, max = 150) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function price(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID");
}
function staff(member) {
  return Boolean(member?.roles?.cache?.has(config.ids.founderRole) || member?.roles?.cache?.has(config.ids.adminRole));
}
function v2(container, ephemeral = false) {
  return { flags: V2 | (ephemeral ? EPHEMERAL : 0), components: [container] };
}
async function replyNotice(interaction, title, body) {
  const panel = buildPanel(title, body);
  if (interaction.deferred || interaction.replied) return interaction.followUp(v2(panel, true));
  return interaction.reply(v2(panel, true));
}
function divider(container) {
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
}

async function allocateTicketNumber(kind) {
  const db = getDatabase();
  const counters = db.collection("counters");
  const key = kind === "order" ? "ticket:order" : "ticket:question";
  const initial = kind === "order" ? 0 : -1;
  try {
    await counters.updateOne({ _id: key }, { $setOnInsert: { sequence: initial, createdAt: new Date() } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  const result = await counters.findOneAndUpdate(
    { _id: key },
    { $inc: { sequence: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const counter = result?.value ?? result;
  if (!Number.isSafeInteger(counter?.sequence) || counter.sequence < 0) throw new Error("Ticket counter returned an invalid sequence.");
  const number = counter.sequence;
  return { number, channelName: (kind === "order" ? "rap-" : "tanya-") + number };
}

async function orderCategories() {
  const db = getDatabase();
  const values = await db.collection("products").distinct("category", { active: true });
  const legacyCount = await db.collection("products").countDocuments({
    active: true,
    $or: [{ category: { $exists: false } }, { category: null }, { category: "" }],
  });
  const names = values.map(value => clean(value || "Umum", 80)).filter(Boolean);
  if (legacyCount) names.push("Umum");
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "id"));
}
async function productsInCategory(category) {
  if (!category) return [];
  const filter = category === "Umum"
    ? { active: true, $or: [{ category: "Umum" }, { category: { $exists: false } }, { category: null }, { category: "" }] }
    : { active: true, category };
  return getDatabase().collection("products").find(filter).sort({ name: 1 }).limit(25).toArray();
}

function parseSelectEmoji(value) {
  const text = clean(value, 100);
  const match = text.match(/^<(a?):([a-zA-Z0-9_]{2,32}):(\d{17,20})>$/);
  if (match) return { name: match[2], id: match[3], animated: match[1] === "a" };
  if (text && !text.includes("<") && !text.includes(">")) return { name: text };
  return null;
}

async function categoryEmojiMap(names) {
  if (!names.length) return new Map();
  const db = getDatabase();
  const [records, products] = await Promise.all([
    db.collection("categories").find({ name: { $in: names } }).toArray(),
    db.collection("products").find({ active: true, category: { $in: names }, categoryEmoji: { $exists: true, $ne: "" } }).toArray(),
  ]);
  const map = new Map();
  for (const record of records) {
    const emoji = parseSelectEmoji(record.emoji);
    if (emoji) map.set(record.name, emoji);
  }
  for (const product of products) {
    if (map.has(product.category)) continue;
    const emoji = parseSelectEmoji(product.categoryEmoji);
    if (emoji) map.set(product.category, emoji);
  }
  return map;
}
function makeSelect(customId, placeholder, options, disabled = false) {
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder.slice(0, 150)).setMinValues(1).setMaxValues(1);
  if (options.length) menu.addOptions(options.slice(0, 25));
  else menu.addOptions([{ label: "Belum tersedia", value: "none", description: "Belum ada pilihan yang tersedia" }]).setDisabled(true);
  if (disabled) menu.setDisabled(true);
  return menu;
}

async function buildOrderPanel(order) {
  const categories = await orderCategories();
  const products = await productsInCategory(order.category);
  const categoryEmojis = await categoryEmojiMap(categories);
  const locked = order.status !== "ON HOLD" || ["verified", "pending_review"].includes(order.paymentStatus);
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 🛒 PESANAN " + clean(order.orderCode, 40)));
  divider(container);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "**Nama:** <@" + order.buyerId + ">\n" +
    "**Kategori:** " + (order.category ? clean(order.category, 80) : "Belum dipilih") + "\n" +
    "**Product:** " + (order.productName ? clean(order.productName, 100) : "Belum dipilih") + "\n" +
    "**Amount:** " + Number(order.amount || 1) + "\n" +
    "**Harga:** " + price(order.totalPrice) + "\n" +
    "**Status:** " + clean(order.status, 30) +
    (order.paymentStatus === "pending_review" ? "\n**Pembayaran:** Menunggu pemeriksaan admin" : "") +
    (order.paymentStatus === "verified" ? "\n**Pembayaran:** Terverifikasi" : "") +
    (order.paymentStatus === "rejected" ? "\n**Pembayaran:** Bukti ditolak, silakan kirim ulang" : ""),
  ));
  divider(container);
  const categoryOptions = categories.map(name => {
    const option = {
      label: name.slice(0, 100), value: name, description: ("Pilih kategori " + name).slice(0, 100),
      default: Boolean(order.category) && name === order.category,
    };
    const emoji = categoryEmojis.get(name);
    if (emoji) option.emoji = emoji;
    return option;
  });
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    makeSelect("rapstore:order:category", order.category ? "Kategori: " + order.category : "Pilih Kategori", categoryOptions, locked),
  ));
  const productOptions = products.map(product => {
    const option = {
      label: clean(product.name, 100) || "Produk",
      value: String(product._id),
      description: (price(product.price) + " • pilih produk ini").slice(0, 100),
      default: Boolean(order.productId) && String(product._id) === order.productId,
    };
    const emoji = parseSelectEmoji(product.emoji);
    if (emoji) option.emoji = emoji;
    return option;
  });
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    makeSelect("rapstore:order:product", order.productName ? clean(order.productName, 140) : "Pilih Produk", productOptions, locked || !order.category),
  ));
  const amountOptions = Array.from({ length: MAX_AMOUNT }, (_, index) => ({
    label: String(index + 1), value: String(index + 1), description: "Jumlah produk: " + (index + 1),
    default: Number(order.amount || 1) === index + 1,
  }));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    makeSelect("rapstore:order:amount", "Pilih Jumlah (1–25)", amountOptions, locked || !order.productId),
  ));
  const buttons = [
    new ButtonBuilder().setCustomId("rapstore:order:cancel").setLabel("Batalkan Pesanan").setStyle(ButtonStyle.Danger)
      .setDisabled(order.status !== "ON HOLD"),
  ];
  if (order.status === "PROSES") {
    buttons.push(new ButtonBuilder().setCustomId("rapstore:order:done").setLabel("Tandai DONE").setStyle(ButtonStyle.Success));
  }
  container.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return v2(container);
}

function buildPaymentPicker() {
  const container = buildPanel("PEMBAYARAN", "Pilih metode pembayaran. QRIS atau BANK akan menampilkan instruksi pembayaran di pesan ini.");
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:payment:qris").setLabel("QRIS").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:payment:bank").setLabel("BANK").setStyle(ButtonStyle.Secondary),
  ));
  return v2(container);
}
function configuredPayment(method) {
  if (method === "qris") {
    const imageUrl = clean(config.payments?.qrisImageUrl, 1000);
    if (!/^https:\/\/\S+$/i.test(imageUrl)) return null;
    return { imageUrl };
  }
  const bankName = clean(config.payments?.bankName, 100);
  const accountName = clean(config.payments?.bankAccountName, 100);
  const accountNumber = clean(config.payments?.bankAccountNumber, 100);
  if (!bankName || !accountName || !accountNumber) return null;
  return { bankName, accountName, accountNumber };
}
function buildPaymentInstruction(order, method, payment) {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## PEMBAYARAN " + (method === "qris" ? "QRIS" : "BANK")));
  divider(container);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "**Kode pesanan:** " + clean(order.orderCode, 40) + "\n" +
    "**Total transfer:** " + price(order.totalPrice) + "\n\n" +
    (method === "qris"
      ? "Pindai QRIS di bawah ini sesuai total pembayaran. Pastikan nominalnya tepat."
      : "**Bank:** " + payment.bankName + "\n**Nomor rekening:** " + payment.accountNumber + "\n**Atas nama:** " + payment.accountName + "\n\nTransfer sesuai total pembayaran."),
  ));
  if (method === "qris") {
    divider(container);
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(payment.imageUrl).setDescription("QRIS pembayaran RapStore"),
    ));
  }
  divider(container);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("Setelah transfer, kirim bukti transfer sebagai lampiran gambar atau file di channel tiket ini."));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:payment:qris").setLabel("QRIS").setStyle(method === "qris" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:payment:bank").setLabel("BANK").setStyle(method === "bank" ? ButtonStyle.Primary : ButtonStyle.Secondary),
  ));
  return v2(container);
}

async function refreshOrderMessage(order, client) {
  if (!order?.orderMessageId) return;
  const guild = await client.guilds.fetch(order.guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(order.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(order.orderMessageId).catch(() => null);
  if (message) await message.edit(await buildOrderPanel(order));
}

function buildDonePanel(order, vouchSubmitted = false) {
  const panel = buildPanel("PESANAN SELESAI",
    "Pesanan **" + clean(order.orderCode, 40) + "** sudah berstatus **DONE**.\n" +
    (vouchSubmitted ? "Testimoni lu sudah tercatat. Terima kasih!" :
      "Klik **VOUCH** untuk mengirim testimoni dalam 1 jam. Jika tidak dikirim, sistem akan menerbitkan vouch otomatis setelah 1 jam."));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:vouch:open:" + String(order._id))
      .setLabel(vouchSubmitted ? "VOUCH TERKIRIM" : "VOUCH")
      .setStyle(vouchSubmitted ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(vouchSubmitted),
  ));
  return v2(panel);
}

async function markOrderDone(order, actorId, channel, client) {
  const now = new Date();
  const autoCloseAt = new Date(now.getTime() + 60 * 60 * 1000);
  const result = await getDatabase().collection("orders").updateOne(
    { _id: order._id, status: "PROSES" },
    { $set: { status: "DONE", completedAt: now, completedBy: actorId, autoCloseAt, updatedAt: now } },
  );
  if (!result.modifiedCount) return null;
  let updated = await getDatabase().collection("orders").findOne({ _id: order._id });
  await refreshOrderMessage(updated, client).catch(error => console.error("[order-done-panel]", error?.message || error));
  const doneMessage = await channel.send(buildDonePanel(updated)).catch(error => {
    console.error("[order-done-vouch-panel]", error?.message || error);
    return null;
  });
  if (doneMessage) {
    await getDatabase().collection("orders").updateOne({ _id: order._id }, { $set: { doneMessageId: doneMessage.id, updatedAt: new Date() } });
    updated = { ...updated, doneMessageId: doneMessage.id };
  }
  await getDatabase().collection("audit_logs").insertOne({
    action: "order.completed", actorId, guildId: order.guildId,
    details: { orderId: String(order._id), orderCode: order.orderCode, autoCloseAt }, createdAt: new Date(),
  }).catch(() => {});
  return updated;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function componentTranscriptText(components, depth = 0) {
  if (!Array.isArray(components) || depth > 8) return [];
  const output = [];
  for (const component of components) {
    if (component?.content) output.push(String(component.content));
    if (component?.description) output.push(String(component.description));
    if (component?.components) output.push(...componentTranscriptText(component.components, depth + 1));
    if (component?.items) output.push(...componentTranscriptText(component.items, depth + 1));
    if (component?.accessory) output.push(...componentTranscriptText([component.accessory], depth + 1));
  }
  return output;
}

function transcriptSuffix() {
  let value = "";
  while (value.length < 5) value += randomBytes(8).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
  return value.slice(0, 5);
}

export async function archiveAndDeleteTicket({ channel, ticket, client, closedBy = null, reason = "ticket_closed" }) {
  if (!channel || !ticket) throw new Error("Ticket channel and database record are required to archive.");
  const archiveId = clean(config.transcriptChannelId, 30);
  if (!archiveId) throw new Error("TRANSCRIPT_CHANNEL_ID is not configured; ticket deletion is blocked to prevent transcript loss.");
  const archiveChannel = await client.channels.fetch(archiveId).catch(() => null);
  if (!archiveChannel || typeof archiveChannel.send !== "function") throw new Error("TRANSCRIPT_CHANNEL_ID is not a sendable channel.");

  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const rows = messages.map(message => {
    const author = message.author?.tag || message.author?.username || "Unknown";
    const text = [message.content, ...componentTranscriptText(message.components)].filter(Boolean).join("\n\n");
    const attachments = [...(message.attachments?.values?.() || [])].map(file =>
      '<li><a href="' + escapeHtml(file.url) + '">' + escapeHtml(file.name || "attachment") + '</a></li>'
    ).join("");
    const body = text ? '<pre>' + escapeHtml(text) + '</pre>' : "";
    return '<article><header><strong>' + escapeHtml(author) + '</strong> <time>' +
      escapeHtml(new Date(message.createdTimestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })) +
      '</time></header>' + body + (attachments ? '<ul>' + attachments + '</ul>' : "") + '</article>';
  }).join("\n");
  const html = '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RapStore Ticket Transcript</title><style>body{font:14px system-ui,sans-serif;background:#111827;color:#e5e7eb;margin:0;padding:24px}h1{font-size:22px}p{color:#9ca3af}article{background:#1f2937;border-radius:8px;padding:14px;margin:12px 0;overflow-wrap:anywhere}header{display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid #374151;padding-bottom:8px}time{color:#9ca3af;font-size:12px}pre{white-space:pre-wrap;font:inherit;margin:12px 0}a{color:#93c5fd}</style></head><body><h1>RapStore — Ticket Transcript</h1><p>Channel: ' +
    escapeHtml(channel.name) + ' • Ticket: ' + escapeHtml(ticket.ticketPrefix ? ticket.ticketPrefix + "-" + ticket.ticketNumber : channel.name) +
    ' • Closed by: ' + escapeHtml(closedBy || "system") + ' • Reason: ' + escapeHtml(reason) + '</p>' + rows + '</body></html>';
  const baseName = clean(ticket.ticketPrefix && Number.isInteger(ticket.ticketNumber)
    ? ticket.ticketPrefix + "-" + ticket.ticketNumber : channel.name.replace(/^closed-/, ""), 80).replace(/[^a-zA-Z0-9_-]/g, "-");
  const filename = baseName + "-#" + transcriptSuffix() + ".html";
  const archivedMessage = await archiveChannel.send({
    content: "Transcript tiket **" + baseName + "** • " + messages.length + " pesan • ditutup oleh " + (closedBy ? "<@" + closedBy + ">" : "sistem") + ".",
    files: [new AttachmentBuilder(Buffer.from(html, "utf8"), { name: filename })],
    allowedMentions: { parse: [], users: [], roles: [] },
  });
  await getDatabase().collection("tickets").updateOne(
    { _id: ticket._id, status: { $in: ["open", "closing"] } },
    { $set: {
      status: "closed", closedAt: new Date(), closedBy, closeReason: reason,
      transcriptFileName: filename, transcriptChannelId: archiveChannel.id, transcriptMessageId: archivedMessage.id,
    } },
  );
  await channel.delete("RapStore ticket archived as " + filename);
  return { filename, messageId: archivedMessage.id, messageCount: messages.length };
}

async function publishPendingVouches(client) {
  const db = getDatabase();
  const pending = await db.collection("vouches").find({
    $or: [
      { status: "pending_publish" },
      { status: "publishing", publishingAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
    ],
  }).sort({ createdAt: 1 }).limit(20).toArray();
  for (const vouch of pending) {
    const claim = await db.collection("vouches").updateOne({
      _id: vouch._id,
      $or: [
        { status: "pending_publish" },
        { status: "publishing", publishingAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
      ],
    }, { $set: { status: "publishing", publishingAt: new Date() } });
    if (!claim.modifiedCount) continue;
    try {
      if (!config.vouchChannelId) throw new Error("VOUCH_CHANNEL_ID is not configured.");
      const channel = await client.channels.fetch(config.vouchChannelId).catch(() => null);
      if (!channel || typeof channel.send !== "function") throw new Error("VOUCH_CHANNEL_ID is not a sendable channel.");
      const rating = Math.max(1, Math.min(5, Number(vouch.rating) || 5));
      const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
      const message = clean(vouch.message || "vouch otomatis setelah 1 jam. (ini jika user ga send vouch)", 700).replace(/\r/g, "");
      const quotedMessage = message.split("\n").map(line => "> " + line).join("\n");
      const date = new Date(vouch.createdAt || Date.now()).toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric",
      });
      const panel = new ContainerBuilder();
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("## RAP — CUSTOMER TESTIMONI\n-# VERIFIED TRANSACTION"));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "**CLIENT**\n<@" + vouch.buyerId + ">\n\n**PRODUCT**\n" + clean(vouch.productName || "Produk RapStore", 100),
      ));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "**RATING**\n" + stars + " (" + rating + "/5)\n\n**PESAN & KESAN**\n" + quotedMessage,
      ));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "> Thank you for trusting **RapStore**.\n\n-# Trusted. Fast. Secure. Professional.\n-# RAP TESTIMONI • " + date,
      ));
      const sent = await channel.send({
        flags: V2, components: [panel],
        allowedMentions: { parse: [], users: [], roles: [] },
      });
      await db.collection("vouches").updateOne(
        { _id: vouch._id, status: "publishing" },
        { $set: { status: "published", publishedAt: new Date(), publishedMessageId: sent.id }, $unset: { publishingAt: "" } },
      );
      await db.collection("orders").updateOne({ _id: new ObjectId(vouch.orderId) }, {
        $set: { vouchPublishedAt: new Date(), updatedAt: new Date() },
      });
      const order = await db.collection("orders").findOne({ _id: new ObjectId(vouch.orderId) });
      if (order?.doneMessageId) {
        const doneChannel = await client.channels.fetch(order.channelId).catch(() => null);
        const doneMessage = doneChannel ? await doneChannel.messages.fetch(order.doneMessageId).catch(() => null) : null;
        if (doneMessage) await doneMessage.edit(buildDonePanel(order, true)).catch(() => {});
      }
    } catch (error) {
      await db.collection("vouches").updateOne(
        { _id: vouch._id, status: "publishing" },
        { $set: { status: "pending_publish" }, $unset: { publishingAt: "" } },
      ).catch(() => {});
      console.error("[vouch-publish]", error?.message || error);
    }
  }
}

let maintenanceRunning = false;
async function runOrderMaintenance(client) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const db = getDatabase();
    await publishPendingVouches(client);
    const now = new Date();
    const dueOrders = await db.collection("orders").find({
      status: "DONE", autoCloseAt: { $lte: now }, ticketClosedAt: { $exists: false },
    }).sort({ autoCloseAt: 1 }).limit(20).toArray();
    for (const candidate of dueOrders) {
      const claimed = await db.collection("orders").updateOne({
        _id: candidate._id, status: "DONE", ticketClosedAt: { $exists: false },
        $or: [{ closeProcessingAt: { $exists: false } }, { closeProcessingAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }],
      }, { $set: { closeProcessingAt: new Date() } });
      if (!claimed.modifiedCount) continue;
      try {
        let vouch = await db.collection("vouches").findOne({ orderId: String(candidate._id) });
        if (!vouch) {
          try {
            const inserted = await db.collection("vouches").insertOne({
              orderId: String(candidate._id), orderCode: candidate.orderCode, guildId: candidate.guildId,
              channelId: candidate.channelId, buyerId: candidate.buyerId, productName: candidate.productName || "Produk RapStore",
              rating: 5, message: "vouch otomatis setelah 1 jam. (ini jika user ga send vouch)", automatic: true,
              status: "pending_publish", createdAt: new Date(candidate.autoCloseAt || now),
            });
            vouch = await db.collection("vouches").findOne({ _id: inserted.insertedId });
          } catch (error) {
            if (error?.code !== 11000) throw error;
            vouch = await db.collection("vouches").findOne({ orderId: String(candidate._id) });
          }
        }
        await publishPendingVouches(client);
        vouch = await db.collection("vouches").findOne({ orderId: String(candidate._id) });
        if (!vouch?.publishedAt) throw new Error("Vouch belum berhasil dikirim; ticket tetap dibiarkan agar tidak kehilangan alur.");
        const guild = await client.guilds.fetch(candidate.guildId).catch(() => null);
        const channel = guild ? await guild.channels.fetch(candidate.channelId).catch(() => null) : null;
        const ticket = await db.collection("tickets").findOne({ guildId: candidate.guildId, channelId: candidate.channelId });
        if (channel && ticket && ticket.status !== "closed") {
          await archiveAndDeleteTicket({ channel, ticket, client, closedBy: "system", reason: "order_done_auto_close" });
        } else if (!channel && ticket && ticket.status === "open") {
          await db.collection("tickets").updateOne({ _id: ticket._id, status: "open" }, {
            $set: { status: "deleted", closedAt: new Date(), closeReason: "channel_missing_before_auto_close" },
          });
        }
        await db.collection("orders").updateOne({ _id: candidate._id }, {
          $set: { ticketClosedAt: new Date(), updatedAt: new Date() }, $unset: { closeProcessingAt: "" },
        });
      } catch (error) {
        await db.collection("orders").updateOne({ _id: candidate._id }, { $unset: { closeProcessingAt: "" } }).catch(() => {});
        console.error("[order-auto-close]", candidate.orderCode, error?.message || error);
      }
    }
  } finally {
    maintenanceRunning = false;
  }
}

export function startOrderMaintenance(client) {
  const run = () => void runOrderMaintenance(client).catch(error => console.error("[order-maintenance]", error?.message || error));
  run();
  const timer = setInterval(run, 30_000);
  timer.unref?.();
}

export async function initializeOrderTicket({ channel, interaction, ticketNumber, ticketId, selectedProduct }) {
  const db = getDatabase();
  const product = selectedProduct && selectedProduct.active !== false ? selectedProduct : null;
  const unitPrice = product ? Number(product.price || 0) : 0;
  if (product && (!Number.isSafeInteger(unitPrice) || unitPrice < 1)) throw new Error("Selected product has an invalid price.");
  const orderCode = "RAP-" + ticketNumber + "-" + channel.id.slice(-4);
  const now = new Date();
  const result = await db.collection("orders").insertOne({
    orderCode, guildId: interaction.guildId, ticketId: String(ticketId), channelId: channel.id,
    buyerId: interaction.user.id, category: product ? clean(product.category || "Umum", 80) : "",
    productId: product ? String(product._id) : null, productName: product ? clean(product.name, 100) : null,
    unitPrice, amount: 1, totalPrice: unitPrice, status: "ON HOLD", paymentStatus: "unpaid",
    paymentMethod: null, orderMessageId: null, paymentMessageId: null, createdAt: now, updatedAt: now,
  });
  let order = await db.collection("orders").findOne({ _id: result.insertedId });
  const orderMessage = await channel.send(await buildOrderPanel(order));
  const paymentMessage = await channel.send(buildPaymentPicker());
  await db.collection("orders").updateOne({ _id: result.insertedId }, {
    $set: { orderMessageId: orderMessage.id, paymentMessageId: paymentMessage.id, updatedAt: new Date() },
  });
  order.orderMessageId = orderMessage.id;
  order.paymentMessageId = paymentMessage.id;
  await db.collection("audit_logs").insertOne({
    action: "order.created", actorId: interaction.user.id, guildId: interaction.guildId,
    details: { orderId: String(result.insertedId), orderCode, channelId: channel.id, ticketId: String(ticketId) },
    createdAt: new Date(),
  }).catch(() => {});
  await channel.send(v2(buildPanel(
    "INFO PESANAN",
    "Pilih kategori, produk, dan jumlah pada panel PESANAN. Setelah totalnya benar, pilih QRIS atau BANK. Jangan pernah mengirim password atau kode OTP.",
  )));
  return order;
}
export { allocateTicketNumber };

export async function handleOrderInteraction(interaction, client) {
  const customId = String(interaction.customId || "");
  const db = getDatabase();

  if (customId.startsWith("rapstore:vouch:")) {
    if (!interaction.inGuild()) {
      await replyNotice(interaction, "VOUCH TIDAK VALID", "Testimoni hanya dapat dikirim melalui tiket di server.");
      return;
    }
    const parts = customId.split(":");
    const action = parts[2];
    const orderId = parts[3] || "";
    if (!ObjectId.isValid(orderId)) {
      await replyNotice(interaction, "PESANAN TIDAK VALID", "ID pesanan untuk vouch tidak valid.");
      return;
    }
    const order = await db.collection("orders").findOne({ _id: new ObjectId(orderId), guildId: interaction.guildId, status: "DONE" });
    if (!order) {
      await replyNotice(interaction, "PESANAN BELUM SELESAI", "Tombol VOUCH hanya berlaku untuk transaksi yang sudah DONE.");
      return;
    }
    if (order.buyerId !== interaction.user.id) {
      await replyNotice(interaction, "AKSES DITOLAK", "Tombol VOUCH hanya dapat digunakan oleh pembeli transaksi ini.");
      return;
    }
    const existingVouch = await db.collection("vouches").findOne({ orderId: String(order._id) });
    if (action === "open" && interaction.isButton()) {
      if (existingVouch) {
        await replyNotice(interaction, "VOUCH SUDAH DICATAT", "Satu transaksi hanya dapat mengirim satu testimoni.");
        return;
      }
      if (order.autoCloseAt && new Date(order.autoCloseAt).getTime() <= Date.now()) {
        await replyNotice(interaction, "WAKTU VOUCH HABIS", "Batas pengiriman testimoni sudah lewat. Sistem akan menerbitkan vouch otomatis.");
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId("rapstore:vouch:submit:" + String(order._id))
        .setTitle("Kirim Testimoni RapStore")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("rating").setLabel("Rating (1–5)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("message").setLabel("Pesan & kesan").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(700),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
    if (action === "submit" && interaction.isModalSubmit()) {
      if (existingVouch) {
        await replyNotice(interaction, "VOUCH SUDAH DICATAT", "Testimoni untuk transaksi ini sudah tercatat.");
        return;
      }
      const rating = Number(interaction.fields.getTextInputValue("rating").trim());
      const message = clean(interaction.fields.getTextInputValue("message"), 700);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !message) {
        await replyNotice(interaction, "TESTIMONI TIDAK VALID", "Rating harus angka 1–5 dan pesan tidak boleh kosong.");
        return;
      }
      try {
        await db.collection("vouches").insertOne({
          orderId: String(order._id), orderCode: order.orderCode, guildId: order.guildId,
          channelId: order.channelId, buyerId: order.buyerId, productName: order.productName || "Produk RapStore",
          rating, message, automatic: false, status: "pending_publish", createdAt: new Date(),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        await replyNotice(interaction, "VOUCH SUDAH DICATAT", "Testimoni untuk transaksi ini sudah tercatat.");
        return;
      }
      await publishPendingVouches(client);
      const savedVouch = await db.collection("vouches").findOne({ orderId: String(order._id) });
      await replyNotice(
        interaction,
        savedVouch?.status === "published" ? "VOUCH TERKIRIM" : "VOUCH TERSIMPAN",
        savedVouch?.status === "published"
          ? "Terima kasih! Testimoni lu sudah dikirim ke channel testimoni RapStore."
          : "Testimoni tersimpan. Bot akan mencoba mengirimkannya kembali otomatis setelah channel vouch tersedia.",
      );
      return;
    }
    await replyNotice(interaction, "AKSI VOUCH TIDAK DIKENAL", "Buka tombol VOUCH pada tiket transaksi dan coba lagi.");
    return;
  }

  if (customId.startsWith("rapstore:payment:process:") || customId.startsWith("rapstore:payment:invalid:")) {
    if (!interaction.inGuild() || !staff(interaction.member)) {
      await replyNotice(interaction, "AKSES DITOLAK", "Hanya Founder/Admin yang dapat memverifikasi bukti transfer.");
      return;
    }
    const parts = customId.split(":");
    const action = parts[2];
    const proofId = parts[3] || "";
    if (!ObjectId.isValid(proofId)) {
      await replyNotice(interaction, "BUKTI TIDAK VALID", "ID bukti transfer tidak valid.");
      return;
    }
    const proof = await db.collection("payment_proofs").findOne({ _id: new ObjectId(proofId), status: "pending" });
    if (!proof) {
      await replyNotice(interaction, "BUKTI SUDAH DIPROSES", "Bukti ini sudah diperiksa atau tidak lagi aktif.");
      return;
    }
    const order = await db.collection("orders").findOne({ _id: new ObjectId(proof.orderId), status: "ON HOLD" });
    if (!order) {
      await replyNotice(interaction, "PESANAN TIDAK AKTIF", "Pesanan tidak ditemukan atau sudah tidak berada pada status ON HOLD.");
      return;
    }
    if (action === "process") {
      const result = await db.collection("payment_proofs").updateOne(
        { _id: proof._id, status: "pending" },
        { $set: { status: "accepted", reviewedAt: new Date(), reviewedBy: interaction.user.id } },
      );
      if (!result.modifiedCount) {
        await replyNotice(interaction, "BUKTI SUDAH DIPROSES", "Admin lain sudah memeriksa bukti ini.");
        return;
      }
      await db.collection("payment_proofs").updateMany(
        { orderId: String(order._id), _id: { $ne: proof._id }, status: "pending" },
        { $set: { status: "superseded", updatedAt: new Date() } },
      );
      const orderUpdate = await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD" }, {
        $set: { status: "PROSES", paymentStatus: "verified", paidAt: new Date(), reviewedBy: interaction.user.id, updatedAt: new Date() },
      });
      if (!orderUpdate.modifiedCount) {
        await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "accepted" }, { $set: { status: "superseded", updatedAt: new Date() } });
        await replyNotice(interaction, "PESANAN TIDAK AKTIF", "Status pesanan sudah berubah. Bukti ini tidak dapat digunakan untuk memproses pesanan.");
        return;
      }
      const updated = await db.collection("orders").findOne({ _id: order._id });
      await refreshOrderMessage(updated, client);
      await interaction.update(v2(buildPanel(
        "BUKTI TRANSFER DITERIMA",
        "Diperiksa oleh <@" + interaction.user.id + ">.\nPembeli <@" + order.buyerId + "> sudah dikonfirmasi. Pesanan **" + clean(order.orderCode, 40) + "** sekarang berstatus **PROSES**.",
      )));
      await db.collection("audit_logs").insertOne({
        action: "payment.verified", actorId: interaction.user.id, guildId: interaction.guildId,
        details: { orderId: String(order._id), proofId: String(proof._id), orderCode: order.orderCode }, createdAt: new Date(),
      }).catch(() => {});
      return;
    }
    const result = await db.collection("payment_proofs").updateOne(
      { _id: proof._id, status: "pending" },
      { $set: { status: "rejected", reviewedAt: new Date(), reviewedBy: interaction.user.id } },
    );
    if (!result.modifiedCount) {
      await replyNotice(interaction, "BUKTI SUDAH DIPROSES", "Admin lain sudah memeriksa bukti ini.");
      return;
    }
    const rejectedOrderUpdate = await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD" }, {
      $set: { paymentStatus: "rejected", updatedAt: new Date() },
    });
    if (!rejectedOrderUpdate.modifiedCount) {
      await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "rejected" }, { $set: { status: "superseded", updatedAt: new Date() } });
      await replyNotice(interaction, "PESANAN TIDAK AKTIF", "Status pesanan sudah berubah. Bukti ini tidak dapat ditolak untuk pesanan yang sudah tidak aktif.");
      return;
    }
    const rejectedOrder = await db.collection("orders").findOne({ _id: order._id });
    await refreshOrderMessage(rejectedOrder, client);
    await interaction.update(v2(buildPanel(
      "BUKTI TRANSFER TIDAK VALID",
      "Diperiksa oleh <@" + interaction.user.id + ">.\n<@" + order.buyerId + ">, bukti ini tidak valid. Silakan kirim ulang bukti pembayaran yang jelas dan sesuai nominal. Status pesanan tetap **ON HOLD**.",
    )));
    await db.collection("audit_logs").insertOne({
      action: "payment.rejected", actorId: interaction.user.id, guildId: interaction.guildId,
      details: { orderId: String(order._id), proofId: String(proof._id), orderCode: order.orderCode }, createdAt: new Date(),
    }).catch(() => {});
    return;
  }

  if (!interaction.inGuild()) {
    await replyNotice(interaction, "TIKET TIDAK VALID", "Aksi ini hanya bisa digunakan di server.");
    return;
  }
  const order = await db.collection("orders").findOne({ guildId: interaction.guildId, channelId: interaction.channelId });
  if (!order) {
    await replyNotice(interaction, "PESANAN TIDAK DITEMUKAN", "Data pesanan tidak ditemukan untuk channel ini.");
    return;
  }
  const isStaff = staff(interaction.member);
  if (order.buyerId !== interaction.user.id && !isStaff) {
    await replyNotice(interaction, "AKSES DITOLAK", "Hanya pemilik tiket atau Founder/Admin yang dapat mengubah pesanan ini.");
    return;
  }

  if (customId === "rapstore:order:cancel") {
    if (order.status !== "ON HOLD") {
      await replyNotice(interaction, "PESANAN SUDAH DIPROSES", "Pesanan hanya dapat dibatalkan sebelum admin memulai proses.");
      return;
    }
    const panel = buildPanel("KONFIRMASI BATALKAN PESANAN", "Yakin ingin membatalkan pesanan **" + clean(order.orderCode, 40) + "**? Status akan menjadi **CANCELLED** dan tiket akan ditutup.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:order:cancelconfirm").setLabel("Ya, Batalkan").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rapstore:order:cancelback").setLabel("Kembali").setStyle(ButtonStyle.Secondary),
    ));
    await interaction.reply(v2(panel, true));
    return;
  }
  if (customId === "rapstore:order:cancelback") {
    await interaction.update(v2(buildPanel("PEMBATALAN DIBATALKAN", "Pesanan tetap aktif.")));
    return;
  }
  if (customId === "rapstore:order:cancelconfirm") {
    if (order.status !== "ON HOLD") {
      await interaction.update(v2(buildPanel("PESANAN SUDAH DIPROSES", "Pesanan hanya dapat dibatalkan sebelum admin memulai proses.")));
      return;
    }
    const result = await db.collection("orders").updateOne(
      { _id: order._id, status: "ON HOLD" },
      { $set: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: interaction.user.id, updatedAt: new Date() } },
    );
    if (!result.modifiedCount) {
      await interaction.update(v2(buildPanel("PESANAN SUDAH DIPROSES", "Status pesanan sudah berubah.")));
      return;
    }
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(v2(buildPanel("PESANAN DIBATALKAN", "Status pesanan **" + clean(order.orderCode, 40) + "** berubah menjadi **CANCELLED**. Tiket akan diarsipkan sebagai transcript.")));
    const channel = interaction.channel;
    if (order.orderMessageId) {
      const message = await channel.messages.fetch(order.orderMessageId).catch(() => null);
      if (message) await message.edit(await buildOrderPanel(updated)).catch(() => {});
    }
    await channel.send(v2(buildPanel("PESANAN DIBATALKAN", "Pesanan dibatalkan oleh <@" + interaction.user.id + ">. Transcript akan disimpan sebelum channel dihapus.")));
    const ticket = await db.collection("tickets").findOne({ guildId: interaction.guildId, channelId: interaction.channelId, status: "open" });
    if (ticket) {
      try {
        await archiveAndDeleteTicket({ channel, ticket, client, closedBy: interaction.user.id, reason: "order_cancelled" });
      } catch (error) {
        console.error("[order-cancel-archive]", error?.message || error);
        await channel.send(v2(buildPanel("TRANSCRIPT BELUM TERSIMPAN", "Channel tidak dihapus agar isi tiket tidak hilang. Periksa TRANSCRIPT_CHANNEL_ID dan izin bot."))).catch(() => {});
      }
    }
    await db.collection("audit_logs").insertOne({
      action: "order.cancelled", actorId: interaction.user.id, guildId: interaction.guildId,
      details: { orderId: String(order._id), orderCode: order.orderCode, channelId: order.channelId }, createdAt: new Date(),
    }).catch(() => {});
    return;
  }
  if (customId === "rapstore:order:done") {
    if (!isStaff) {
      await replyNotice(interaction, "AKSES DITOLAK", "Hanya Founder/Admin yang dapat menandai pesanan selesai.");
      return;
    }
    if (order.status !== "PROSES") {
      await replyNotice(interaction, "STATUS TIDAK SESUAI", "Pesanan hanya bisa ditandai DONE dari status PROSES.");
      return;
    }
    await interaction.deferUpdate();
    const updated = await markOrderDone(order, interaction.user.id, interaction.channel, client);
    if (!updated) {
      await replyNotice(interaction, "STATUS BERUBAH", "Pesanan tidak lagi berstatus PROSES. Muat ulang panel dan coba lagi.");
    }
    return;
  }

  if (interaction.isButton() && (customId === "rapstore:payment:qris" || customId === "rapstore:payment:bank")) {
    if (order.status !== "ON HOLD" || ["verified", "pending_review"].includes(order.paymentStatus)) {
      await replyNotice(interaction, "PEMBAYARAN TERKUNCI", "Pilihan pembayaran tidak dapat diubah setelah pesanan diproses.");
      return;
    }
    if (!order.productId || !Number.isSafeInteger(order.totalPrice) || order.totalPrice < 1) {
      await replyNotice(interaction, "PILIH PRODUK DULU", "Pilih kategori dan produk, lalu pastikan jumlah serta total harga sudah benar sebelum memilih pembayaran.");
      return;
    }
    if (!ObjectId.isValid(order.productId)) {
      await replyNotice(interaction, "PRODUK TIDAK VALID", "Pilih ulang produk dari katalog sebelum membayar.");
      return;
    }
    const liveProduct = await db.collection("products").findOne({ _id: new ObjectId(order.productId), active: true });
    if (!liveProduct) {
      await replyNotice(interaction, "PRODUK SUDAH TIDAK TERSEDIA", "Produk ini sudah tidak aktif. Pilih produk aktif yang lain sebelum membayar.");
      return;
    }
    const livePrice = Number(liveProduct.price);
    const liveTotal = livePrice * Number(order.amount || 1);
    if (!Number.isSafeInteger(livePrice) || livePrice < 1 || !Number.isSafeInteger(liveTotal)) {
      await replyNotice(interaction, "HARGA TIDAK VALID", "Harga produk tidak dapat digunakan. Hubungi Founder/Admin.");
      return;
    }
    if (livePrice !== order.unitPrice) {
      await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD" }, {
        $set: { unitPrice: livePrice, totalPrice: liveTotal, paymentMethod: null, paymentStatus: "unpaid", updatedAt: new Date() },
      });
      const repricedOrder = await db.collection("orders").findOne({ _id: order._id });
      await refreshOrderMessage(repricedOrder, client);
      if (order.paymentMessageId) {
        const oldPaymentMessage = await interaction.channel.messages.fetch(order.paymentMessageId).catch(() => null);
        if (oldPaymentMessage) await oldPaymentMessage.edit(buildPaymentPicker()).catch(() => {});
      }
      await replyNotice(interaction, "HARGA DIPERBARUI", "Harga produk berubah sejak dipilih. Total sudah diperbarui menjadi **" + price(liveTotal) + "**. Periksa pesanan lalu pilih metode pembayaran lagi.");
      return;
    }
    const method = customId.endsWith(":qris") ? "qris" : "bank";
    const payment = configuredPayment(method);
    if (!payment) {
      const missing = method === "qris"
        ? "QRIS belum dikonfigurasi. Founder perlu mengisi PAYMENT_QRIS_IMAGE_URL."
        : "Rekening bank belum dikonfigurasi. Founder perlu mengisi PAYMENT_BANK_NAME, PAYMENT_BANK_ACCOUNT_NAME, dan PAYMENT_BANK_ACCOUNT_NUMBER.";
      await replyNotice(interaction, "METODE PEMBAYARAN BELUM SIAP", missing);
      return;
    }
    await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD" }, {
      $set: { paymentMethod: method, paymentStatus: "unpaid", paymentMessageId: interaction.message.id, updatedAt: new Date() },
    });
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(buildPaymentInstruction(updated, method, payment));
    await db.collection("audit_logs").insertOne({
      action: "payment.method_selected", actorId: interaction.user.id, guildId: interaction.guildId,
      details: { orderId: String(order._id), orderCode: order.orderCode, method }, createdAt: new Date(),
    }).catch(() => {});
    return;
  }

  if (interaction.isStringSelectMenu() && customId.startsWith("rapstore:order:")) {
    if (order.status !== "ON HOLD" || ["verified", "pending_review"].includes(order.paymentStatus)) {
      await replyNotice(interaction, "PESANAN TERKUNCI", "Pilihan pesanan tidak dapat diubah setelah diproses.");
      return;
    }
    const selection = interaction.values[0];
    const previousPaymentMethod = order.paymentMethod;
    const changes = { updatedAt: new Date(), paymentMethod: null, paymentStatus: "unpaid" };
    if (customId === "rapstore:order:category") {
      const categories = await orderCategories();
      if (!categories.includes(selection)) {
        await replyNotice(interaction, "KATEGORI TIDAK VALID", "Pilih kategori aktif dari daftar.");
        return;
      }
      Object.assign(changes, { category: selection, productId: null, productName: null, unitPrice: 0, totalPrice: 0, amount: 1 });
    } else if (customId === "rapstore:order:product") {
      if (!ObjectId.isValid(selection)) {
        await replyNotice(interaction, "PRODUK TIDAK VALID", "Pilih produk dari daftar yang tersedia.");
        return;
      }
      const product = await db.collection("products").findOne({ _id: new ObjectId(selection), active: true });
      if (!product || clean(product.category || "Umum", 80) !== order.category) {
        await replyNotice(interaction, "PRODUK TIDAK VALID", "Produk tidak tersedia pada kategori yang dipilih.");
        return;
      }
      const unitPrice = Number(product.price);
      const totalPrice = unitPrice * Number(order.amount || 1);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 1 || !Number.isSafeInteger(totalPrice)) {
        await replyNotice(interaction, "HARGA PRODUK TIDAK VALID", "Harga atau total produk tidak aman untuk dihitung. Hubungi Founder/Admin.");
        return;
      }
      Object.assign(changes, {
        productId: String(product._id), productName: clean(product.name, 100), unitPrice,
        totalPrice, category: clean(product.category || "Umum", 80),
      });
    } else if (customId === "rapstore:order:amount") {
      const amount = Number(selection);
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !order.productId) {
        await replyNotice(interaction, "JUMLAH TIDAK VALID", "Jumlah harus antara 1 dan 25, dan produk harus dipilih terlebih dahulu.");
        return;
      }
      const totalPrice = Number(order.unitPrice || 0) * amount;
      if (!Number.isSafeInteger(totalPrice)) {
        await replyNotice(interaction, "TOTAL TIDAK VALID", "Total harga terlalu besar untuk dihitung dengan aman. Hubungi Founder/Admin.");
        return;
      }
      Object.assign(changes, { amount, totalPrice });
    } else {
      await replyNotice(interaction, "PILIHAN TIDAK DIKENAL", "Buka ulang panel pesanan dan coba lagi.");
      return;
    }
    await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD", paymentStatus: { $ne: "verified" } }, { $set: changes });
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(await buildOrderPanel(updated));
    if (previousPaymentMethod && order.paymentMessageId) {
      const paymentMessage = await interaction.channel.messages.fetch(order.paymentMessageId).catch(() => null);
      if (paymentMessage) await paymentMessage.edit(buildPaymentPicker()).catch(() => {});
    }
    await db.collection("audit_logs").insertOne({
      action: "order.updated", actorId: interaction.user.id, guildId: interaction.guildId,
      details: { orderId: String(order._id), orderCode: order.orderCode, category: updated.category, productId: updated.productId, amount: updated.amount, totalPrice: updated.totalPrice },
      createdAt: new Date(),
    }).catch(() => {});
  }
}

export async function handleOrderMessage(message, client) {
  if (!message?.guild || message.author?.bot || !message.channel) return;
  const db = getDatabase();
  if (String(message.content || "").trim().toLowerCase() === "!done") {
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!staff(member)) {
      await message.channel.send(v2(buildPanel("AKSES DITOLAK", "Command !done hanya bisa digunakan Founder/Admin."))).catch(() => {});
      return;
    }
    const ticket = await db.collection("tickets").findOne({
      guildId: message.guild.id, channelId: message.channel.id, status: "open", type: "order_now",
    });
    if (!ticket) {
      await message.channel.send(v2(buildPanel("TIKET ORDER TIDAK DITEMUKAN", "Command !done hanya berlaku di tiket order yang masih terbuka."))).catch(() => {});
      return;
    }
    const order = await db.collection("orders").findOne({
      guildId: message.guild.id, channelId: message.channel.id, status: "PROSES",
    });
    if (!order) {
      await message.channel.send(v2(buildPanel("STATUS TIDAK SESUAI", "Pesanan harus berstatus PROSES sebelum bisa ditandai DONE."))).catch(() => {});
      return;
    }
    const updated = await markOrderDone(order, message.author.id, message.channel, client);
    if (!updated) {
      await message.channel.send(v2(buildPanel("STATUS BERUBAH", "Pesanan tidak lagi berstatus PROSES. Periksa panel pesanan."))).catch(() => {});
    }
    return;
  }
  if (!message.attachments?.size) return;
  const ticket = await db.collection("tickets").findOne({
    guildId: message.guild.id, channelId: message.channel.id, status: "open", type: "order_now",
  });
  if (!ticket || ticket.buyerId !== message.author.id) return;
  const order = await db.collection("orders").findOne({
    guildId: message.guild.id, channelId: message.channel.id, buyerId: message.author.id,
    status: "ON HOLD", paymentMethod: { $in: ["qris", "bank"] },
  });
  if (!order) return;
  const attachments = [...message.attachments.values()].map(item => ({
    name: clean(item.name || "bukti-transfer", 200), url: item.url,
    contentType: clean(item.contentType || "", 100), size: Number(item.size || 0),
  }));
  if (!attachments.length) return;
  await db.collection("payment_proofs").updateMany(
    { orderId: String(order._id), status: "pending" },
    { $set: { status: "superseded", updatedAt: new Date() } },
  );
  const proofResult = await db.collection("payment_proofs").insertOne({
    orderId: String(order._id), orderCode: order.orderCode, guildId: message.guild.id,
    channelId: message.channel.id, buyerId: message.author.id, messageId: message.id,
    attachments, status: "pending", createdAt: new Date(),
  });
  await db.collection("orders").updateOne({ _id: order._id, status: "ON HOLD" }, {
    $set: { paymentStatus: "pending_review", latestProofId: String(proofResult.insertedId), updatedAt: new Date() },
  });
  const refreshedOrder = await db.collection("orders").findOne({ _id: order._id });
  await refreshOrderMessage(refreshedOrder, client);
  const roleMentions = [config.ids.founderRole, config.ids.adminRole].filter(Boolean);
  const proofLines = attachments.map((attachment, index) => "[" + (index + 1) + ". " + attachment.name + "](" + attachment.url + ")");
  const panel = buildPanel("VERIFIKASI BUKTI TRANSFER",
    roleMentions.map(id => "<@&" + id + ">").join(" ") + "\n" +
    "**Pesanan:** " + clean(order.orderCode, 40) + "\n**Pengirim:** <@" + message.author.id + ">\n" +
    "**Metode:** " + (order.paymentMethod === "qris" ? "QRIS" : "BANK") + "\n" +
    "**Nominal yang harus dibayar:** " + price(order.totalPrice) + "\n\n**Lampiran bukti:**\n" + proofLines.join("\n"));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:payment:process:" + String(proofResult.insertedId)).setLabel("PROSES").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rapstore:payment:invalid:" + String(proofResult.insertedId)).setLabel("TIDAK VALID").setStyle(ButtonStyle.Danger),
  ));
  await message.channel.send({
    flags: V2, components: [panel],
    allowedMentions: { roles: roleMentions, users: [], parse: [] },
  });
  await db.collection("audit_logs").insertOne({
    action: "payment.proof_submitted", actorId: message.author.id, guildId: message.guild.id,
    details: { orderId: String(order._id), orderCode: order.orderCode, proofId: String(proofResult.insertedId), attachmentCount: attachments.length },
    createdAt: new Date(),
  }).catch(() => {});
}
