import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
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
  const categoryOptions = categories.map(name => ({
    label: name.slice(0, 100), value: name, description: ("Pilih kategori " + name).slice(0, 100),
    default: Boolean(order.category) && name === order.category,
  }));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    makeSelect("rapstore:order:category", order.category ? "Kategori: " + order.category : "Pilih Kategori", categoryOptions, locked),
  ));
  const productOptions = products.map(product => ({
    label: clean(product.name, 100) || "Produk",
    value: String(product._id),
    description: (price(product.price) + " • pilih produk ini").slice(0, 100),
    default: Boolean(order.productId) && String(product._id) === order.productId,
  }));
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
        "Diperiksa oleh <@" + interaction.user.id + ">.\nPesanan **" + clean(order.orderCode, 40) + "** sekarang berstatus **PROSES**.",
      )));
      const channel = await interaction.guild.channels.fetch(order.channelId).catch(() => null);
      if (channel) await channel.send(v2(buildPanel(
        "PEMBAYARAN TERVERIFIKASI",
        "Bukti transfer diterima oleh Founder/Admin. Pesanan **" + clean(order.orderCode, 40) + "** sekarang berstatus **PROSES**.",
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
      "Diperiksa oleh <@" + interaction.user.id + ">.\nPengguna telah diminta mengirim ulang bukti transfer.",
    )));
    const channel = await interaction.guild.channels.fetch(order.channelId).catch(() => null);
    if (channel) await channel.send(v2(buildPanel(
      "BUKTI TRANSFER TIDAK VALID",
      "<@" + order.buyerId + ">, bukti transfer sebelumnya tidak dapat diverifikasi. Silakan kirim ulang bukti yang jelas dan sesuai nominal. Status pesanan tetap **ON HOLD**.",
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
    await db.collection("tickets").updateOne(
      { guildId: interaction.guildId, channelId: interaction.channelId, status: "open" },
      { $set: { status: "closed", closedAt: new Date(), closedBy: interaction.user.id, closeReason: "order_cancelled" } },
    );
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(v2(buildPanel("PESANAN DIBATALKAN", "Status pesanan **" + clean(order.orderCode, 40) + "** berubah menjadi **CANCELLED**. Tiket sedang ditutup.")));
    const channel = interaction.channel;
    if (order.orderMessageId) {
      const message = await channel.messages.fetch(order.orderMessageId).catch(() => null);
      if (message) await message.edit(await buildOrderPanel(updated)).catch(() => {});
    }
    await channel.permissionOverwrites.edit(order.buyerId, { ViewChannel: false, SendMessages: false }).catch(() => {});
    if (!channel.name.startsWith("closed-")) await channel.setName(("closed-" + channel.name).slice(0, 100)).catch(() => {});
    await channel.send(v2(buildPanel("PESANAN DIBATALKAN", "Pesanan dibatalkan oleh <@" + interaction.user.id + "> dan tiket telah ditutup.")));
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
    const completed = await db.collection("orders").updateOne({ _id: order._id, status: "PROSES" }, {
      $set: { status: "DONE", completedAt: new Date(), completedBy: interaction.user.id, updatedAt: new Date() },
    });
    if (!completed.modifiedCount) {
      await replyNotice(interaction, "STATUS BERUBAH", "Pesanan tidak lagi berstatus PROSES. Muat ulang panel dan coba lagi.");
      return;
    }
    const updated = await db.collection("orders").findOne({ _id: order._id });
    await interaction.update(await buildOrderPanel(updated));
    await interaction.channel.send(v2(buildPanel("PESANAN SELESAI", "Pesanan **" + clean(order.orderCode, 40) + "** telah ditandai **DONE** oleh Founder/Admin.")));
    await db.collection("audit_logs").insertOne({
      action: "order.completed", actorId: interaction.user.id, guildId: interaction.guildId,
      details: { orderId: String(order._id), orderCode: order.orderCode }, createdAt: new Date(),
    }).catch(() => {});
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
  if (!message?.guild || message.author?.bot || !message.channel || !message.attachments?.size) return;
  const db = getDatabase();
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
