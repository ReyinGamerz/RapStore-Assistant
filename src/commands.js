import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("catalog").setDescription("Buka katalog produk interaktif."),
  new SlashCommandBuilder().setName("panel").setDescription("Panel Founder/Admin untuk tambah dan edit produk."),
];
