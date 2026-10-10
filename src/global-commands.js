import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/**
 * Register commands in the configured server and remove legacy global copies.
 * Runtime role checks remain authoritative: Discord's command-permission API
 * requires a user Bearer token, so this bot-token deployment intentionally does
 * not attempt to write per-role application-command permissions.
 */
export async function refreshGlobalCommands() {
  const guildId = String(config.discordGuildId || "").trim();
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new Error("Set a valid DISCORD_GUILD_ID in .env before refreshing guild slash commands.");
  }

  const body = commandDefinitions.map(command => command.toJSON());
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, guildId),
    { body },
  );

  // Clear old global registrations so members only see the guild-scoped copies.
  // Runtime checks still deny unauthorized members if Discord temporarily caches old commands.
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });

  const count = Array.isArray(registered) ? registered.length : body.length;
  console.log(`Guild slash commands refreshed: ${count}. Legacy global commands removed; staff access is enforced in handlers.`);
  return registered;
}
