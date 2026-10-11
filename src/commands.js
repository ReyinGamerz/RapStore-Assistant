import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("setupserver").setDescription("Founder/Admin: bangun ulang struktur server, role, dan permission.").addBooleanOption(option => option.setName("konfirmasi_hapus").setDescription("WAJIB true: hapus semua channel/category yang ada di server ini").setRequired(true)),
  new SlashCommandBuilder().setName("setuptrap").setDescription("Founder/Admin: buat channel anti-spam trap dengan timeout otomatis."),
  new SlashCommandBuilder().setName("catalog").setDescription("Buka katalog produk interaktif."),
  new SlashCommandBuilder().setName("panel").setDescription("Panel Founder/Admin untuk tambah dan edit produk."),
  new SlashCommandBuilder().setName("importproduk").setDescription("Founder: impor banyak produk dari file CSV ke MongoDB.").addAttachmentOption(option => option.setName("file").setDescription("CSV dengan kolom name,price,category,emoji,description").setRequired(true)),
  new SlashCommandBuilder()
    .setName("addemoji")
    .setDescription("Founder: tambahkan emoji dari gambar atau ZIP ke server.")
    .addAttachmentOption(option => option.setName("file").setDescription("File PNG, GIF, JPG, atau ZIP berisi emoji").setRequired(true)),
  new SlashCommandBuilder()
    .setName("removeemoji")
    .setDescription("Founder: hapus emoji tertentu atau semua emoji server.")
    .addStringOption(option => option.setName("mode").setDescription("Pilih hapus satu emoji atau semua emoji").setRequired(true)
      .addChoices(
        { name: "Pilih emoji", value: "pilih" },
        { name: "Hapus semua emoji", value: "semua" },
      )),
];
