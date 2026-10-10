import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events,
  GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, SeparatorBuilder, TextDisplayBuilder, TextInputBuilder,
  TextInputStyle,
} from "discord.js";
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
function v2EditPayload(content) { return buildComponentsOnly(content); }
function v2SendPayload(content) { return buildMessage(content); }
function logError(context, error) { console.error(`[${context}]`, error instanceof Error ? error.message : "Unknown error"); }
function hasStaffRole(member) {
  return Boolean(member?.roles?.cache?.has(config.ids.founderRole) || member?.roles?.cache?.has(config.ids.adminRole));
}
async function audit(action, interaction, details = {}) {
  try { await getDatabase().collection("audit_logs").insertOne({ action, actorId: interaction.user.id, guildId: interaction.guildId, details, createdAt: new Date() }); }
  catch (error) { logError("audit", error); }
}
function safeText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
async function showFounderPanel(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({ content: "Panel hanya untuk Founder/Admin.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    return;
  }
  const panel = buildPanel("RAPSTORE — PANEL KATALOG", "Kelola nama, kategori, deskripsi, dan harga produk. Panel ini hanya untuk Founder/Admin.", ["Gunakan /catalog untuk melihat tampilan katalog pembeli."]);
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:add").setLabel("Tambah Produk").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:edit").setLabel("Edit Produk").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:list").setLabel("Daftar Produk").setStyle(ButtonStyle.Secondary)
  ));
  await interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
}
async function handleFounderPanelButton(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({ content: "Akses ditolak.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return; }
  const action = interaction.customId.split(":").pop();
  if (action === "add") {
    const modal = new ModalBuilder().setCustomId("rapstore:panelmodal:add").setTitle("Tambah Produk");
    const specs = [["nama","Nama produk",TextInputStyle.Short,true,100],["harga","Harga (Rupiah)",TextInputStyle.Short,true,12],["kategori","Kategori",TextInputStyle.Short,true,80],["deskripsi","Deskripsi",TextInputStyle.Paragraph,false,500]];
    for (const [id,label,style,required,max] of specs) modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max)));
    await interaction.showModal(modal); return;
  }
  const db = getDatabase();
  if (action === "list") {
    const list = await db.collection("products").find({}).sort({ name: 1 }).limit(15).toArray();
    const lines = list.map(p => "• " + safeText(p.name, 80) + " [" + (p.active ? "aktif" : "nonaktif") + "]\nID: " + p._id + "\nKategori: " + safeText(p.category || "Umum",80) + " • Harga " + formatPrice(p.price));
    await interaction.reply(v2Payload({ content: lines.join("\n\n").slice(0,3800) || "Belum ada produk.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 })); return;
  }
  if (action === "edit") {
    const products = await db.collection("products").find({}).sort({name:1}).limit(25).toArray();
    if (!products.length) { await interaction.reply(v2Payload({content:"Belum ada produk yang tersedia.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
    const menu = new StringSelectMenuBuilder().setCustomId("rapstore:panelchoose:edit").setPlaceholder("Pilih produk").setMinValues(1).setMaxValues(1).addOptions(products.map(p => ({label:safeText(p.name,100),value:String(p._id),description:(formatPrice(p.price) + " • " + (p.active?"aktif":"nonaktif")).slice(0,100)})));
    const panel = buildPanel("EDIT PRODUK", "Pilih produk dari daftar."); panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
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
    const specs=[["nama","Nama produk",TextInputStyle.Short,true,100,product.name],["harga","Harga",TextInputStyle.Short,true,12,String(product.price)],["kategori","Kategori",TextInputStyle.Short,true,80,product.category||"Umum"],["deskripsi","Deskripsi",TextInputStyle.Paragraph,false,500,product.description||""]];
    for(const [cid,label,style,required,max,value] of specs) modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setValue(String(value).slice(0,max))));
    await interaction.showModal(modal); return;
  }
  await interaction.reply(v2Payload({content:"Aksi panel tidak dikenal.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
}
async function handleFounderPanelModal(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  const db=getDatabase(); const parts=interaction.customId.split(":");
  if(parts[2]==="add"||parts[2]==="edit"){
    const name=safeText(interaction.fields.getTextInputValue("nama"),100); const price=Number(interaction.fields.getTextInputValue("harga")); const category=safeText(interaction.fields.getTextInputValue("kategori")||"Umum",80)||"Umum"; const description=safeText(interaction.fields.getTextInputValue("deskripsi")||"",500);
    if(!name||!Number.isSafeInteger(price)||price<1){await interaction.reply(v2Payload({content:"Nama produk dan harga wajib valid. Harga harus berupa angka positif.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    if(parts[2]==="add"){const now=new Date();const result=await db.collection("products").insertOne({name,price,category,description,active:true,currency:"IDR",createdAt:now,updatedAt:now,createdBy:interaction.user.id});await audit("product.created",interaction,{productId:String(result.insertedId),source:"panel"});await interaction.reply(v2Payload({content:"Produk berhasil dibuat. ID: "+result.insertedId,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    const {ObjectId}=await import("mongodb");const id=parts[3];if(!ObjectId.isValid(id)){await interaction.reply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}const result=await db.collection("products").updateOne({_id:new ObjectId(id)},{$set:{name,price,category,description,updatedAt:new Date(),updatedBy:interaction.user.id}});if(!result.matchedCount){await interaction.reply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}await audit("product.updated",interaction,{productId:id,source:"panel"});await interaction.reply(v2Payload({content:"Produk berhasil diperbarui.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;
  }
}
async function catalogData(db) {
  const products = db.collection("products");
  const categories = await products.distinct("category", { active: true });
  const legacyCount = await products.countDocuments({ active: true, $or: [{ category: { $exists: false } }, { category: null }, { category: "" }] });
  const normalized = [...new Set([...categories.map(category => safeText(category || "Umum", 80)), ...(legacyCount ? ["Umum"] : [])].filter(Boolean))].sort();
  return { categories: normalized, products };
}

async function renderCatalogPanel(interaction, selectedCategory = "", selectedProductId = "") {
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
    lines.push("**Category:** " + category, "");
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
        lines.push("**" + displayName + "**");
        lines.push("**Harga:** `" + formatPrice(retail).replace(/^Rp\s*/, "Rp") + "`", "");
      }
    }
  }

  const panel = buildPanel("");
  panel.addTextDisplayComponents(new TextDisplayBuilder().setContent("### 🛍️ RAPSTORE — CATALOG"));
  panel.addSeparatorComponents(new SeparatorBuilder());
  panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n").slice(0, 3900)));
  panel.addSeparatorComponents(new SeparatorBuilder());

  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:catalog:category")
    .setPlaceholder(category ? ("Kategori: " + category).slice(0, 150) : "Pilih Kategori")
    .setMinValues(1).setMaxValues(1)
    .addOptions((categories.length ? categories : ["Belum ada kategori"]).slice(0, 25).map(c => ({
      label: c.slice(0, 100),
      value: c,
      description: "Buka katalog kategori " + c,
      default: Boolean(category) && c === category,
    })));
  if (!categories.length) categoryMenu.setDisabled(true);

  const productMenu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:catalog:product")
    .setPlaceholder(selectedProduct ? safeText(selectedProduct.name, 150) : "Pilih Produk")
    .setMinValues(1).setMaxValues(1);
  const productOptions = list.slice(0, 25).map(p => ({
    label: safeText(p.name, 100),
    value: String(p._id),
    description: ("Lihat informasi produk • " + formatPrice(p.price)).slice(0, 100),
    default: Boolean(selectedProduct) && String(p._id) === String(selectedProduct._id),
  }));
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
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] });
}

async function handleCatalogSelection(interaction) {
  await interaction.deferUpdate();
  const db = getDatabase();
  if (interaction.customId === "rapstore:catalog:category") {
    await renderCatalogPanel(interaction, safeText(interaction.values[0], 80));
    return;
  }
  if (interaction.customId === "rapstore:catalog:product") {
    const id = interaction.values[0];
    if (id === "none") {
      await interaction.followUp(v2Payload({ content: "Pilih kategori terlebih dahulu, lalu pilih produk.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const { ObjectId } = await import("mongodb");
    if (!ObjectId.isValid(id)) {
      await interaction.followUp(v2Payload({ content: "Produk tidak valid. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const product = await db.collection("products").findOne({ _id: new ObjectId(id), active: true });
    if (!product) {
      await interaction.followUp(v2Payload({ content: "Produk tidak ditemukan atau sudah tidak aktif. Silakan pilih ulang.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    await renderCatalogPanel(interaction, safeText(product.category || "Umum", 80), id);
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
    if (selectedProductId && ObjectId.isValid(selectedProductId)) {
      selectedProduct = await db.collection("products").findOne({ _id: new ObjectId(selectedProductId), active: true });
    }
    const existing = await db.collection("tickets").findOne({
      guildId: interaction.guildId,
      buyerId: interaction.user.id,
      type: ticketType,
      status: "open",
    });
    if (existing) {
      await interaction.followUp(v2Payload({ content: "Lu sudah punya tiket yang masih terbuka: <#" + existing.channelId + ">.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
      return;
    }
    const isOrder = ticketType === "order_now";
    const channel = await interaction.guild.channels.create({
      name: (isOrder ? "order-" : "tanya-produk-") + (interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12) || "buyer"),
      type: ChannelType.GuildText,
      parent: config.ids.supportCategory || undefined,
      topic: "RapStore " + ticketType + "; buyer " + interaction.user.id,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: config.ids.founderRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: config.ids.adminRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ],
    });
    try {
      await db.collection("tickets").insertOne({
        guildId: interaction.guildId,
        buyerId: interaction.user.id,
        channelId: channel.id,
        type: ticketType,
        productId: selectedProduct ? String(selectedProduct._id) : null,
        productName: selectedProduct ? safeText(selectedProduct.name, 100) : null,
        status: "open",
        createdAt: new Date(),
      });
      const productLine = selectedProduct ? "\nProduk yang dipilih: **" + safeText(selectedProduct.name, 100) + "**" : "\nProduk belum dipilih dari katalog.";
      const intro = isOrder
        ? "**RAPSTORE — ORDER SEKARANG**\nHalo <@" + interaction.user.id + ">! Staf akan membantu melanjutkan pemesanan lu."
        : "**RAPSTORE — TANYA-TANYA DULU**\nHalo <@" + interaction.user.id + ">! Silakan tulis pertanyaan produk lu di sini.";
      await channel.send(v2SendPayload(intro + productLine + "\n\nJangan kirim password atau data sensitif."));
      await interaction.followUp(v2Payload({ content: "✓ Tiket berhasil dibuat: <#" + channel.id + ">.", flags: EPHEMERAL | MessageFlags.IsComponentsV2 }));
    } catch (error) {
      await channel.delete("Failed to initialize catalog ticket").catch(() => {});
      throw error;
    }
  }
}
function formatPrice(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID");
}

async function handleInteraction(interaction) {
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
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    await renderCatalogPanel(interaction);
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
