import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { refreshGuildCommands } from "./global-commands.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

try {
  const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));
  await client.login(config.discordToken);
  const readyClient = client.isReady() ? client : await ready;
  if (!readyClient.guilds.cache.has(config.guildId)) throw new Error("Bot tidak tergabung di GUILD_ID " + config.guildId);
  await refreshGuildCommands();
} catch (error) {
  console.error("Global slash command refresh failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.destroy();
}
