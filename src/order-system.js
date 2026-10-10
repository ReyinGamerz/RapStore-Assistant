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
import {
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_ATTACHMENT_BYTES,
  validateProofAttachments,
  isStaffMember,
  canAccessTicket,
  escapeDiscordMarkdown,
  expectedProofStatus,
} from "./security.js";

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
  return isStaffMember(member, [config.ids.founderRole, config.ids.adminRole]);
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
    "**Status:** " + clean(order.status, 30) + "\n" +
    "**ID:** " + clean(order.ticketCode || order.orderCode, 20) +
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

function paymentReviewResultPayload(title, body) {
  return {
    ...v2(buildPanel(title, body)),
    allowedMentions: { parse: [], users: [], roles: [] },
  };
}

async function updatePaymentReviewMessage(interaction, title, body) {
  const payload = paymentReviewResultPayload(title, body);
  try {
    await interaction.update(payload);
    return true;
  } catch (error) {
    // A failure in the interaction callback must not leave the visible review controls stale
    // when the bot still has permission to edit its message directly.
    console.error("[payment-review-message-update]", error?.message || error);
    try {
      if (interaction.message?.editable) {
        await interaction.message.edit(payload);
        return true;
      }
    } catch (fallbackError) {
      console.error("[payment-review-message-edit]", fallbackError?.message || fallbackError);
    }
    return false;
  }
}

function buildPaymentReviewNotice(proof, order) {
  const roleMentions = [config.ids.founderRole, config.ids.adminRole].filter(Boolean);
  const attachments = Array.isArray(proof.attachments) ? proof.attachments : [];
  const proofLines = attachments.map((attachment, index) => {
    const name = escapeDiscordMarkdown(clean(attachment.name || "bukti-transfer", 200));
    const url = safeHttpUrl(attachment.url);
    return url
      ? "[" + (index + 1) + ". " + name + "](<" + url + ">)"
      : "**" + (index + 1) + ". " + name + "**";
  });
  const panel = buildPanel(
    "VERIFIKASI BUKTI TRANSFER",
    roleMentions.map(id => "<@" + id + ">").join(" ") + "\n" +
    "**Pesanan:** " + clean(order.orderCode, 40) + "\n" +
    "**Pengirim:** <@" + clean(proof.buyerId, 30) + ">\n" +
    "**Metode:** " + (order.paymentMethod === "qris" ? "QRIS" : "BANK") + "\n" +
    "**Nominal yang harus dibayar:** " + price(order.totalPrice) + "\n\n" +
    "**Lampiran bukti:**\n" + (proofLines.join("\n") || "Tidak ada lampiran."),
  );
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:payment:process:" + String(proof._id)).setLabel("PROSES").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rapstore:payment:invalid:" + String(proof._id)).setLabel("TIDAK VALID").setStyle(ButtonStyle.Danger),
  ));
  return {
    flags: V2,
    components: [panel],
    allowedMentions: { roles: roleMentions, users: [], parse: [] },
  };
}

function paymentReviewMessageHasProof(message, proofId) {
  const target = "rapstore:payment:process:" + String(proofId);
  try {
    return JSON.stringify((message.components || []).map(component => component.toJSON?.() ?? component)).includes(target);
  } catch {
    return false;
  }
}

async function reconcilePaymentProofStatuses(db) {
  const proofs = await db.collection("payment_proofs").find({ status: "pending" })
    .sort({ createdAt: 1 }).limit(100).toArray();
  for (const proof of proofs) {
    let order = null;
    if (ObjectId.isValid(String(proof.orderId || ""))) {
      order = await db.collection("orders").findOne({
        _id: new ObjectId(proof.orderId),
        guildId: proof.guildId,
        channelId: proof.channelId,
      }).catch(error => {
        console.error("[payment-proof-reconcile-order]", error?.message || error);
        return null;
      });
    }
    const targetStatus = expectedProofStatus(proof, order);
    if (!targetStatus || targetStatus === "pending") continue;
    const now = new Date();
    const changes = { status: targetStatus, updatedAt: now };
    if (targetStatus === "accepted" || targetStatus === "rejected") {
      changes.reviewedAt = proof.reviewedAt || now;
      changes.reviewedBy = proof.reviewedBy || order?.reviewedBy || null;
    } else {
      changes.supersededAt = now;
      changes.supersededReason = !order ? "order_missing" : "order_state_changed";
    }
    await db.collection("payment_proofs").updateOne(
      { _id: proof._id, status: "pending" },
      { $set: changes },
    ).catch(error => console.error("[payment-proof-reconcile-update]", error?.message || error));
  }
}

async function ensurePendingPaymentNotices(client, db) {
  const proofs = await db.collection("payment_proofs").find({ status: "pending" })
    .sort({ createdAt: 1 }).limit(100).toArray();
  for (const proof of proofs) {
    let order = null;
    if (ObjectId.isValid(String(proof.orderId || ""))) {
      order = await db.collection("orders").findOne({
        _id: new ObjectId(proof.orderId),
        guildId: proof.guildId,
        channelId: proof.channelId,
      }).catch(error => {
        console.error("[payment-proof-notice-order]", error?.message || error);
        return null;
      });
    }
    if (expectedProofStatus(proof, order) !== "pending") continue;

    const channel = await client.channels.fetch(String(proof.channelId || "")).catch(error => {
      if (Number(error?.code) !== 10003) console.error("[payment-proof-notice-channel]", error?.message || error);
      return null;
    });
    if (!channel || typeof channel.send !== "function" || !channel.messages) continue;

    if (proof.reviewMessageId && String(proof.reviewChannelId || proof.channelId) === String(channel.id)) {
      const existing = await channel.messages.fetch(proof.reviewMessageId).catch(() => null);
      if (existing && paymentReviewMessageHasProof(existing, proof._id)) continue;
    }

    let existingNotice = null;
    let before;
    for (let page = 0; page < 3 && !existingNotice; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(error => {
        console.error("[payment-proof-notice-search]", error?.message || error);
        return null;
      });
      if (!batch?.size) break;
      existingNotice = batch.find(message => paymentReviewMessageHasProof(message, proof._id)) || null;
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    if (existingNotice) {
      await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "pending" }, {
        $set: { reviewMessageId: existingNotice.id, reviewChannelId: channel.id, reviewNotifiedAt: new Date() },
      }).catch(error => console.error("[payment-proof-notice-save]", error?.message || error));
      continue;
    }

    // Recheck the order immediately before sending so a stale notice is not recreated.
    const currentOrder = await db.collection("orders").findOne({
      _id: new ObjectId(proof.orderId),
      guildId: proof.guildId,
      channelId: proof.channelId,
    }).catch(() => null);
    if (expectedProofStatus(proof, currentOrder) !== "pending") continue;

    try {
      const sent = await channel.send(buildPaymentReviewNotice(proof, currentOrder));
      await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "pending" }, {
        $set: { reviewMessageId: sent.id, reviewChannelId: channel.id, reviewNotifiedAt: new Date() },
      });
    } catch (error) {
      console.error("[payment-proof-notice-send]", proof.orderCode, error?.message || error);
    }
  }
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

