import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/** Register slash commands only in the configured store guild. */
export async function refreshGuildCommands({ guildIds = [] } = {}) {
  const body = commandDefinitions.map(command => command.toJSON());
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.guildId),
    { body },
  );

  // Keep the full store command set in the configured store guild. Other joined
  // guilds receive only /setupserver so a fresh test server can be initialized.
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });
  const setupOnly = commandDefinitions.filter(command => ["setupserver", "setuptrap"].includes(command.name)).map(command => command.toJSON());
  const otherGuildIds = [...new Set(guildIds.map(id => String(id || "").trim()).filter(id => /^\\d{17,20}$/.test(id) && id !== config.guildId))];
  const cleanupErrors = [];
  for (const guildId of otherGuildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body: setupOnly });
    } catch (error) {
      cleanupErrors.push({ guildId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (cleanupErrors.length) {
    for (const item of cleanupErrors) console.error("[guild-command-refresh] Could not clear legacy commands from " + item.guildId + ": " + item.message);
    throw new Error("Guild commands registered, but legacy commands could not be cleared from " + cleanupErrors.length + " other guild(s).");
  }

  const count = Array.isArray(registered) ? registered.length : body.length;
  console.log(`Guild slash commands refreshed: ${count} in guild ${config.guildId}; /setupserver and /setuptrap registered in ${otherGuildIds.length} other guild(s).`);

  return registered;
}
