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
    supportCategory: optionalId("SUPPORT_CATEGORY_ID", "1552879597601820732"),
  },
  payments: {
    qrisImageUrl: optionalId("PAYMENT_QRIS_IMAGE_URL"),
    bankName: optionalId("PAYMENT_BANK_NAME"),
    bankAccountName: optionalId("PAYMENT_BANK_ACCOUNT_NAME"),
    bankAccountNumber: optionalId("PAYMENT_BANK_ACCOUNT_NUMBER"),
  },
  vouchChannelId: optionalId("VOUCH_CHANNEL_ID"),
  transcriptChannelId: optionalId("TRANSCRIPT_CHANNEL_ID"),
  cloudStorage: {
    b2S3Endpoint: optionalId("B2_S3_ENDPOINT"),
    b2Region: optionalId("B2_REGION"),
    b2AccessKeyId: optionalId("B2_ACCESS_KEY_ID"),
    b2SecretAccessKey: optionalId("B2_SECRET_ACCESS_KEY"),
    b2BucketName: optionalId("B2_BUCKET_NAME"),
    b2PublicBaseUrl: optionalId("B2_PUBLIC_BASE_URL").replace(new RegExp(String.fromCharCode(47) + "$"), ""),
  },
};