function buildOrderLog(order) {
  const container = new ContainerBuilder();
  const date = new Date(order.createdAt || Date.now()).toLocaleDateString("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric" });
  const amount = Number(order.amount || 1).toLocaleString("id-ID");
  const total = Number(order.totalPrice || 0).toLocaleString("id-ID");
  const tick = String.fromCharCode(96);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("# RAPSTORE — ORDER LOGS\n## STATUS: " + tick + clean(order.status || "ON HOLD", 30) + tick));
  divider(container);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    "<:people:1549409947215728690> **Buyer**\n" +
    "<:alur:1553800809198649344> <@" + clean(order.buyerId, 30) + ">\n\n" +
    "<:box:1551492070051553290> **Jenis Product**\n" +
    "<:alur:1553800809198649344> " + tick + clean(order.productName || "Belum dipilih", 100) + tick + "\n\n" +
    "<a:bintang:1558403940977082448> **Jumlah**\n" +
    "<:alur:1553800809198649344> " + tick + amount + tick + "\n\n" +
    "<:uang:1552535412579508325> **Harga**\n" +
    "<:alur:1553800809198649344> " + tick + total + tick + "\n\n" +
    "<a:jam:1549673401881333841> **Date**\n" +
    "<:alur:1553800809198649344> " + tick + date + tick + "\n\n" +
    "**Order ID**\n<:alur:1553800809198649344> " + tick + clean(order.orderCode || "", 40) + tick
  ));
  return v2(container);
}

async function refreshOrderLog(order, client) {
  const logChannelId = clean(config.orderLogChannelId, 30);
  if (!logChannelId || !order || order.ticketType === "product_question") return;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") { console.error("[order-log] ORDER_LOG_CHANNEL_ID is not a sendable channel."); return; }
  if (order.orderLogMessageId && order.orderLogChannelId === logChannelId) {
    const existing = await channel.messages.fetch(order.orderLogMessageId).catch(() => null);
    if (existing) { await existing.edit({ ...buildOrderLog(order), allowedMentions: { parse: [], users: [], roles: [] } }); return; }
  }
  const message = await channel.send({ ...buildOrderLog(order), allowedMentions: { parse: [], users: [], roles: [] } });
  const orders = getDatabase().collection("orders");
  const filter = order.orderLogMessageId
    ? { _id: order._id, orderLogMessageId: order.orderLogMessageId, orderLogChannelId: order.orderLogChannelId }
    : { _id: order._id, $or: [{ orderLogMessageId: { $exists: false } }, { orderLogMessageId: null }] };
  const saved = await orders.updateOne(filter, { $set: { orderLogMessageId: message.id, orderLogChannelId: logChannelId, updatedAt: new Date() } });
  if (!saved.modifiedCount) {
    const latest = await orders.findOne({ _id: order._id });
    if (latest?.orderLogMessageId) {
      await message.delete().catch(() => {});
      if (latest.orderLogChannelId === logChannelId) {
        const winner = await channel.messages.fetch(latest.orderLogMessageId).catch(() => null);
        if (winner) await winner.edit({ ...buildOrderLog(latest), allowedMentions: { parse: [], users: [], roles: [] } }).catch(() => {});
      }
      order.orderLogMessageId = latest.orderLogMessageId;
      order.orderLogChannelId = latest.orderLogChannelId;
      return;
    }
  }
  order.orderLogMessageId = message.id;
  order.orderLogChannelId = logChannelId;
}

async function refreshOrderMessage(order, client) {
  if (!order) return;
  if (order.orderMessageId) {
    const guild = await client.guilds.fetch(order.guildId).catch(() => null);
    if (guild) {
      const channel = await guild.channels.fetch(order.channelId).catch(() => null);
      if (channel) {
        const message = await channel.messages.fetch(order.orderMessageId).catch(() => null);
        if (message) {
          try {
            await message.edit(await buildOrderPanel(order));
          } catch (error) {
            console.error("[order-panel-refresh]", order.orderCode, error?.message || error);
          }
        }
      }
    }
  }
  await refreshOrderLog(order, client).catch(error => console.error("[order-log]", error?.message || error));
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

function safeHttpUrl(value) {
  const url = String(value ?? "");
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : "";
}

function transcriptLink(url, label, className = "") {
  const safe = safeHttpUrl(url);
  if (!safe) return escapeHtml(label || url || "");
  return '<a' + (className ? ' class="' + escapeHtml(className) + '"' : "") +
    ' href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' +
    escapeHtml(label || safe) + '</a>';
}

function componentTranscriptText(components, depth = 0) {
  if (!Array.isArray(components) || depth > 8) return [];
  const output = [];
  for (const component of components) {
    const content = component?.content ?? component?.data?.content;
    const description = component?.description ?? component?.data?.description;
    const label = component?.label ?? component?.data?.label;
    if (content) output.push(String(content));
    if (description) output.push(String(description));
    if (label && component?.type !== 1) output.push(String(label));
    if (component?.components) output.push(...componentTranscriptText(component.components, depth + 1));
    if (component?.items) output.push(...componentTranscriptText(component.items, depth + 1));
    if (component?.accessory) output.push(...componentTranscriptText([component.accessory], depth + 1));
  }
  return [...new Set(output.map(value => value.trim()).filter(Boolean))];
}

function componentTranscriptMedia(components, depth = 0) {
  if (!Array.isArray(components) || depth > 8) return [];
  const output = [];
  for (const component of components) {
    const mediaUrl = component?.media?.url ?? component?.data?.media?.url ?? component?.url ?? component?.data?.url;
    if (mediaUrl && safeHttpUrl(mediaUrl)) output.push({
      url: mediaUrl,
      description: component?.description ?? component?.data?.description ?? "Gambar dari pesan Discord",
    });
    if (component?.components) output.push(...componentTranscriptMedia(component.components, depth + 1));
    if (component?.items) output.push(...componentTranscriptMedia(component.items, depth + 1));
    if (component?.accessory) output.push(...componentTranscriptMedia([component.accessory], depth + 1));
  }
  const seen = new Set();
  return output.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function transcriptImage(url, alt, className = "attachment-image") {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  return '<a class="image-link" href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' +
    '<img class="' + escapeHtml(className) + '" src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt || "Gambar lampiran") +
    '" loading="lazy" referrerpolicy="no-referrer"></a>';
}

function renderTranscriptEmbed(embed, archivedImageUrls = new Map()) {
  const author = embed.author?.name
    ? '<div class="embed-author">' + (embed.author.iconURL ? transcriptImage(embed.author.iconURL, "", "embed-author-icon") : "") +
      (embed.author.url ? transcriptLink(embed.author.url, embed.author.name) : escapeHtml(embed.author.name)) + '</div>'
    : "";
  const title = embed.title
    ? '<div class="embed-title">' + (embed.url ? transcriptLink(embed.url, embed.title) : escapeHtml(embed.title)) + '</div>'
    : "";
  const description = embed.description ? '<div class="embed-description">' + escapeHtml(embed.description) + '</div>' : "";
  const fields = (embed.fields || []).map(field =>
    '<div class="embed-field' + (field.inline ? ' inline' : '') + '"><div class="embed-field-name">' +
    escapeHtml(field.name) + '</div><div class="embed-field-value">' + escapeHtml(field.value) + '</div></div>'
  ).join("");
  const image = embed.image?.url ? transcriptImage(archivedImageUrls.get(embed.image.url) || embed.image.url, embed.title || "Gambar embed", "embed-image") : "";
  const thumbnail = embed.thumbnail?.url ? transcriptImage(archivedImageUrls.get(embed.thumbnail.url) || embed.thumbnail.url, embed.title || "Thumbnail embed", "embed-thumbnail") : "";
  const footer = embed.footer?.text
    ? '<div class="embed-footer">' + (embed.footer.iconURL ? transcriptImage(embed.footer.iconURL, "", "embed-footer-icon") : "") +
      escapeHtml(embed.footer.text) + (embed.timestamp ? ' • ' + escapeHtml(new Date(embed.timestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })) : "") + '</div>'
    : "";
  if (!author && !title && !description && !fields && !image && !thumbnail && !footer) return "";
  const color = Number.isInteger(embed.color) ? '#' + embed.color.toString(16).padStart(6, "0") : "#5865f2";
  return '<section class="discord-embed" style="--embed-color:' + color + '">' + author + title + description +
    (thumbnail ? '<div class="embed-content-with-thumb">' + thumbnail + '</div>' : "") + fields + image + footer + '</section>';
}

function transcriptMessageText(message) {
  let text = String(message.content || "");
  text = text.replace(/<@!?(\d+)>/g, (match, id) => {
    const user = message.mentions?.users?.get(id);
    return user ? "@" + (user.globalName || user.username) : match;
  });
  text = text.replace(/<@&(\d+)>/g, (match, id) => {
    const role = message.mentions?.roles?.get(id);
    return role ? "@" + role.name : match;
  });
  text = text.replace(/<#(\d+)>/g, (match, id) => {
    const channel = message.mentions?.channels?.get(id);
    return channel ? "#" + channel.name : match;
  });
  return text;
}

