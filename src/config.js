import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalId(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: optionalId("DISCORD_GUILD_ID") || null,
  mongoUri: required("MONGODB_URI"),
  mongoDbName: optionalId("MONGODB_DB_NAME", "rapstore"),
  logLevel: optionalId("LOG_LEVEL", "info"),
  ids: {
    founderRole: optionalId("FOUNDER_ROLE_ID", "1549754249485877288"),
    adminRole: optionalId("ADMIN_ROLE_ID", "1549942317249593425"),
    resellerRole: optionalId("RESELLER_ROLE_ID"),
    orderLogChannel: optionalId("ORDER_LOG_CHANNEL_ID", "1551938009220255824"),
    vouchChannel: optionalId("VOUCH_CHANNEL_ID", "1552115479756406894"),
    ticketPanelChannel: optionalId("TICKET_PANEL_CHANNEL_ID", "1551251312421769216"),
    catalogChannel: optionalId("CATALOG_CHANNEL_ID", "1551251028522045470"),
    paymentReviewChannel: optionalId("PAYMENT_REVIEW_CHANNEL_ID", "1558122399201759242"),
    orderCategory: optionalId("ORDER_CATEGORY_ID", "1551963301640937514"),
    supportCategory: optionalId("SUPPORT_CATEGORY_ID", "1552879597601820732"),
  },
};
