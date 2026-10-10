import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { connectDatabase, closeDatabase, getDatabase } from "./database.js";
import { refreshGlobalCommands } from "./global-commands.js";
import { buildMessage, buildComponentsOnly, buildPanel } from "./ui.js";

let client;
let shuttingDown = false;
const EPHEMERAL = MessageFlags.Ephemeral;

function v2Payload(payload) {
  const flags = payload?.flags ?? 0;
  return buildMessage(payload?.content ?? "", { ephemeral: Boolean(flags & MessageFlags.Ephemeral) });
}
function v2EditPayload(content) {
  return buildComponentsOnly(content);
}
function v2SendPayload(content) {
  return buildMessage(content);
}

function logError(context, error) {
  console.error(`[${context}]`, error instanceof Error ? error.message : "Unknown error");
}

function hasStaffRole(member) {
  return Boolean(member?.roles?.cache?.has(config.ids.founderRole) ||
    member?.roles?.cache?.has(config.ids.adminRole));
}
function hasResellerRole(member) {
  const roleId = config.ids.resellerRole;
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}
function priceForMember(product, member) {
  const retail = Number(product.price);
  const reseller = Number.isSafeInteger(product.resellerPrice) && product.resellerPrice > 0 ? product.resellerPrice : retail;
  return hasResellerRole(member) ? reseller : retail;
}
function isFounder(member) {
  return Boolean(member?.roles?.cache?.has(config.ids.founderRole));
}
async function requireStaff(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Command ini hanya untuk Admin/Founder di server.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return false;
  }
  return true;
}
async function audit(action, interaction, details = {}) {
  try {
    await getDatabase().collection("audit_logs").insertOne({
      action, actorId: interaction.user.id, guildId: interaction.guildId,
      details, createdAt: new Date(),
    });
  } catch (error) { logError("audit", error); }
}
function orderCode() {
  return `RS-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}
function safeText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
async function findOrder(code) {
  return getDatabase().collection("orders").findOne({ orderCode: safeText(code, 30) });
}
async function sendDelivery(order, interaction) {
  const db = getDatabase();
  if (!["paid", "delivery_partial", "delivery_failed", "delivered"].includes(order.status)) {
    throw new Error("Order belum disetujui pembayarannya oleh admin.");
  }
  if (!Array.isArray(order.allocatedStock) || order.allocatedStock.length !== order.quantity) {
    throw new Error("Alokasi stok order tidak lengkap; hentikan pengiriman dan periksa database.");
  }
  const payload = order.allocatedStock.map((item, i) => `${i + 1}. ${item.code}`).join("\n");
  let dmOk = false;
  let ticketOk = false;
  if (order.delivery?.dmOk) dmOk = true;
  else {
    try {
      const user = await client.users.fetch(order.buyerId);
      await user.send(v2SendPayload(`Pengiriman RapStore — ${order.orderCode}\nProduk: ${order.productName}\n\n${payload}\n\nSimpan data ini dengan aman.`));
      dmOk = true;
    } catch { /* User DMs can be closed; ticket delivery is attempted separately. */ }
  }
  if (order.delivery?.ticketOk) ticketOk = true;
  else if (order.channelId) {
    try {
      const channel = await client.channels.fetch(order.channelId);
      if (channel?.isTextBased()) {
        await channel.send(v2SendPayload(`Pengiriman produk untuk <@${order.buyerId}> — ${order.orderCode}\n${payload}`));
        ticketOk = true;
      }
    } catch { /* Persist delivery status below so staff can retry. */ }
  }
  const complete = dmOk && ticketOk;
  const status = complete ? "delivered" : (dmOk || ticketOk ? "delivery_partial" : "delivery_failed");
  await db.collection("orders").updateOne(
    { _id: order._id, status: { $in: ["paid", "delivery_partial", "delivery_failed", "delivered"] } },
    { $set: { status, delivery: { dmOk, ticketOk, lastAttemptAt: new Date() }, updatedAt: new Date() } },
  );
  await audit("order.delivery_attempt", interaction, { orderCode: order.orderCode, dmOk, ticketOk, status });
  return { dmOk, ticketOk, status };
}


async function showFounderPanel(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Panel hanya untuk Founder/Admin.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  const panel = buildPanel("🛠️ RAPSTORE — PANEL STAFF", "Pilih tindakan. Semua perubahan hanya bisa dilakukan Founder/Admin.", ["Tambah/edit produk mengatur nama, kategori, deskripsi, harga retail, dan harga reseller.", "Tambah stok membuka input item digital satu per baris.", "Gunakan /catalog untuk melihat katalog pembeli."]);
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:add").setLabel("Tambah Produk").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:edit").setLabel("Edit Produk").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:stock").setLabel("Tambah Stok").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:list").setLabel("Daftar Produk").setStyle(ButtonStyle.Secondary)
  ));
  await interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
}
async function handleFounderPanelButton(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({ content: "Akses ditolak.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
  const action = interaction.customId.split(":").pop();
  if (action === "add") {
    const modal = new ModalBuilder().setCustomId("rapstore:panelmodal:add").setTitle("Tambah Produk");
    const specs = [["nama","Nama produk",TextInputStyle.Short,true,100],["harga","Harga retail (Rupiah)",TextInputStyle.Short,true,12],["harga_reseller","Harga reseller (Rupiah)",TextInputStyle.Short,true,12],["kategori","Kategori",TextInputStyle.Short,true,80],["deskripsi","Deskripsi",TextInputStyle.Paragraph,false,500]];
    for (const [id,label,style,required,max] of specs) modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max)));
    await interaction.showModal(modal); return;
  }
  const db = getDatabase();
  if (action === "list") {
    const list = await db.collection("products").find({}).sort({ name: 1 }).limit(15).toArray();
    const lines = await Promise.all(list.map(async p => { const stock = await db.collection("stock_items").countDocuments({ productId: String(p._id), status: "available" }); return "• " + safeText(p.name, 80) + " [" + (p.active ? "aktif" : "nonaktif") + "]\nID: " + p._id + "\nKategori: " + safeText(p.category || "Umum",80) + " • Retail " + formatPrice(p.price) + " • Reseller " + formatPrice(p.resellerPrice || p.price) + " • Stok " + stock; }));
    await interaction.reply(v2Payload({ content: lines.join("\n\n").slice(0,3800) || "Belum ada produk.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return;
  }
  if (action === "edit" || action === "stock") {
    const products = await db.collection("products").find(action === "stock" ? {active:true} : {}).sort({name:1}).limit(25).toArray();
    if (!products.length) { await interaction.reply(v2Payload({content:"Belum ada produk yang tersedia.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const menu = new StringSelectMenuBuilder().setCustomId("rapstore:panelchoose:" + action).setPlaceholder("Pilih produk").setMinValues(1).setMaxValues(1).addOptions(products.map(p => ({label:safeText(p.name,100),value:String(p._id),description:(formatPrice(p.price) + " • " + (p.active?"aktif":"nonaktif")).slice(0,100)})));
    const panel = buildPanel(action === "edit" ? "EDIT PRODUK" : "TAMBAH STOK", "Pilih produk dari daftar."); panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    await interaction.reply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
  }
}
async function handleFounderPanelSelect(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  const {ObjectId} = await import("mongodb"); const id=interaction.values[0]; if(!ObjectId.isValid(id)){await interaction.reply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
  const db=getDatabase(); const product=await db.collection("products").findOne({_id:new ObjectId(id)}); if(!product){await interaction.reply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
  const action=interaction.customId.split(":").pop();
  if(action==="edit"){
    const modal=new ModalBuilder().setCustomId("rapstore:panelmodal:edit:"+id).setTitle("Edit Produk");
    const specs=[["nama","Nama produk",TextInputStyle.Short,true,100,product.name],["harga","Harga retail",TextInputStyle.Short,true,12,String(product.price)],["harga_reseller","Harga reseller",TextInputStyle.Short,true,12,String(product.resellerPrice||product.price)],["kategori","Kategori",TextInputStyle.Short,true,80,product.category||"Umum"],["deskripsi","Deskripsi",TextInputStyle.Paragraph,false,500,product.description||""]];
    for(const [cid,label,style,required,max,value] of specs) modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setValue(String(value).slice(0,max))));
    await interaction.showModal(modal); return;
  }
  const modal=new ModalBuilder().setCustomId("rapstore:panelmodal:stock:"+id).setTitle("Tambah Stok"); modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("items").setLabel("Satu item per baris (maks 3500 karakter)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3500))); await interaction.showModal(modal);
}
async function handleFounderPanelModal(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  const db=getDatabase(); const parts=interaction.customId.split(":");
  if(parts[2]==="add"||parts[2]==="edit"){
    const name=safeText(interaction.fields.getTextInputValue("nama"),100); const price=Number(interaction.fields.getTextInputValue("harga")); const resellerPrice=Number(interaction.fields.getTextInputValue("harga_reseller")); const category=safeText(interaction.fields.getTextInputValue("kategori")||"Umum",80)||"Umum"; const description=safeText(interaction.fields.getTextInputValue("deskripsi")||"",500);
    if(!name||!Number.isSafeInteger(price)||price<1||!Number.isSafeInteger(resellerPrice)||resellerPrice<1||resellerPrice>price){await interaction.reply(v2Payload({content:"Input tidak valid. Harga harus positif dan harga reseller tidak boleh lebih tinggi dari retail.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    if(parts[2]==="add"){const now=new Date();const result=await db.collection("products").insertOne({name,price,resellerPrice,category,description,active:true,currency:"IDR",createdAt:now,updatedAt:now,createdBy:interaction.user.id});await audit("product.created",interaction,{productId:String(result.insertedId),source:"panel"});await interaction.reply(v2Payload({content:"Produk berhasil dibuat. ID: "+result.insertedId,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    const {ObjectId}=await import("mongodb");const id=parts[3];if(!ObjectId.isValid(id)){await interaction.reply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}const result=await db.collection("products").updateOne({_id:new ObjectId(id)},{$set:{name,price,resellerPrice,category,description,updatedAt:new Date(),updatedBy:interaction.user.id}});if(!result.matchedCount){await interaction.reply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}await audit("product.updated",interaction,{productId:id,source:"panel"});await interaction.reply(v2Payload({content:"Produk berhasil diperbarui.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;
  }
  if(parts[2]==="stock"){const {ObjectId}=await import("mongodb");const id=parts[3];const product=ObjectId.isValid(id)?await db.collection("products").findOne({_id:new ObjectId(id),active:true}):null;if(!product){await interaction.reply(v2Payload({content:"Produk aktif tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}const items=[...new Set(interaction.fields.getTextInputValue("items").split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];if(!items.length||items.length>100||items.some(x=>x.length>1000)){await interaction.reply(v2Payload({content:"Masukkan 1–100 item unik, maksimal 1000 karakter per item.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}try{await db.collection("stock_items").insertMany(items.map(code=>({productId:String(product._id),code,status:"available",createdAt:new Date(),createdBy:interaction.user.id})),{ordered:true});}catch(error){if(error?.code===11000){await interaction.reply(v2Payload({content:"Item duplikat terdeteksi; sebagian item mungkin sudah masuk. Periksa stok sebelum mencoba ulang.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}throw error;}await audit("stock.added",interaction,{productId:id,count:items.length,source:"panel"});await interaction.reply(v2Payload({content:"Berhasil menambahkan "+items.length+" item stok.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));}
}
async function handleCatalogSelection(interaction) {
  await interaction.deferUpdate();
  const db = getDatabase();
  if (interaction.customId === "rapstore:catalog:category") {
    const category = safeText(interaction.values[0], 80);
    const categoryFilter = category === "Umum" ? { active: true, $or: [{ category: "Umum" }, { category: { $exists: false } }, { category: null }, { category: "" }] } : { active: true, category };
    const list = await db.collection("products").find(categoryFilter).sort({ name: 1 }).limit(25).toArray();
    if (!list.length) {
      await interaction.editReply(v2EditPayload("Kategori ini belum memiliki produk aktif. Jalankan /catalog untuk mulai lagi."));
      return;
    }
    const menu = new StringSelectMenuBuilder().setCustomId("rapstore:catalog:product")
      .setPlaceholder("Pilih produk").setMinValues(1).setMaxValues(1)
      .addOptions(await Promise.all(list.map(async product => {
        const stock = await db.collection("stock_items").countDocuments({ productId: String(product._id), status: "available" });
        return { label: safeText(product.name, 100), value: String(product._id), description: (formatPrice(product.price) + " • stok " + stock).slice(0, 100) };
      })));
    const panel = buildPanel("🛍️ " + category, "Pilih produk untuk melihat harga dan stok.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
    return;
  }
  if (interaction.customId === "rapstore:catalog:product") {
    const { ObjectId } = await import("mongodb");
    const id = interaction.values[0];
    if (!ObjectId.isValid(id)) {
      await interaction.editReply(v2EditPayload("ID produk tidak valid. Jalankan /catalog lagi."));
      return;
    }
    const product = await db.collection("products").findOne({ _id: new ObjectId(id), active: true });
    if (!product) {
      await interaction.editReply(v2EditPayload("Produk tidak ditemukan atau sudah nonaktif. Jalankan /catalog lagi."));
      return;
    }
    const stock = await db.collection("stock_items").countDocuments({ productId: String(product._id), status: "available" });
    const retail = Number(product.price);
    const reseller = Number.isSafeInteger(product.resellerPrice) && product.resellerPrice > 0 ? product.resellerPrice : retail;
    const selectedPrice = priceForMember(product, interaction.member);
    const tierLabel = hasResellerRole(interaction.member) ? "HARGA RESELLER" : "HARGA RETAIL";
    const availabilityLabel = stock > 0 ? "🟢 Tersedia" : "🔴 Stok habis";
    const panel = buildPanel("🛍️ RAPSTORE  /  DETAIL PRODUK", "**" + safeText(product.name, 100) + "**", [
      safeText(product.description || "Produk digital berkualitas dari RapStore.", 1000),
      "📂 **Kategori**\n" + safeText(product.category || "Umum", 80),
      "💳 **Harga produk**\n" + tierLabel + ": **" + formatPrice(selectedPrice) + "**\nRetail: " + formatPrice(retail) + "  •  Reseller: " + formatPrice(reseller),
      "📦 **Ketersediaan**\n" + availabilityLabel + "  ·  Stok: **" + stock + "**",
      "🔐 Harga reseller otomatis berlaku jika akun memiliki role Reseller.",
    ]);
    const rows = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rapstore:catalog:order:" + String(product._id)).setLabel("Order Sekarang").setStyle(ButtonStyle.Success).setDisabled(stock < 1),
      new ButtonBuilder().setCustomId("rapstore:catalog:back").setLabel("Pilih Produk Lain").setStyle(ButtonStyle.Secondary)
    );
    panel.addActionRowComponents(rows);
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
  }
}
function formatPrice(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID");
}

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:catalog:")) {
    if (interaction.customId === "rapstore:catalog:back") {
      await interaction.deferUpdate();
      const db = getDatabase();
      const products = db.collection("products");
      const categories = await products.distinct("category", { active: true });
      const legacyCount = await products.countDocuments({ active: true, $or: [{ category: { $exists: false } }, { category: null }, { category: "" }] });
      const normalized = [...new Set([...categories.map(category => safeText(category || "Umum", 80)), ...(legacyCount ? ["Umum"] : [])].filter(Boolean))].sort();
      if (!normalized.length) return void await interaction.editReply(v2EditPayload("Katalog belum memiliki produk aktif."));
      const menu = new StringSelectMenuBuilder().setCustomId("rapstore:catalog:category").setPlaceholder("Pilih kategori").setMinValues(1).setMaxValues(1)
        .addOptions(normalized.slice(0, 25).map(category => ({ label: category.slice(0, 100), value: category, description: "Lihat produk kategori ini" })));
      const panel = buildPanel("🛍️ RAPSTORE CATALOG", "Pilih kategori untuk melihat daftar produk. Harga otomatis mengikuti role Discord.");
      panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
      await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
      return;
    }
    if (interaction.customId.startsWith("rapstore:catalog:order:")) {
      const productId = interaction.customId.split(":").pop();
      await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Untuk menjaga alur stok dan pembayaran tetap aman, jalankan **/order_create** lalu masukkan ID produk berikut:\n`" + productId + "`\nPilih jumlah yang diinginkan. Harga retail/reseller akan dihitung otomatis berdasarkan role Discord." }));
      return;
    }
  }
  if (interaction.isButton() && interaction.customId.startsWith("rapstore:panel:")) { await handleFounderPanelButton(interaction); return; }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rapstore:panelchoose:")) { await handleFounderPanelSelect(interaction); return; }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("rapstore:panelmodal:")) { await handleFounderPanelModal(interaction); return; }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rapstore:catalog:")) {
    await handleCatalogSelection(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const db = getDatabase();
  const products = db.collection("products");
  const orders = db.collection("orders");

  if (interaction.commandName === "ping") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    try {
      await db.command({ ping: 1 });
      await interaction.editReply(v2EditPayload("🟢 RapStore Assistant aktif. Discord dan MongoDB Atlas terhubung."));
    } catch (error) { logError("ping", error); await interaction.editReply(v2EditPayload("🔴 Pemeriksaan database gagal.")); }
    return;
  }
  if (interaction.commandName === "store") {
    await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: [
      "**RapStore Assistant**", "Pembayaran dilakukan manual melalui QR GoPay Merchant.",
      "Bukti transfer tidak otomatis membuktikan dana diterima; admin harus memverifikasi transaksi.",
      "Gunakan /catalog untuk melihat kategori dan produk, lalu /order_create untuk membuat order.",
    ].join("\n") }));
    return;
  }
  if (interaction.commandName === "panel") { await showFounderPanel(interaction); return; }
  if (interaction.commandName === "catalog") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const categories = await products.distinct("category", { active: true });
    const legacyCount = await products.countDocuments({ active: true, $or: [{ category: { $exists: false } }, { category: null }, { category: "" }] });
    const normalized = [...new Set([...categories.map(category => safeText(category || "Umum", 80)), ...(legacyCount ? ["Umum"] : [])].filter(Boolean))].sort();
    if (!normalized.length) {
      await interaction.editReply(v2EditPayload("Katalog masih kosong. Staff bisa menambah produk dengan /product_add."));
      return;
    }
    const menu = new StringSelectMenuBuilder().setCustomId("rapstore:catalog:category")
      .setPlaceholder("Pilih kategori").setMinValues(1).setMaxValues(1)
      .addOptions(normalized.slice(0, 25).map(category => ({ label: category.slice(0, 100), value: category, description: "Lihat produk kategori ini" })));
    const panel = buildPanel("🛒 RAPSTORE CATALOG", "Pilih kategori untuk melihat produk. Harga reseller berlaku otomatis berdasarkan role Discord.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
    return;
  }
  if (interaction.commandName === "product_add") {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const name = safeText(interaction.options.getString("nama", true), 100);
    const price = interaction.options.getInteger("harga", true);
    const resellerPrice = interaction.options.getInteger("harga_reseller") ?? price;
    const category = safeText(interaction.options.getString("kategori") || "Umum", 80) || "Umum";
    const description = safeText(interaction.options.getString("deskripsi") || "", 500);
    const sku = safeText(interaction.options.getString("sku") || "", 40).toUpperCase();
    if (!name || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(resellerPrice) || resellerPrice < 1 || resellerPrice > price) return void await interaction.editReply(v2EditPayload("Nama/harga tidak valid. Harga reseller harus lebih dari 0 dan tidak boleh melebihi harga retail."));
    const doc = { name, price, resellerPrice, category, description, active: true, currency: "IDR", createdAt: new Date(), updatedAt: new Date(), createdBy: interaction.user.id };
    if (sku) doc.sku = sku;
    try {
      const result = await products.insertOne(doc);
      await audit("product.created", interaction, { productId: String(result.insertedId), sku: sku || null });
      await interaction.editReply(v2EditPayload(`Produk ditambahkan. ID produk: \`${result.insertedId}\``));
    } catch (error) {
      if (error?.code === 11000) await interaction.editReply(v2EditPayload("SKU sudah digunakan. Pilih SKU lain."));
      else throw error;
    }
    return;
  }

  if (interaction.commandName === "product_manage") {
    if (!await requireStaff(interaction)) return;
    const id = safeText(interaction.options.getString("produk_id") || "", 30);
    const active = interaction.options.getBoolean("aktif");
    if (!id) {
      const list = await products.find({}).sort({ createdAt: -1 }).limit(15).toArray();
      return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: list.length
        ? list.map(p => `• \`${p._id}\` — **${safeText(p.name, 80)}** — Rp ${Number(p.price).toLocaleString("id-ID")} — ${p.active ? "aktif" : "nonaktif"}`).join("\n").slice(0, 1900)
        : "Belum ada produk." }));
    }
    if (active === null) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Isi opsi aktif untuk mengubah status produk." }));
    const { ObjectId } = await import("mongodb");
    if (!ObjectId.isValid(id)) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "ID produk tidak valid." }));
    const result = await products.updateOne({ _id: new ObjectId(id) }, { $set: { active, updatedAt: new Date(), updatedBy: interaction.user.id } });
    if (!result.matchedCount) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Produk tidak ditemukan." }));
    await audit("product.status_changed", interaction, { productId: id, active });
    await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: `Status produk diubah menjadi ${active ? "aktif" : "nonaktif"}.` }));
    return;
  }

  if (interaction.commandName === "stock_add") {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const productId = safeText(interaction.options.getString("produk_id", true), 30);
    const raw = interaction.options.getString("items", true);
    const { ObjectId } = await import("mongodb");
    if (!ObjectId.isValid(productId)) return void await interaction.editReply(v2EditPayload("ID produk tidak valid."));
    const product = await products.findOne({ _id: new ObjectId(productId), active: true });
    if (!product) return void await interaction.editReply(v2EditPayload("Produk aktif tidak ditemukan."));
    const items = [...new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (!items.length || items.length > 100) return void await interaction.editReply(v2EditPayload("Masukkan 1–100 item unik, satu item per baris."));
    if (items.some(s => s.length > 1000)) return void await interaction.editReply(v2EditPayload("Setiap item stok maksimal 1000 karakter."));
    const now = new Date();
    try {
      await db.collection("stock_items").insertMany(items.map(code => ({
        productId: String(product._id), code, status: "available", createdAt: now, createdBy: interaction.user.id,
      })), { ordered: true });
      await audit("stock.added", interaction, { productId, count: items.length });
      await interaction.editReply(v2EditPayload(`Berhasil menambahkan ${items.length} item stok ke produk ${safeText(product.name, 80)}. Jangan bagikan isi stok di channel publik.`));
    } catch (error) {
      if (error?.code === 11000) await interaction.editReply(v2EditPayload("Ada item duplikat pada stok ini. Tidak semua item mungkin tersimpan; periksa stok sebelum mencoba lagi."));
      else throw error;
    }
    return;
  }

  if (interaction.commandName === "order_create") {
    if (!interaction.inGuild()) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Order hanya bisa dibuat di server." }));
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const productId = safeText(interaction.options.getString("produk_id", true), 30);
    const quantity = interaction.options.getInteger("jumlah", true);
    const { ObjectId } = await import("mongodb");
    if (!ObjectId.isValid(productId)) return void await interaction.editReply(v2EditPayload("ID produk tidak valid. Buka /catalog untuk melihat produk."));
    const product = await products.findOne({ _id: new ObjectId(productId), active: true });
    if (!product) return void await interaction.editReply(v2EditPayload("Produk tidak ditemukan atau sedang nonaktif."));
    const available = await db.collection("stock_items").countDocuments({ productId, status: "available" });
    if (available < quantity) return void await interaction.editReply(v2EditPayload(`Stok tidak cukup. Tersedia: ${available}.`));
    const code = orderCode();
    let channel;
    try {
      channel = await interaction.guild.channels.create({
        name: `order-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12) || "buyer"}`,
        type: ChannelType.GuildText,
        parent: config.ids.orderCategory || undefined,
        topic: `RapStore order ${code}; buyer ${interaction.user.id}`,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: config.ids.founderRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: config.ids.adminRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ],
      });
      const now = new Date();
      const order = {
        orderCode: code, guildId: interaction.guildId, buyerId: interaction.user.id,
        productId, productName: product.name, quantity,
        unitPrice: priceForMember(product, interaction.member),
        priceTier: hasResellerRole(interaction.member) ? "reseller" : "retail",
        total: priceForMember(product, interaction.member) * quantity, currency: "IDR", status: "pending_payment",
        channelId: channel.id, createdAt: now, updatedAt: now,
      };
      await orders.insertOne(order);
      await channel.send(v2SendPayload(`**RapStore — Order ${code}**\nPembeli: <@${interaction.user.id}>\nProduk: **${safeText(product.name, 100)}**\nJumlah: **${quantity}**\nTotal: **Rp ${order.total.toLocaleString("id-ID")}**\n\nLakukan pembayaran melalui QR GoPay Merchant resmi toko. Kirim bukti menggunakan /payment_submit kode_order:${code}. Admin harus memverifikasi dana secara manual. Jangan mengirim ulang bukti ke pengguna lain.`));
      await audit("order.created", interaction, { orderCode: code, productId, quantity, total: order.total });
      await interaction.editReply(v2EditPayload(`Order dibuat: **${code}** — total Rp ${order.total.toLocaleString("id-ID")}. Tiket: <#${channel.id}>.`));
    } catch (error) {
      if (channel) await channel.delete("Order creation failed").catch(() => {});
      throw error;
    }
    return;
  }

  if (interaction.commandName === "payment_submit") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const code = safeText(interaction.options.getString("kode_order", true), 30);
    const attachment = interaction.options.getAttachment("bukti", true);
    const order = await findOrder(code);
    if (!order || order.buyerId !== interaction.user.id) return void await interaction.editReply(v2EditPayload("Order tidak ditemukan atau bukan milik lo."));
    if (!["pending_payment", "payment_rejected"].includes(order.status)) return void await interaction.editReply(v2EditPayload(`Order tidak menerima bukti baru dalam status ${order.status}.`));
    if (!attachment.contentType?.startsWith("image/") || attachment.size > 8 * 1024 * 1024) return void await interaction.editReply(v2EditPayload("Bukti harus berupa gambar maksimal 8 MB."));
    const proof = { orderCode: code, orderId: order._id, buyerId: interaction.user.id, attachmentUrl: attachment.url, contentType: attachment.contentType, size: attachment.size, status: "pending_review", createdAt: new Date() };
    await db.collection("payment_proofs").insertOne(proof);
    if (order.status === "payment_rejected") {
      const reopened = await orders.updateOne(
        { _id: order._id, status: "payment_rejected" },
        { $set: { status: "pending_payment", updatedAt: new Date() } },
      );
      if (!reopened.modifiedCount) {
        await db.collection("payment_proofs").updateOne(
          { orderId: order._id, status: "pending_review", createdAt: proof.createdAt },
          { $set: { status: "superseded", note: "Order status changed during resubmission." } },
        );
        return void await interaction.editReply(v2EditPayload("Status order berubah. Muat ulang tiket dan hubungi staff sebelum mengirim bukti lagi."));
      }
    }
    const reviewChannel = await client.channels.fetch(config.ids.paymentReviewChannel).catch(() => null);
    if (reviewChannel?.isTextBased()) {
      await reviewChannel.send(v2SendPayload(`**Bukti pembayaran perlu diperiksa**\nOrder: ${code}\nPembeli: <@${interaction.user.id}>\nTotal: Rp ${Number(order.total).toLocaleString("id-ID")}\nBukti: ${attachment.url}\nGunakan /payment_review kode_order:${code} keputusan:approve atau reject setelah memeriksa transaksi di akun merchant.`));
    }
    await audit("payment.proof_submitted", interaction, { orderCode: code });
    await interaction.editReply(v2EditPayload("Bukti terkirim untuk pemeriksaan. Screenshot bukan konfirmasi dana masuk; tunggu admin memverifikasi transaksi."));
    return;
  }

  if (interaction.commandName === "payment_review") {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const code = safeText(interaction.options.getString("kode_order", true), 30);
    const decision = interaction.options.getString("keputusan", true);
    const note = safeText(interaction.options.getString("catatan") || "", 300);
    const order = await findOrder(code);
    if (!order) return void await interaction.editReply(v2EditPayload("Order tidak ditemukan."));
    if (order.status !== "pending_payment") return void await interaction.editReply(v2EditPayload(`Order sudah diproses atau tidak bisa direview (status: ${order.status}).`));
    const proof = await db.collection("payment_proofs").findOne({ orderCode: code, status: "pending_review" }, { sort: { createdAt: -1 } });
    if (!proof) return void await interaction.editReply(v2EditPayload("Tidak ada bukti pembayaran yang menunggu review."));
    if (decision === "reject") {
      await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "pending_review" }, { $set: { status: "rejected", reviewedBy: interaction.user.id, reviewedAt: new Date(), note } });
      await orders.updateOne({ _id: order._id, status: "pending_payment" }, { $set: { status: "payment_rejected", updatedAt: new Date() } });
      await client.users.fetch(order.buyerId).then(user => user.send(v2SendPayload(`Bukti pembayaran order ${code} ditolak admin. Catatan: ${note || "Hubungi admin melalui tiket."}`))).catch(() => {});
      await audit("payment.rejected", interaction, { orderCode: code, note });
      return void await interaction.editReply(v2EditPayload(`Bukti untuk ${code} ditolak. Order perlu ditangani ulang secara manual.`));
    }
    const reservation = [];
    for (let i = 0; i < order.quantity; i++) {
      const stock = await db.collection("stock_items").findOneAndUpdate(
        { productId: order.productId, status: "available" },
        { $set: { status: "reserved", reservedFor: code, reservedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );
      if (!stock) {
        for (const item of reservation) await db.collection("stock_items").updateOne({ _id: item._id, status: "reserved", reservedFor: code }, { $set: { status: "available" }, $unset: { reservedFor: "", reservedAt: "" } });
        return void await interaction.editReply(v2EditPayload("Stok habis saat reservasi. Pembayaran belum disetujui; eskalasikan ke Founder dan jangan mengulang review tanpa rekonsiliasi."));
      }
      reservation.push(stock);
    }
    const changed = await orders.updateOne({ _id: order._id, status: "pending_payment" }, {
      $set: { status: "paid", allocatedStock: reservation.map(s => ({ stockId: s._id, code: s.code })), paidAt: new Date(), reviewedBy: interaction.user.id, updatedAt: new Date() },
    });
    if (!changed.modifiedCount) {
      for (const item of reservation) await db.collection("stock_items").updateOne({ _id: item._id, status: "reserved", reservedFor: code }, { $set: { status: "available" }, $unset: { reservedFor: "", reservedAt: "" } });
      return void await interaction.editReply(v2EditPayload("Status order berubah saat diproses. Stok dilepas; periksa order secara manual."));
    }
    await db.collection("stock_items").updateMany({ _id: { $in: reservation.map(s => s._id) }, status: "reserved", reservedFor: code }, { $set: { status: "sold", soldAt: new Date() } });
    await db.collection("payment_proofs").updateOne({ _id: proof._id, status: "pending_review" }, { $set: { status: "approved", reviewedBy: interaction.user.id, reviewedAt: new Date(), note } });
    await audit("payment.approved", interaction, { orderCode: code, quantity: reservation.length });
    const result = await sendDelivery({ ...order, status: "paid", allocatedStock: reservation.map(s => ({ stockId: s._id, code: s.code })) }, interaction);
    await interaction.editReply(v2EditPayload(`Pembayaran ${code} disetujui dan pengiriman dicoba. DM: ${result.dmOk ? "berhasil" : "gagal"}; tiket: ${result.ticketOk ? "berhasil" : "gagal"}. Gunakan /order_deliver untuk retry pengiriman yang gagal.`));
    return;
  }

  if (interaction.commandName === "order_deliver") {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const order = await findOrder(interaction.options.getString("kode_order", true));
    if (!order) return void await interaction.editReply(v2EditPayload("Order tidak ditemukan."));
    if (!["paid", "delivery_partial", "delivery_failed", "delivered"].includes(order.status)) return void await interaction.editReply(v2EditPayload("Pembayaran order belum disetujui."));
    const result = await sendDelivery(order, interaction);
    await interaction.editReply(v2EditPayload(`Pengiriman dicoba ulang untuk ${order.orderCode}. DM: ${result.dmOk ? "berhasil" : "gagal"}; tiket: ${result.ticketOk ? "berhasil" : "gagal"}. Stok yang sama dipakai, tidak dialokasikan ulang.`));
    return;
  }

  if (interaction.commandName === "ticket_close") {
    if (!interaction.inGuild() || !interaction.channel?.isTextBased()) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Gunakan command ini di channel tiket." }));
    const topic = interaction.channel.topic || "";
    const order = await db.collection("orders").findOne({ channelId: interaction.channelId });
    const isBuyer = order?.buyerId === interaction.user.id;
    if (!isBuyer && !hasStaffRole(interaction.member)) return void await interaction.reply(v2Payload({ flags: EPHEMERAL | MessageFlags.IsComponentsV2, content: "Hanya pemilik order atau staff yang bisa menutup tiket." }));
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }).catch(() => {});
    if (order?.buyerId) {
      await interaction.channel.permissionOverwrites.edit(order.buyerId, { ViewChannel: false, SendMessages: false }).catch(() => {});
    }
    if (order) await orders.updateOne({ _id: order._id }, { $set: { ticketLockedAt: new Date(), ticketLockedBy: interaction.user.id, updatedAt: new Date() } });
    await interaction.channel.send(v2SendPayload(`Tiket dikunci oleh <@${interaction.user.id}>. Pengarsipan belum otomatis; staff dapat memindahkan channel ke kategori arsip setelah pemeriksaan.`)).catch(() => {});
    await interaction.editReply(v2EditPayload("Tiket dikunci. Order tidak otomatis dianggap selesai."));
    await audit("ticket.locked", interaction, { channelId: interaction.channelId, orderCode: order?.orderCode || null, topic: safeText(topic, 100) });
    return;
  }

  if (interaction.commandName === "vouch") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const code = safeText(interaction.options.getString("kode_order", true), 30);
    const rating = interaction.options.getInteger("rating", true);
    const testimonial = safeText(interaction.options.getString("ulasan", true), 700);
    const order = await findOrder(code);
    if (!order || order.buyerId !== interaction.user.id || order.status !== "delivered") return void await interaction.editReply(v2EditPayload("Vouch hanya tersedia untuk pemilik order yang status pengirimannya delivered."));
    try {
      await db.collection("vouches").insertOne({ orderId: order._id, orderCode: code, buyerId: interaction.user.id, rating, testimonial, createdAt: new Date() });
    } catch (error) {
      if (error?.code === 11000) return void await interaction.editReply(v2EditPayload("Order ini sudah memiliki vouch."));
      throw error;
    }
    const channel = await client.channels.fetch(config.ids.vouchChannel).catch(() => null);
    if (channel?.isTextBased()) await channel.send(v2SendPayload(`**Vouch RapStore**\nRating: ${"⭐".repeat(rating)}\nPembeli: <@${interaction.user.id}>\nOrder: ${code}\n${testimonial}`));
    await audit("vouch.created", interaction, { orderCode: code, rating });
    await interaction.editReply(v2EditPayload("Terima kasih, vouch berhasil dicatat."));
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  client?.destroy();
  try { await closeDatabase(); } catch (error) { logError("shutdown", error); process.exitCode = 1; }
}

async function main() {
  await connectDatabase(config.mongoUri, config.mongoDbName);
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, interaction => {
    void handleInteraction(interaction).catch(async error => {
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
        logError("interaction-error-response", replyError);
      }
    });
  });
  client.once(Events.ClientReady, readyClient => console.log(`Logged in as ${readyClient.user.tag}; MongoDB Atlas ready.`));
  await client.login(config.discordToken);
  try {
    await refreshGlobalCommands();
  } catch (error) {
    logError("global-command-refresh", error);
    console.error("Bot tetap berjalan, tetapi command global belum berhasil diperbarui. Jalankan npm run commands:refresh setelah memperbaiki error.");
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
