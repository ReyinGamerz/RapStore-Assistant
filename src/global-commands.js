import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/**
 * Register commands only in the configured server and restrict them to staff roles.
 * Global commands are cleared so regular members do not see stale global copies.
 */
export async function refreshGlobalCommands() {
  if (!config.discordGuildId) {
    throw new Error("Set DISCORD_GUILD_ID in .env before deploying staff-only slash commands.");
  }
  const body = commandDefinitions.map((command) => command.toJSON());
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
    { body },
  );

  // Remove the old global copies; these otherwise remain visible to regular members.
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });

  const permissions = [
    { id: config.discordGuildId, type: 1, permission: false },
    { id: config.ids.founderRole, type: 1, permission: true },
    { id: config.ids.adminRole, type: 1, permission: true },
  ];
  for (const command of registered) {
    await rest.put(
      Routes.applicationCommandPermissions(config.discordClientId, config.discordGuildId, command.id),
      { permissions },
    );
  }

  console.log(`Staff-only guild slash commands refreshed: ${registered.length}. Global copies removed.`);
  return registered;
}
