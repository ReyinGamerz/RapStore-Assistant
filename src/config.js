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
  mongoUri: required("MONGODB_URI"),
  mongoDbName: optionalId("MONGODB_DB_NAME", "rapstore"),
  ids: {
    founderRole: optionalId("FOUNDER_ROLE_ID", "1549754249485877288"),
    adminRole: optionalId("ADMIN_ROLE_ID", "1549942317249593425"),
    supportCategory: optionalId("SUPPORT_CATEGORY_ID", "1552879597601820732"),
  },
  channels: {
    catalog: optionalId("CATALOG_CHANNEL", "1551251028522045470"),
    adminPanel: optionalId("CATALOG_ADMIN_PANEL", "1558775847421354075"),
  },
  payments: {
    qrisImageUrl: optionalId("PAYMENT_QRIS_IMAGE_URL"),
    bankName: optionalId("PAYMENT_BANK_NAME"),
    bankAccountName: optionalId("PAYMENT_BANK_ACCOUNT_NAME"),
    bankAccountNumber: optionalId("PAYMENT_BANK_ACCOUNT_NUMBER"),
  },
  vouchChannelId: optionalId("VOUCH_CHANNEL_ID"),
  transcriptChannelId: optionalId("TRANSCRIPT_CHANNEL_ID"),
  orderLogChannelId: optionalId("ORDER_LOG_CHANNEL_ID"),
};
