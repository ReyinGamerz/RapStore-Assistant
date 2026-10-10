import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

/**
 * Register slash commands globally and clear legacy guild-scoped copies from
 * every guild the bot can currently enumerate. Runtime authorization in the
 * interaction handlers remains the security boundary.
 */
export async function refreshGlobalCommands({ guildIds = [] } = {}) {
  const body = commandDefinitions.map(command => command.toJSON());
  const registered = await rest.put(
    Routes.applicationCommands(config.discordClientId),
    { body },
  );

  const uniqueGuildIds = [...new Set(
    guildIds.map(id => String(id || "").trim()).filter(id => /^\d{17,20}$/.test(id)),
  )];
  const cleanupErrors = [];

  for (const guildId of uniqueGuildIds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(config.discordClientId, guildId),
        { body: [] },
      );
    } catch (error) {
      cleanupErrors.push({ guildId, error });
    }
  }

  if (cleanupErrors.length) {
    for (const item of cleanupErrors) {
      console.error(
        `[global-command-refresh] Could not remove legacy guild commands from ${item.guildId}:`,
        item.error instanceof Error ? item.error.message : item.error,
      );
    }
    throw new Error(
      `Global commands registered, but legacy guild commands could not be cleared in ${cleanupErrors.length} guild(s). Retry npm run commands:refresh.`,
    );
  }

  const count = Array.isArray(registered) ? registered.length : body.length;
  console.log(
    `Global slash commands refreshed: ${count}. Removed legacy guild-scoped commands from ${uniqueGuildIds.length} guild(s); staff access remains enforced in handlers.`,
  );
  return registered;
}
