import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/**
 * Register the current command definitions as GLOBAL application commands.
 * Discord bulk-overwrite removes obsolete global commands not in this list.
 * This module never registers guild-scoped commands.
 */
export async function refreshGlobalCommands() {
  const body = commandDefinitions.map((command) => command.toJSON());
  const registered = await rest.put(
    Routes.applicationCommands(config.discordClientId),
    { body },
  );

  const count = Array.isArray(registered) ? registered.length : body.length;
  console.log(`Global slash commands refreshed: ${count} active. Obsolete global commands removed.`);
  return registered;
}