function encodeInvisibleMarker(value) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  let encoded = "\u2063";
  for (const byte of bytes) encoded += byte.toString(2).padStart(8, "0").replace(/0/g, "\u200b").replace(/1/g, "\u200c");
  return encoded + "\u2063";
}
function transcriptSuffix() {
  let value = "";
  while (value.length < 5) value += randomBytes(8).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
  return value.slice(0, 5);
}

function isImageAttachment(attachment) {
  const contentType = String(attachment?.contentType || "").toLowerCase().split(";")[0].trim();
  const name = String(attachment?.name || "");
  return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(name);
}

async function archiveTicketImages(archiveChannel, messages, ticket, archiveKey, baseName) {
  const photos = [];
  const seenUrls = new Set();
  for (const message of messages) {
    for (const attachment of message.attachments?.values?.() || []) {
      if (!attachment?.url || !isImageAttachment(attachment) || seenUrls.has(attachment.url)) continue;
      seenUrls.add(attachment.url);
      const token = String(attachment.id || message.id + "-" + photos.length).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
      photos.push({ messageId: message.id, attachment, token, marker: archiveKey + "-photo-" + token });
    }
  }

  const urls = new Map();
  if (!photos.length) return urls;

  // Reuse all images already copied during an interrupted archive attempt.
  const markerLookup = photos.map(photo => ({
    legacy: "[archive-photo-key:" + photo.marker + "]",
    hidden: encodeInvisibleMarker(photo.token),
    photo,
  }));
  let before;
  for (let page = 0; page < 10; page++) {
    const batch = await archiveChannel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const message of batch.values()) {
      const content = String(message.content || "");
      for (const marker of markerLookup) {
        const { photo } = marker;
        if (urls.has(photo.attachment.url) || (!content.includes(marker.legacy) && !content.includes(marker.hidden))) continue;
        const prefix = "rap-" + photo.token + "-";
        const archived = message.attachments?.find(item => String(item.name || "").startsWith(prefix));
        if (archived?.url) urls.set(photo.attachment.url, archived.url);
      }
      // Compatibility with old archive messages that contain exactly one photo.
      if (message.attachments?.size === 1) {
        const archived = message.attachments.first();
        for (const marker of markerLookup) {
          const { photo } = marker;
          if (!urls.has(photo.attachment.url) &&
              (content.includes(marker.legacy) || content.includes(marker.hidden)) && archived?.url) {
            urls.set(photo.attachment.url, archived.url);
          }
        }
      }
    }
    before = batch.last().id;
    if (batch.size < 100 || photos.every(photo => urls.has(photo.attachment.url))) break;
  }

  const pending = photos.filter(photo => !urls.has(photo.attachment.url));
  const maxFilesPerMessage = 10;
  for (let offset = 0; offset < pending.length; offset += maxFilesPerMessage) {
    const group = pending.slice(offset, offset + maxFilesPerMessage);
    const files = group.map(photo => {
      const name = clean(photo.attachment.name || "foto-tiket.png", 150).replace(/[\\/]/g, "_");
      return { attachment: photo.attachment.url, name: "rap-" + photo.token + "-" + name };
    });
    const markers = group.map(photo => encodeInvisibleMarker(photo.token)).join("");
    const archivedMessage = await archiveChannel.send({
      content: "Foto tiket #" + baseName + " • " + group.length + " foto" + markers,
      files,
      allowedMentions: { parse: [], users: [], roles: [] },
    });
    for (const photo of group) {
      const prefix = "rap-" + photo.token + "-";
      const archived = archivedMessage.attachments?.find(item => String(item.name || "").startsWith(prefix));
      if (!archived?.url) {
        throw new Error("Discord tidak mengembalikan URL setelah mengarsipkan foto '" +
          clean(photo.attachment.name || "foto", 150) + "'. Tiket dipertahankan.");
      }
      urls.set(photo.attachment.url, archived.url);
    }
  }
  return urls;
}
export async function archiveAndDeleteTicket({ channel, ticket, client, closedBy = null, reason = "ticket_closed" }) {
  if (!channel || !ticket) throw new Error("Ticket channel and database record are required to archive.");
  const tickets = getDatabase().collection("tickets");
  const archiveId = clean(config.transcriptChannelId, 30);
  if (!archiveId) throw new Error("TRANSCRIPT_CHANNEL_ID is not configured; ticket deletion is blocked to prevent transcript loss.");
  const archiveChannel = await client.channels.fetch(archiveId).catch(error => {
    console.error("[ticket-archive-channel-fetch]", error?.message || error);
    return null;
  });
  if (!archiveChannel || typeof archiveChannel.send !== "function") throw new Error("TRANSCRIPT_CHANNEL_ID is not a sendable channel.");

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const archiveKey = "rapstore-ticket-" + String(ticket._id);
  const effectiveClosedBy = closedBy || ticket.archiveClosedBy || null;
  const effectiveReason = reason || ticket.closeReason || "ticket_closed";

  // Claim the ticket atomically so maintenance and manual commands cannot archive it concurrently.
  const claim = await tickets.updateOne({
    _id: ticket._id,
    status: { $in: ["open", "closing"] },
    $or: [
      { archiveProcessingAt: { $exists: false } },
      { archiveProcessingAt: { $lt: staleBefore } },
    ],
  }, {
    $set: {
      status: "closing",
      archiveProcessingAt: now,
      archiveKey,
      archiveClosedBy: effectiveClosedBy,
      closeReason: effectiveReason,
    },
  });
  if (!claim.modifiedCount) {
    const latest = await tickets.findOne({ _id: ticket._id });
    if (latest?.status === "closed" && latest.transcriptFileName) {
      await channel.delete("RapStore ticket already archived as " + latest.transcriptFileName).catch(error => {
        if (Number(error?.code) !== 10003) throw error;
      });
      return { filename: latest.transcriptFileName, messageId: latest.transcriptMessageId, alreadyArchived: true };
    }
    throw new Error("Ticket sedang diproses penutupannya oleh proses lain. Coba lagi setelah beberapa saat.");
  }

  try {
    const messages = [];
    let before;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      messages.push(...batch.values());
      if (messages.length > MAX_TRANSCRIPT_MESSAGES) {
        throw new Error("Transcript melebihi batas aman " + MAX_TRANSCRIPT_MESSAGES + " pesan. Channel dipertahankan; arsip perlu ditinjau manual.");
      }
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    const totalAttachmentBytes = messages.reduce((total, item) => total + [...(item.attachments?.values?.() || [])].reduce((sum, attachment) => sum + Math.max(0, Number(attachment.size) || 0), 0), 0);
    if (totalAttachmentBytes > MAX_TRANSCRIPT_ATTACHMENT_BYTES) {
      throw new Error("Total lampiran transcript melebihi batas aman 100 MB. Channel dipertahankan; arsip perlu ditinjau manual.");
    }
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const baseName = clean(ticket.ticketPrefix && Number.isInteger(ticket.ticketNumber)
      ? ticket.ticketPrefix + "-" + ticket.ticketNumber : channel.name.replace(/^closed-/, ""), 80).replace(/[^a-zA-Z0-9_-]/g, "-");
    const ticketCode = clean(ticket.ticketCode || "", 20).replace(/[^a-zA-Z0-9#$&!@%+_-]/g, "");
    // Copy image attachments into the transcript channel first, then use those new Discord CDN URLs in the HTML.
    // If any image cannot be archived, keep the original ticket so no proof/photo is lost.
    const archivedImageUrls = await archiveTicketImages(archiveChannel, messages, ticket, archiveKey, baseName);
    const messageById = new Map(messages.map(message => [message.id, message]));
    const rows = messages.map(message => {
      const author = message.member?.displayName || message.author?.globalName || message.author?.username || "Unknown";
      const avatar = message.author?.displayAvatarURL?.({ size: 64 }) || "";
      const botBadge = message.author?.bot ? '<span class="bot-badge">BOT</span>' : "";
      const timestamp = new Date(message.createdTimestamp).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const replyTo = message.reference?.messageId ? messageById.get(message.reference.messageId) : null;
      const reply = replyTo
        ? '<div class="reply-reference"><span class="reply-bar"></span><strong>' +
          escapeHtml(replyTo.member?.displayName || replyTo.author?.globalName || replyTo.author?.username || "Unknown") +
          '</strong> ' + escapeHtml(transcriptMessageText(replyTo).slice(0, 180) || "[pesan embed/lampiran]") + '</div>'
        : "";
      const text = transcriptMessageText(message);
      const componentsText = componentTranscriptText(message.components);
      const componentMedia = componentTranscriptMedia(message.components).map(item =>
        '<div class="component-media">' + transcriptImage(archivedImageUrls.get(item.url) || item.url, item.description) +
        (item.description ? '<div class="attachment-meta"><span>' + escapeHtml(item.description) + '</span></div>' : "") + '</div>'
      ).join("");
      const content = text ? '<div class="message-content">' + escapeHtml(text).replace(/\n/g, "<br>") + '</div>' : "";
      const componentPanel = componentsText.length
        ? '<div class="component-panel">' + componentsText.map(line => '<div>' + escapeHtml(line).replace(/\n/g, "<br>") + '</div>').join("") + '</div>'
        : "";
      const embeds = [...(message.embeds || [])].map(embed => renderTranscriptEmbed(embed, archivedImageUrls)).join("");
      const attachments = [...(message.attachments?.values?.() || [])].map(file => {
        if (!isImageAttachment(file)) {
          return '<div class="attachment-meta"><span>File tidak disimpan di arsip.</span></div>';
        }
        const url = safeHttpUrl(archivedImageUrls.get(file.url));
        if (!url) throw new Error("Foto '" + (file.name || "lampiran") + "' belum memiliki URL arsip. Tiket dipertahankan.");
        const name = file.name || "foto";
        const type = String(file.contentType || "image").toLowerCase();
        const preview = transcriptImage(url, name);
        return '<div class="attachment">' + preview +
          '<div class="attachment-meta">' + transcriptLink(url, name, "attachment-name") +
          '<span>' + escapeHtml(type) + (Number.isFinite(file.size) ? ' • ' + escapeHtml((file.size / 1024).toFixed(1)) + ' KB' : "") +
          '</span></div></div>';
      }).join("");
      const stickers = [...(message.stickers?.values?.() || [])].map(sticker =>
        '<div class="sticker-note">[Sticker: ' + escapeHtml(sticker.name) + ']</div>'
      ).join("");
      const systemClass = message.author?.bot ? " bot-message" : "";
      return '<article class="message' + systemClass + '">' +
        '<div class="avatar-wrap">' + (safeHttpUrl(avatar) ? '<img class="avatar" src="' + escapeHtml(avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<div class="avatar avatar-fallback">?</div>') + '</div>' +
        '<div class="message-main"><header class="message-header"><strong class="author-name">' + escapeHtml(author) +
        '</strong>' + botBadge + '<span class="username">' + escapeHtml(message.author?.tag || message.author?.username || "") +
        '</span><time>' + escapeHtml(timestamp) + '</time></header>' + reply + content + componentPanel + embeds +
        (attachments ? '<div class="attachments">' + attachments + '</div>' : "") + stickers + '</div></article>';
    }).join("\n");
    const guildName = channel.guild?.name || "Discord Server";
    const html = '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>' +
      escapeHtml(baseName) + ' — RapStore Transcript</title><style>' +
      ':root{color-scheme:dark;--bg:#313338;--panel:#2b2d31;--muted:#949ba4;--text:#dbdee1;--line:#3f4147;--accent:#5865f2}' +
      '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      '.topbar{position:sticky;top:0;z-index:5;background:#232428;border-bottom:1px solid #1e1f22;padding:16px 22px;box-shadow:0 2px 8px #0003}' +
      '.brand{font-weight:800;font-size:16px;color:#fff}.subtitle{font-size:12px;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}' +
      '.layout{max-width:1100px;margin:0 auto;padding:24px 22px 48px}.ticket-info{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:24px}' +
      '.ticket-title{font-size:20px;font-weight:750;color:#fff;margin-bottom:8px}.info-grid{display:flex;flex-wrap:wrap;gap:8px 20px;color:var(--muted);font-size:12px}.info-grid b{color:var(--text)}' +
      '.message{display:flex;gap:14px;padding:9px 10px;margin:0 -10px;border-radius:6px}.message:hover{background:#2e3035}.avatar-wrap{flex:0 0 40px}.avatar{width:40px;height:40px;object-fit:cover;border-radius:50%;background:#1e1f22}.avatar-fallback{display:grid;place-items:center;color:#fff;font-weight:700}' +
      '.message-main{min-width:0;flex:1}.message-header{display:flex;align-items:baseline;flex-wrap:wrap;gap:7px;margin:0 0 3px}.author-name{color:#f2f3f5;font-weight:650}.username,time{font-size:11px;color:var(--muted)}.bot-badge{background:#5865f2;color:#fff;font-size:9px;font-weight:800;padding:2px 4px;border-radius:3px;letter-spacing:.4px}' +
      '.message-content{white-space:normal;overflow-wrap:anywhere}.component-panel{margin-top:7px;padding:10px 12px;background:#2b2d31;border-left:4px solid var(--accent);border-radius:4px;overflow-wrap:anywhere}.component-panel>div+div{margin-top:4px}' +
      '.reply-reference{font-size:12px;color:var(--muted);margin:0 0 7px;display:flex;gap:6px;align-items:baseline;overflow-wrap:anywhere}.reply-reference strong{color:#c9cdfb;flex-shrink:0}.reply-bar{height:10px;width:28px;border-top:2px solid #6d6f78;border-left:2px solid #6d6f78;flex-shrink:0}' +
      '.discord-embed{position:relative;margin-top:8px;padding:12px 14px;background:#2b2d31;border-left:4px solid var(--embed-color);border-radius:4px;max-width:680px;overflow:hidden}.embed-author{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;margin-bottom:7px}.embed-author-icon{width:20px;height:20px;border-radius:50%;object-fit:cover}.embed-title{font-weight:700;color:#00a8fc;margin-bottom:5px;overflow-wrap:anywhere}.embed-title a,.embed-author a{color:#00a8fc;text-decoration:none}.embed-description,.embed-field-value{white-space:pre-wrap;overflow-wrap:anywhere}.embed-fields{display:flex}.embed-field{margin-top:10px}.embed-field-name{font-weight:700;margin-bottom:3px}.embed-image{display:block;max-width:min(100%,520px);max-height:420px;object-fit:contain;object-position:left;border-radius:4px;margin-top:10px}.embed-thumbnail{float:right;max-width:100px;max-height:100px;object-fit:contain;margin:0 0 8px 12px;border-radius:4px}.embed-footer{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:10px}.embed-footer-icon{width:18px;height:18px;border-radius:50%;object-fit:cover}' +
      '.component-media{margin-top:8px}.attachments{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}.attachment{max-width:100%;display:flex;flex-direction:column;gap:6px;align-items:flex-start}.attachment-image{display:block;max-width:min(100%,560px);max-height:560px;object-fit:contain;object-position:left top;border-radius:8px;border:1px solid #202127;background:#232428}.image-link{display:inline-block;max-width:100%}.attachment-meta{display:flex;flex-direction:column;gap:2px;font-size:12px}.attachment-name{color:#00a8fc;text-decoration:none;font-weight:600;overflow-wrap:anywhere}.attachment-meta span{color:var(--muted);font-size:11px}.file-icon{width:42px;height:42px;display:grid;place-items:center;background:#232428;border:1px solid var(--line);border-radius:6px;font-size:22px}.sticker-note{color:var(--muted);font-size:12px;margin-top:6px}' +
      '.footer{border-top:1px solid var(--line);padding-top:14px;margin-top:24px;color:var(--muted);font-size:11px;text-align:center}' +
      '@media(max-width:600px){.topbar{padding:13px 14px}.layout{padding:16px 14px 32px}.message{gap:9px}.avatar-wrap{flex-basis:34px}.avatar{width:34px;height:34px}.message-header{gap:5px}.username{display:none}.attachment-image{max-height:380px}.discord-embed{padding:10px}.ticket-title{font-size:18px}}' +
      '</style></head><body><div class="topbar"><div class="brand">💬 RapStore — Ticket Transcript</div><div class="subtitle">' +
      escapeHtml(guildName) + ' • #' + escapeHtml(channel.name) + '</div></div><main class="layout"><section class="ticket-info"><div class="ticket-title"># ' +
      escapeHtml(baseName) + '</div><div class="info-grid">' +
      (ticketCode ? '<span><b>ID Tiket:</b> ' + escapeHtml(ticketCode) + '</span>' : '') + '<span><b>Pesan:</b> ' + messages.length +
      '</span><span><b>Ditutup oleh:</b> ' + escapeHtml(effectiveClosedBy ? '<@' + effectiveClosedBy + '>' : "Sistem") +
      '</span><span><b>Alasan:</b> ' + escapeHtml(effectiveReason) + '</span><span><b>Waktu arsip:</b> ' +
      escapeHtml(new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })) + ' WIB</span></div></section>' +
      (rows || '<p>Channel ini tidak memiliki pesan yang dapat diarsipkan.</p>') +
      '<div class="footer">Transcript dibuat oleh RapStore Assistant • Tampilan arsip tidak dapat memuat ulang pesan yang sudah dihapus dari Discord.</div></main></body></html>';
    const filename = ticketCode
      ? baseName + "-" + ticketCode + ".html"
      : baseName + "-#" + transcriptSuffix() + ".html";

    // If a previous attempt uploaded the file but failed before saving its message ID,
    // search recent archive history for the stable marker before uploading again.
    let archivedMessage = null;
    if (ticket.status === "closing" || ticket.archiveKey) {
      let cursor;
      for (let page = 0; page < 10 && !archivedMessage; page++) {
        const batch = await archiveChannel.messages.fetch({ limit: 100, ...(cursor ? { before: cursor } : {}) });
        if (!batch.size) break;
        const legacyMarker = "[archive-key:" + archiveKey + "]";
        const hiddenMarker = encodeInvisibleMarker(legacyMarker);
        archivedMessage = batch.find(item => {
          const content = String(item.content || "");
          return content.includes(legacyMarker) || content.includes(hiddenMarker);
        }) || null;
        cursor = batch.last().id;
        if (batch.size < 100) break;
      }
    }
    if (!archivedMessage) {
      archivedMessage = await archiveChannel.send({
        content: "Transcript tiket **" + baseName + "** • " + messages.length + " pesan • ditutup oleh " +
          (effectiveClosedBy ? "<@" + effectiveClosedBy + ">" : "sistem") + "." +
          encodeInvisibleMarker("[archive-key:" + archiveKey + "]"),
        files: [new AttachmentBuilder(Buffer.from(html, "utf8"), { name: filename })],
        allowedMentions: { parse: [], users: [], roles: [] },
      });
    }
    const archivedFilename = archivedMessage.attachments?.first()?.name || filename;
    const saved = await tickets.updateOne(
      { _id: ticket._id, status: "closing", archiveKey },
      { $set: {
        status: "closed", closedAt: new Date(), closedBy: effectiveClosedBy, closeReason: effectiveReason,
        transcriptFileName: archivedFilename, transcriptChannelId: archiveChannel.id, transcriptMessageId: archivedMessage.id,
      }, $unset: { archiveProcessingAt: "" } },
    );
    if (!saved.modifiedCount) {
      const latest = await tickets.findOne({ _id: ticket._id });
      if (!(latest?.status === "closed" && latest.transcriptMessageId === archivedMessage.id)) {
        throw new Error("Transcript terkirim, tetapi status arsip belum berhasil disimpan. Tiket dipertahankan agar dapat dicoba ulang.");
      }
    }
    if (ticket.buyerId && channel.permissionOverwrites?.edit) {
      await channel.permissionOverwrites.edit(ticket.buyerId, { ViewChannel: false, SendMessages: false }).catch(error => {
        console.error("[ticket-archive-lock]", error?.message || error);
      });
    }
    try {
      await channel.delete("RapStore ticket archived as " + archivedFilename);
    } catch (error) {
      if (Number(error?.code) !== 10003) {
        throw new Error("TRANSCRIPT_SAVED_CHANNEL_DELETE_FAILED: " + (error?.message || "unknown Discord error"));
      }
    }
    return { filename: archivedFilename, messageId: archivedMessage.id, messageCount: messages.length };
  } catch (error) {
    await tickets.updateOne(
      { _id: ticket._id, status: "closing", archiveKey },
      { $unset: { archiveProcessingAt: "" } },
    ).catch(() => {});
    throw error;
  }
}

async function closeOrderTicketAfterVouch(order, client, closedBy = "system") {
  const db = getDatabase();
  if (order.ticketClosedAt) return true;
  const ticket = await db.collection("tickets").findOne({ guildId: order.guildId, channelId: order.channelId });
  if (!ticket) throw new Error("Data tiket tidak ditemukan; tiket dipertahankan untuk pemeriksaan manual.");
  const guild = await client.guilds.fetch(order.guildId);
  const channel = await guild.channels.fetch(order.channelId).catch(error => { if (Number(error?.code) === 10003) return null; throw error; });
  if (!channel) {
    if (ticket.status === "closed" && ticket.transcriptFileName) {
      await db.collection("orders").updateOne({ _id: order._id }, { $set: { ticketClosedAt: new Date(), updatedAt: new Date() }, $unset: { closeProcessingAt: "" } });
      return true;
    }
    throw new Error("Channel tiket tidak ditemukan sebelum transcript terverifikasi.");
  }
  if (ticket.status === "closed" && ticket.transcriptFileName) {
    await channel.delete("RapStore ticket already archived after vouch").catch(error => { if (Number(error?.code) !== 10003) throw error; });
  } else {
    await archiveAndDeleteTicket({ channel, ticket, client, closedBy, reason: "customer_vouch_submitted_auto_close" });
  }
  await db.collection("orders").updateOne({ _id: order._id }, { $set: { ticketClosedAt: new Date(), updatedAt: new Date() }, $unset: { closeProcessingAt: "" } });
  return true;
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
      const message = clean(vouch.message || "vouch otomatis setelah 1 jam.", 700).replace(/\r/g, "");
      const quotedMessage = message.split("\n").map(line => "> " + line).join("\n");
      const date = new Date(vouch.createdAt || Date.now()).toLocaleDateString("en-GB", {
        timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric",
      }).toUpperCase();
      const marker = "RAP-VOUCH-KEY:" + clean(vouch.orderCode || "legacy", 40);
      const hiddenMarker = encodeInvisibleMarker(marker);
      let existingMessage = null;
      let before;
      // A Discord send can succeed while the database write fails. Search recent archive history before retrying.
      for (let page = 0; page < 10 && !existingMessage; page++) {
        const recent = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!recent.size) break;
        existingMessage = recent.find(candidate => {
          try {
            return JSON.stringify(candidate.components.map(component => component.toJSON?.() ?? component)).includes(hiddenMarker);
          } catch {
            return false;
          }
        }) || null;
        before = recent.last().id;
        if (recent.size < 100) break;
      }
      const panel = new ContainerBuilder();
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("## RAP — CUSTOMER TESTIMONI\n-# VERIFIED TRANSACTION"));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "**CLIENT**\n<@" + vouch.buyerId + ">\n\n" +
        "**PRODUCT**\n" + clean(vouch.productName || "Produk RapStore", 100) + "\n\n" +
        "**RATING**\n" + stars + " (" + rating + "/5)\n\n" +
        "**PESAN & KESAN**\n" + quotedMessage,
      ));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("> Thank you for trusting **RAP**."));
      divider(panel);
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "-# Trusted. Fast. Secure. Professional.\n-# RAP TESTIMONI • " + date + hiddenMarker,
      ));
      const sent = existingMessage || await channel.send({
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
    const staleClosingTickets = await db.collection("tickets").find({
      status: "closing",
      $or: [
        { archiveProcessingAt: { $exists: false } },
        { archiveProcessingAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
      ],
    }).sort({ archiveProcessingAt: 1 }).limit(20).toArray();
    for (const staleTicket of staleClosingTickets) {
      try {
        const guild = await client.guilds.fetch(staleTicket.guildId);
        const channel = await guild.channels.fetch(staleTicket.channelId).catch(error => {
          if (Number(error?.code) === 10003) return null;
          throw error;
        });
        if (channel) {
          await archiveAndDeleteTicket({
            channel, ticket: staleTicket, client,
            closedBy: staleTicket.archiveClosedBy || "system",
            reason: staleTicket.closeReason || "recovered_incomplete_archive",
          });
        } else {
          const missingAt = new Date();
          await db.collection("tickets").updateOne({ _id: staleTicket._id, status: "closing" }, {
            $set: {
              status: "missing_channel",
              closeReason: "channel_missing_before_archive",
              closeBlockedAt: missingAt,
              missingChannelDetectedAt: missingAt,
              transcriptStatus: staleTicket.transcriptFileName ? "archived" : "unavailable",
            },
            $unset: { archiveProcessingAt: "" },
          });
          await db.collection("orders").updateMany({
            guildId: staleTicket.guildId,
            channelId: staleTicket.channelId,
            status: "DONE",
            ticketClosedAt: { $exists: false },
          }, {
            $set: {
              ticketCloseBlockedAt: missingAt,
              ticketCloseBlockedReason: staleTicket.transcriptFileName
                ? "channel_missing_after_transcript_archive"
                : "channel_missing_before_archive",
              ticketChannelMissingAt: missingAt,
              transcriptStatus: staleTicket.transcriptFileName ? "archived" : "unavailable",
              updatedAt: missingAt,
            },
            $unset: { closeProcessingAt: "" },
          });
          console.warn(
            "[ticket-archive-recovery] Ticket channel is missing; order data was preserved:",
            JSON.stringify({
              orderCode: staleTicket.ticketCode || null,
              channelId: staleTicket.channelId,
              transcriptStatus: staleTicket.transcriptFileName ? "archived" : "unavailable",
            }),
          );
        }
      } catch (error) {
        console.error("[ticket-archive-recovery]", staleTicket.channelId, error?.message || error);
      }
    }
    const alreadyArchived = await db.collection("tickets").find({
      status: "closed", transcriptFileName: { $exists: true }, channelId: { $exists: true },
    }).limit(50).toArray();
    for (const ticket of alreadyArchived) {
      const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
      const channel = guild ? await guild.channels.fetch(ticket.channelId).catch(() => null) : null;
      if (channel) {
        await channel.delete("RapStore ticket already archived as " + ticket.transcriptFileName)
          .catch(error => console.error("[ticket-delete-retry]", ticket.channelId, error?.message || error));
      }
    }
    const now = new Date();
    const dueOrders = await db.collection("orders").find({
      status: "DONE",
      $or: [{ autoCloseAt: { $lte: now } }, { vouchPublishedAt: { $exists: true } }],
      ticketClosedAt: { $exists: false },
      ticketCloseBlockedAt: { $exists: false },
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
        const guild = await client.guilds.fetch(candidate.guildId);
        const channel = await guild.channels.fetch(candidate.channelId).catch(error => {
          if (Number(error?.code) === 10003) return null;
          throw error;
        });
        const ticket = await db.collection("tickets").findOne({ guildId: candidate.guildId, channelId: candidate.channelId });
        if (channel && ticket && (ticket.status !== "closed" || !ticket.transcriptFileName)) {
          await archiveAndDeleteTicket({ channel, ticket, client, closedBy: "system", reason: "order_done_auto_close" });
        } else if (channel && ticket?.status === "closed" && ticket.transcriptFileName) {
          await channel.delete("RapStore ticket already archived as " + ticket.transcriptFileName);
        } else if (!channel) {
          const missingAt = new Date();
          const transcriptExists = Boolean(ticket?.transcriptFileName);
          if (ticket && !transcriptExists) {
            await db.collection("tickets").updateOne({ _id: ticket._id, transcriptFileName: { $exists: false } }, {
              $set: {
                status: "missing_channel",
                closedAt: missingAt,
                closeReason: "channel_missing_before_auto_close",
                closeBlockedAt: missingAt,
                missingChannelDetectedAt: missingAt,
                transcriptStatus: "unavailable",
              },
              $unset: { archiveProcessingAt: "" },
            });
          }
          if (transcriptExists) {
            await db.collection("orders").updateOne({ _id: candidate._id }, {
              $set: { ticketClosedAt: missingAt, transcriptStatus: "archived", updatedAt: missingAt },
              $unset: { closeProcessingAt: "", ticketCloseBlockedAt: "", ticketCloseBlockedReason: "" },
            });
            console.warn("[order-auto-close] Channel is missing, but transcript was already archived; order preserved:", candidate.orderCode, candidate.channelId);
            continue;
          }
          await db.collection("orders").updateOne({ _id: candidate._id }, {
            $set: {
              ticketCloseBlockedAt: missingAt,
              ticketCloseBlockedReason: "channel_missing_before_archive",
              ticketChannelMissingAt: missingAt,
              transcriptStatus: "unavailable",
              updatedAt: missingAt,
            },
            $unset: { closeProcessingAt: "" },
          });
          console.warn(
            "[order-auto-close] Ticket channel is missing; order data preserved and auto-close will not retry:",
            JSON.stringify({ orderCode: candidate.orderCode, channelId: candidate.channelId, transcriptStatus: "unavailable" }),
          );
          continue;
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

export async function initializeOrderTicket({ channel, interaction, ticketNumber, ticketId, ticketCode, selectedProduct }) {
  const db = getDatabase();
  const product = selectedProduct && selectedProduct.active !== false ? selectedProduct : null;
  const unitPrice = product ? Number(product.price || 0) : 0;
  if (product && (!Number.isSafeInteger(unitPrice) || unitPrice < 1)) throw new Error("Selected product has an invalid price.");
  const stableTicketCode = clean(ticketCode, 20);
  if (!stableTicketCode) throw new Error("A unique ticket code is required for every order.");
  const orderCode = stableTicketCode;
  const now = new Date();
  const result = await db.collection("orders").insertOne({
    orderCode, ticketCode: stableTicketCode, guildId: interaction.guildId, ticketId: String(ticketId), channelId: channel.id,
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
  await refreshOrderLog(order, interaction.client).catch(error => console.error("[order-log]", error?.message || error));
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
      await interaction.deferReply({ flags: V2 | EPHEMERAL });
      try {
        await db.collection("vouches").insertOne({
          orderId: String(order._id), orderCode: order.orderCode, guildId: order.guildId,
          channelId: order.channelId, buyerId: order.buyerId, productName: order.productName || "Produk RapStore",
          rating, message, automatic: false, status: "pending_publish", createdAt: new Date(),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        await interaction.editReply(v2(buildPanel("VOUCH SUDAH DICATAT", "Testimoni untuk transaksi ini sudah tercatat."), true));
        return;
      }
      await publishPendingVouches(client);
      const savedVouch = await db.collection("vouches").findOne({ orderId: String(order._id) });
      if (savedVouch?.status === "published") {
        try {
          await closeOrderTicketAfterVouch(order, client, interaction.user.id);
          await interaction.editReply(v2(buildPanel("VOUCH TERKIRIM — TIKET DITUTUP", "Terima kasih! Testimoni sudah dipublikasikan. Transcript HTML sudah dibuat dan tiket otomatis ditutup."), true));
        } catch (error) {
          console.error("[vouch-auto-close]", error?.message || error);
          await interaction.editReply(v2(buildPanel("VOUCH TERKIRIM — PENUTUPAN DIULANG OTOMATIS", "Testimoni sudah dipublikasikan. Transcript atau penghapusan channel belum selesai, jadi bot akan mencoba lagi otomatis. Channel tidak dihapus sebelum transcript tersimpan."), true));
        }
      } else {
        await interaction.editReply(v2(buildPanel("VOUCH TERSIMPAN", "Testimoni tersimpan, tetapi belum berhasil dipublikasikan. Bot akan mencoba kembali otomatis; tiket baru ditutup setelah vouch dan transcript berhasil diproses."), true));
      }
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
      const orderUpdate = await db.collection("orders").updateOne({
        _id: order._id, status: "ON HOLD", paymentStatus: "pending_review", latestProofId: String(proof._id),
      }, {
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
    const rejectedOrderUpdate = await db.collection("orders").updateOne({
      _id: order._id, status: "ON HOLD", paymentStatus: "pending_review", latestProofId: String(proof._id),
    }, {
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
    await refreshOrderLog(updated, client).catch(error => console.error("[order-log]", error?.message || error));
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
      const repriced = await db.collection("orders").updateOne({
        _id: order._id, status: "ON HOLD", paymentStatus: { $nin: ["verified", "pending_review"] },
      }, {
        $set: { unitPrice: livePrice, totalPrice: liveTotal, paymentMethod: null, paymentStatus: "unpaid", updatedAt: new Date() },
      });
      if (!repriced.modifiedCount) {
        await replyNotice(interaction, "STATUS BERUBAH", "Status pembayaran berubah saat permintaan diproses. Muat ulang panel sebelum mencoba lagi.");
        return;
      }
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
    const methodUpdate = await db.collection("orders").updateOne({
      _id: order._id, status: "ON HOLD", paymentStatus: { $nin: ["verified", "pending_review"] },
    }, {
      $set: { paymentMethod: method, paymentStatus: "unpaid", paymentMessageId: interaction.message.id, updatedAt: new Date() },
    });
    if (!methodUpdate.modifiedCount) {
      await replyNotice(interaction, "PEMBAYARAN TERKUNCI", "Bukti pembayaran atau perubahan status lain sudah masuk. Pilihan metode pembayaran tidak diubah.");
      return;
    }
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
    const selectionUpdate = await db.collection("orders").updateOne({
      _id: order._id, status: "ON HOLD", paymentStatus: { $nin: ["verified", "pending_review"] },
    }, { $set: changes });
    if (!selectionUpdate.modifiedCount) {
      await replyNotice(interaction, "PESANAN TERKUNCI", "Status pembayaran berubah saat pilihan diproses. Muat ulang panel pesanan.");
      return;
    }
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(await buildOrderPanel(updated));
    await refreshOrderLog(updated, client).catch(error => console.error("[order-log]", error?.message || error));
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
  const command = String(message.content || "").trim().toLowerCase();

  if (command === "!close") {
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!staff(member)) {
      await message.channel.send(v2(buildPanel("AKSES DITOLAK", "Command !close hanya bisa digunakan Founder/Admin."))).catch(() => {});
      return;
    }
    const ticket = await db.collection("tickets").findOne({
      guildId: message.guild.id, channelId: message.channel.id, status: "open",
    });
    if (!ticket) {
      await message.channel.send(v2(buildPanel("TIKET TIDAK DITEMUKAN", "Command !close hanya berlaku di tiket yang masih terbuka."))).catch(() => {});
      return;
    }
    // Explicit !close aborts an unfinished order so it cannot remain payable/processable after its ticket disappears.
    const activeOrders = await db.collection("orders").find({
      guildId: message.guild.id,
      channelId: message.channel.id,
      status: { $in: ["ON HOLD", "PROSES"] },
    }).toArray();
    if (activeOrders.length) {
      const orderIds = activeOrders.map(order => String(order._id));
      await db.collection("orders").updateMany({
        _id: { $in: activeOrders.map(order => order._id) },
        status: { $in: ["ON HOLD", "PROSES"] },
      }, {
        $set: {
          status: "CANCELLED",
          paymentStatus: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: message.author.id,
          cancelReason: "manual_ticket_close_command",
          updatedAt: new Date(),
        },
      });
      for (const activeOrder of activeOrders) {
        const cancelledOrder = await db.collection("orders").findOne({ _id: activeOrder._id });
        await refreshOrderLog(cancelledOrder, client).catch(error => console.error("[order-log]", error?.message || error));
      }
      await db.collection("payment_proofs").updateMany({
        orderId: { $in: orderIds },
        status: "pending",
      }, {
        $set: { status: "superseded", updatedAt: new Date(), supersededReason: "ticket_closed_manually" },
      });
      await message.channel.send(v2(buildPanel(
        "PESANAN DIBATALKAN",
        "Founder/Admin menutup tiket dengan !close. Pesanan yang belum selesai dibatalkan dan bukti pembayaran yang menunggu pemeriksaan dinonaktifkan. Transcript akan disimpan sebelum channel dihapus."
      ))).catch(() => {});
    }
    try {
      await archiveAndDeleteTicket({
        channel: message.channel, ticket, client,
        closedBy: message.author.id, reason: "manual_ticket_close_command",
      });
    } catch (error) {
      console.error("[ticket-archive-close-command]", error?.message || error);
      await message.channel.send(v2(buildPanel(
        "TRANSCRIPT BELUM TERSIMPAN",
        String(error?.message || "").startsWith("TRANSCRIPT_SAVED_CHANNEL_DELETE_FAILED:")
          ? "Transcript sudah tersimpan, tetapi bot belum bisa menghapus channel. Periksa izin Manage Channels; maintenance akan mencoba menghapusnya lagi."
          : "Tiket tidak dihapus karena transcript belum berhasil dipastikan tersimpan. Periksa TRANSCRIPT_CHANNEL_ID serta izin View Channel, Read Message History, Send Messages, Attach Files, dan Manage Channels untuk bot."
      ))).catch(() => {});
    }
    return;
  }

  if (command === "!done") {
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
    paymentStatus: { $in: ["unpaid", "rejected", null] },
  });
  if (!order) return;
  const attachments = [...message.attachments.values()].map(item => ({
    name: clean(item.name || "bukti-transfer", 200), url: item.url,
    contentType: clean(item.contentType || "", 100), size: Number(item.size || 0),
  }));
  if (!attachments.length) return;
  const validation = validateProofAttachments(attachments);
  if (!validation.ok) {
    await message.reply({ content: validation.reason, allowedMentions: { repliedUser: false } }).catch(() => {});
    return;
  }
  const proofResult = await db.collection("payment_proofs").insertOne({
    orderId: String(order._id), orderCode: order.orderCode, guildId: message.guild.id,
    channelId: message.channel.id, buyerId: message.author.id, messageId: message.id,
    attachments, status: "pending", createdAt: new Date(),
  });
  const claim = await db.collection("orders").updateOne({
    _id: order._id, status: "ON HOLD", paymentMethod: order.paymentMethod,
    paymentStatus: { $in: ["unpaid", "rejected", null] },
  }, {
    $set: { paymentStatus: "pending_review", latestProofId: String(proofResult.insertedId), updatedAt: new Date() },
  });
  if (!claim.modifiedCount) {
    await db.collection("payment_proofs").updateOne({ _id: proofResult.insertedId, status: "pending" }, {
      $set: { status: "superseded", updatedAt: new Date(), supersededReason: "order_state_changed" },
    });
    return;
  }
  await db.collection("payment_proofs").updateMany(
    { orderId: String(order._id), _id: { $ne: proofResult.insertedId }, status: "pending" },
    { $set: { status: "superseded", updatedAt: new Date() } },
  );
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
