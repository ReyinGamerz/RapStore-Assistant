import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("catalog").setDescription("Buka katalog produk interaktif."),
  new SlashCommandBuilder().setName("panel").setDescription("Panel Founder/Admin untuk tambah dan edit produk."),
  new SlashCommandBuilder()
    .setName("addemoji")
    .setDescription("Founder: tambahkan emoji dari gambar atau ZIP ke server.")
    .addAttachmentOption(option => option.setName("file").setDescription("File PNG, GIF, JPG, atau ZIP berisi emoji").setRequired(true)),
  new SlashCommandBuilder()
    .setName("addemoji")
    .setDescription("Founder: tambahkan emoji dari gambar atau ZIP ke server.")
    .addAttachmentOption(option => option.setName("file").setDescription("File PNG, GIF, JPG, atau ZIP berisi emoji").setRequired(true)),
];
