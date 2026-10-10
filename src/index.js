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
function buildCategoryModal(action, current = null) {
  const modal=new ModalBuilder().setCustomId("rapstore:panelmodal:category:"+action+(current?":"+encodeCategory(current.name):"")).setTitle(action==="add"?"Tambah Kategori":"Edit Kategori");
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
  if (!map.has("Umum")) map.set("Umum","");
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(0,25).map(([name,emoji])=>({name,emoji}));
}
function encodeCategory(category) { return Buffer.from(category, "utf8").toString("base64url"); }
function decodeCategory(encoded) { try { return Buffer.from(encoded, "base64url").toString("utf8"); } catch { return ""; } }
async function showCategoryPicker(interaction, mode, productId = "", responseMode = "reply") {
  const categories = await getProductCategories();
  const menu = new StringSelectMenuBuilder()
    .setCustomId("rapstore:panelchoose:" + mode + (productId ? ":" + productId : ""))
    .setPlaceholder("Pilih kategori")
    .setMinValues(1).setMaxValues(1)
    .addOptions(categories.map(category => ({
      label: ((category.emoji ? category.emoji + " " : "") + category.name).slice(0, 100),
      value: encodeCategory(category.name),
      description: "Gunakan kategori ini",
    })));
  const panel = buildPanel("PILIH KATEGORI", "Pilih kategori yang sudah ada. Untuk membuat atau mengganti nama kategori, gunakan tombol kategori di panel utama.");
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  const payload = { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [panel] };
  if (responseMode === "editReply") await interaction.editReply(payload);
  else if (responseMode === "followUp") await interaction.followUp(payload);
  else await interaction.reply(payload);
}
function buildProductModal(action, category, product = null, allowNewCategory = false) {
  const suffix = product ? ":" + String(product._id) : "";
  const categoryToken = category ? ":" + encodeCategory(category) : "";
  const modal = new ModalBuilder().setCustomId("rapstore:panelmodal:" + action + suffix + categoryToken).setTitle(action === "add" ? "Tambah Produk" : "Edit Produk");
  const specs = [
    ["nama","Nama produk",TextInputStyle.Short,true,100,product?.name || ""],
    ["harga","Harga (Rupiah)",TextInputStyle.Short,true,12,product ? String(product.price) : ""],
    ["emoji_produk","Emoji produk (opsional)",TextInputStyle.Short,false,100,product?.emoji || ""],
  ];
  if (allowNewCategory) specs.push(["kategori","Kategori baru",TextInputStyle.Short,true,80,product?.category || "Umum"]);
  specs.push(["deskripsi","Deskripsi",TextInputStyle.Paragraph,false,500,product?.description || ""]);
  for (const [id,label,style,required,max,value] of specs) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) input.setValue(String(value).slice(0,max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}
async function showFounderPanel(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) {
    await interaction.reply(v2Payload({content:"Panel hanya untuk Founder/Admin.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return;
  }
  const panel = buildPanel("RAPSTORE — PANEL KATALOG", "Kelola kategori dan produk katalog.", []);
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:addcategory").setLabel("Add Kategori").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:editcategory").setLabel("Edit Kategori").setStyle(ButtonStyle.Secondary)
  ));
  panel.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rapstore:panel:add").setLabel("Tambah Produk").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rapstore:panel:edit").setLabel("Edit Produk").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rapstore:panel:list").setLabel("Daftar Produk").setStyle(ButtonStyle.Secondary)
  ));
  await interaction.reply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
}
async function handleFounderPanelButton(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  const action = interaction.customId.split(":").pop();
  if (action === "addcategory") { await interaction.showModal(buildCategoryModal("add")); return; }
  if (action === "editcategory") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const categories = await getProductCategories();
    if (!categories.length) {
      await interaction.editReply(v2Payload({content:"Belum ada kategori.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId("rapstore:panelchoose:editcategorymanage")
      .setPlaceholder("Pilih kategori yang ingin diedit")
      .setMinValues(1).setMaxValues(1)
      .addOptions(categories.slice(0,25).map(cat=>({label:((cat.emoji?cat.emoji+" ":"")+cat.name).slice(0,100),value:encodeCategory(cat.name)})));
    const panel = buildPanel("EDIT KATEGORI","Pilih kategori yang ingin diubah.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    await interaction.editReply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
    return;
  }
  if (action === "add") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    await showCategoryPicker(interaction, "addcategory", "", "editReply");
    return;
  }
  const db = getDatabase();
  if (action === "list") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const list = await db.collection("products").find({}).sort({name:1}).limit(15).toArray();
    const lines = list.map(p => "• " + safeText(p.name,80) + " [" + (p.active?"aktif":"nonaktif") + "]\nKategori: " + safeText(p.category||"Umum",80) + " • Harga " + formatPrice(p.price));
    await interaction.editReply(v2Payload({content:lines.join("\n\n").slice(0,3800)||"Belum ada produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
    return;
  }
  if (action === "edit") {
    await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    const products = await db.collection("products").find({}).sort({name:1}).limit(25).toArray();
    if (!products.length) {
      await interaction.editReply(v2Payload({content:"Belum ada produk yang tersedia.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const menu = new StringSelectMenuBuilder().setCustomId("rapstore:panelchoose:editproduct").setPlaceholder("Pilih produk").setMinValues(1).setMaxValues(1).addOptions(products.map(p=>({label:safeText(p.name,100),value:String(p._id),description:(safeText(p.category||"Umum",80)+" • "+formatPrice(p.price)).slice(0,100)})));
    const panel=buildPanel("EDIT PRODUK","Pilih produk yang ingin diubah.");
    panel.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    await interaction.editReply({flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral,components:[panel]});
  }
}
async function handleFounderPanelSelect(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  const parts=interaction.customId.split(":");
  const mode=parts[2];
  if (mode === "addcategory") {
    const chosen=decodeCategory(interaction.values[0]);
    await interaction.showModal(buildProductModal("add",chosen)); return;
  }
  if (mode === "editcategorymanage") {
    const name=decodeCategory(interaction.values[0]);
    const current=await getDatabase().collection("categories").findOne({name});
    await interaction.showModal(buildCategoryModal("edit",{name,emoji:current?.emoji||""})); return;
  }
  const {ObjectId}=await import("mongodb");
  if (mode === "editproduct") {
    await interaction.deferUpdate();
    const id = interaction.values[0];
    if (!ObjectId.isValid(id)) {
      await interaction.followUp(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    const product = await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if (!product) {
      await interaction.followUp(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
      return;
    }
    await showCategoryPicker(interaction, "editcategory", id, "followUp");
    return;
  }
  if (mode === "editcategory") {
    const id=parts[3], chosen=interaction.values[0];
    if(!ObjectId.isValid(id)){await interaction.reply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    const product=await getDatabase().collection("products").findOne({_id:new ObjectId(id)});
    if(!product){await interaction.reply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    await interaction.showModal(buildProductModal("edit",chosen==="__new__"?"":decodeCategory(chosen),product,chosen==="__new__")); return;
  }
  await interaction.reply(v2Payload({content:"Pilihan kategori tidak dikenal.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
}
async function handleFounderPanelModal(interaction) {
  if (!interaction.inGuild() || !hasStaffRole(interaction.member)) { await interaction.reply(v2Payload({content:"Akses ditolak.",flags:EPHEMERAL|MessageFlags.IsComponentsV2})); return; }
  await interaction.deferReply({ flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
  const db=getDatabase(), parts=interaction.customId.split(":");
  if(parts[2]==="category"){
    const categoryAction=parts[3];
    const name=safeText(interaction.fields.getTextInputValue("nama_kategori"),80);
    const emoji=safeText(interaction.fields.getTextInputValue("emoji_kategori")||"",100);
    if(!name){await interaction.editReply(v2Payload({content:"Nama kategori wajib diisi.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    const collection=db.collection("categories");
    if(categoryAction==="add"){
      const existing=await collection.findOne({name});
      if(existing){await interaction.editReply(v2Payload({content:"Kategori itu sudah ada. Gunakan Edit Kategori untuk mengubahnya.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
      await collection.insertOne({name,emoji,createdAt:new Date(),createdBy:interaction.user.id});
      await interaction.editReply(v2Payload({content:"Kategori **"+(emoji?emoji+" ":"")+name+"** berhasil dibuat. Sekarang kategori tersedia di dropdown Tambah Produk.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;
    }
    const oldName=decodeCategory(parts[4]||"");
    if(!oldName){await interaction.editReply(v2Payload({content:"Kategori lama tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    if(name!==oldName && await collection.findOne({name})){await interaction.editReply(v2Payload({content:"Nama kategori itu sudah digunakan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
    await collection.updateOne({name:oldName},{$set:{name,emoji,updatedAt:new Date(),updatedBy:interaction.user.id}},{upsert:true});
    if(name!==oldName) await db.collection("products").updateMany({category:oldName},{$set:{category:name,categoryEmoji:emoji,updatedAt:new Date()}});
    else await db.collection("products").updateMany({category:name},{$set:{categoryEmoji:emoji,updatedAt:new Date()}});
    await interaction.editReply(v2Payload({content:"Kategori berhasil diperbarui.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;
  }
  const action=parts[2];
  if(action!=="add"&&action!=="edit") return;
  const name=safeText(interaction.fields.getTextInputValue("nama"),100);
  const price=Number(interaction.fields.getTextInputValue("harga"));
  const categoryToken=action==="add" ? parts[3] : parts[4];
  const categoryField=interaction.fields.fields?.get("kategori");
  const category=safeText(categoryField ? interaction.fields.getTextInputValue("kategori") : decodeCategory(categoryToken)||"Umum",80)||"Umum";
  const description=safeText(interaction.fields.getTextInputValue("deskripsi")||"",500);
  const emoji=safeText(interaction.fields.getTextInputValue("emoji_produk")||"",100);
  if(!name||!Number.isSafeInteger(price)||price<1||!category){await interaction.editReply(v2Payload({content:"Nama, kategori, dan harga wajib valid. Harga harus berupa angka positif.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
  if(action==="add"){
    const now=new Date();const result=await db.collection("products").insertOne({name,price,category,emoji,description,active:true,currency:"IDR",createdAt:now,updatedAt:now,createdBy:interaction.user.id});
    await audit("product.created",interaction,{productId:String(result.insertedId),source:"panel"});
    await interaction.editReply(v2Payload({content:"Produk berhasil dibuat dalam kategori **"+category+"**. ID: "+result.insertedId,flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;
  }
  const id=parts[3];const {ObjectId}=await import("mongodb");
  if(!ObjectId.isValid(id)){await interaction.editReply(v2Payload({content:"ID produk tidak valid.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
  const result=await db.collection("products").updateOne({_id:new ObjectId(id)},{$set:{name,price,category,emoji,description,updatedAt:new Date(),updatedBy:interaction.user.id}});
  if(!result.matchedCount){await interaction.editReply(v2Payload({content:"Produk tidak ditemukan.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));return;}
  await audit("product.updated",interaction,{productId:id,source:"panel"});
  await interaction.editReply(v2Payload({content:"Produk berhasil diperbarui.",flags:EPHEMERAL|MessageFlags.IsComponentsV2}));
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
    const categoryRecord = await db.collection("categories").findOne({ name: category });
    const categoryEmoji = categoryRecord?.emoji || list.find(p => p.categoryEmoji)?.categoryEmoji || "";
    lines.push("**Category:** " + (categoryEmoji ? safeText(categoryEmoji,100) + " " : "") + category, "");
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
