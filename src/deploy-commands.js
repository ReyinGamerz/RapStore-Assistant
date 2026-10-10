import { refreshGlobalCommands } from "./global-commands.js";

try {
  await refreshGlobalCommands();
} catch (error) {
  console.error("Global slash command refresh failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
