import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/** Register slash commands only in the configured store guild. */
export async function refreshGuildCommands() {
  const body = commandDefinitions.map(command => command.toJSON());
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.guildId),
    { body },
  );

  // Clear the old global set so commands are only exposed in the configured store guild.
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });

  const count = Array.isArray(registered) ? registered.length : body.length;
  console.log(`Guild slash commands refreshed: ${count} in guild ${config.guildId}. Global slash commands cleared.`);

  return registered;
}
