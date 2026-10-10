import { SlashCommandBuilder, ChannelType } from "discord.js";

const productAdd = new SlashCommandBuilder()
  .setName("product_add").setDescription("Tambah produk ke katalog (Admin/Founder).")
  .addStringOption(o => o.setName("nama").setDescription("Nama produk").setRequired(true).setMaxLength(100))
  .addIntegerOption(o => o.setName("harga").setDescription("Harga retail dalam Rupiah").setRequired(true).setMinValue(1))
  .addIntegerOption(o => o.setName("harga_reseller").setDescription("Harga reseller (opsional)").setRequired(false).setMinValue(1))
  .addStringOption(o => o.setName("kategori").setDescription("Kategori katalog, misalnya Decoration Gift").setRequired(false).setMaxLength(80))
  .addStringOption(o => o.setName("deskripsi").setDescription("Deskripsi singkat").setRequired(false).setMaxLength(500))
  .addStringOption(o => o.setName("sku").setDescription("SKU unik opsional").setRequired(false).setMaxLength(40));

const stockAdd = new SlashCommandBuilder()
  .setName("stock_add").setDescription("Masukkan stok digital (satu item per baris).")
  .addStringOption(o => o.setName("produk_id").setDescription("ID produk dari /product_manage").setRequired(true).setMaxLength(30))
  .addStringOption(o => o.setName("items").setDescription("Item/baris stok; data rahasia, jangan dibagikan").setRequired(true).setMaxLength(4000));

const productManage = new SlashCommandBuilder()
  .setName("product_manage").setDescription("Lihat ID produk dan ubah status aktif.")
  .addStringOption(o => o.setName("produk_id").setDescription("ID produk (kosongkan untuk daftar)").setRequired(false).setMaxLength(30))
  .addBooleanOption(o => o.setName("aktif").setDescription("Status aktif produk; wajib bersama produk_id").setRequired(false));

const orderCreate = new SlashCommandBuilder()
  .setName("order_create").setDescription("Buat order dan tiket pembelian.")
  .addStringOption(o => o.setName("produk_id").setDescription("ID produk dari katalog").setRequired(true).setMaxLength(30))
  .addIntegerOption(o => o.setName("jumlah").setDescription("Jumlah item").setRequired(true).setMinValue(1).setMaxValue(5));

const paymentSubmit = new SlashCommandBuilder()
  .setName("payment_submit").setDescription("Kirim bukti pembayaran untuk order.")
  .addStringOption(o => o.setName("kode_order").setDescription("Kode order").setRequired(true).setMaxLength(30))
  .addAttachmentOption(o => o.setName("bukti").setDescription("Screenshot bukti transfer").setRequired(true));

const paymentReview = new SlashCommandBuilder()
  .setName("payment_review").setDescription("Verifikasi pembayaran secara manual (Admin/Founder).")
  .addStringOption(o => o.setName("kode_order").setDescription("Kode order").setRequired(true).setMaxLength(30))
  .addStringOption(o => o.setName("keputusan").setDescription("Keputusan admin").setRequired(true)
    .addChoices({ name: "Terima", value: "approve" }, { name: "Tolak", value: "reject" }))
  .addStringOption(o => o.setName("catatan").setDescription("Catatan keputusan").setRequired(false).setMaxLength(300));

const orderDeliver = new SlashCommandBuilder()
  .setName("order_deliver").setDescription("Kirim ulang item order yang sudah dibayar (Admin/Founder).")
  .addStringOption(o => o.setName("kode_order").setDescription("Kode order").setRequired(true).setMaxLength(30));

const ticketClose = new SlashCommandBuilder()
  .setName("ticket_close").setDescription("Kunci tiket ini dan jadwalkan pengarsipan manual.");

const vouchSubmit = new SlashCommandBuilder()
  .setName("vouch").setDescription("Beri ulasan untuk order yang sudah selesai.")
  .addStringOption(o => o.setName("kode_order").setDescription("Kode order selesai").setRequired(true).setMaxLength(30))
  .addIntegerOption(o => o.setName("rating").setDescription("Rating 1–5").setRequired(true).setMinValue(1).setMaxValue(5))
  .addStringOption(o => o.setName("ulasan").setDescription("Testimoni singkat").setRequired(true).setMaxLength(700));

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Memeriksa status bot dan MongoDB Atlas."),
  new SlashCommandBuilder().setName("store").setDescription("Menampilkan informasi toko."),
  new SlashCommandBuilder().setName("panel").setDescription("Panel Founder/Admin untuk mengelola produk dan stok."),
  new SlashCommandBuilder().setName("catalog").setDescription("Buka katalog interaktif: kategori, produk, dan harga."),
  productAdd, stockAdd, productManage, orderCreate, paymentSubmit, paymentReview, orderDeliver, ticketClose, vouchSubmit,
];
