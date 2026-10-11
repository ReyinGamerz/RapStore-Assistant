import { ChannelType, PermissionFlagsBits } from "discord.js";

const ROLE_NAMES = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"];

const ROLE_PERMISSIONS = {
  Founder: [PermissionFlagsBits.Administrator],
  Admin: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers],
  "Rap-Bot": [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  Staff: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
  Helper: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  Reseller: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  Booster: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  Customer: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
  Visitor: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
};

const LAYOUT = [
  { name: "━━ WELCOME ━━", channels: [
    { name: "👋・welcome", type: ChannelType.GuildText, access: "public", send: false },
    { name: "📜・rules", type: ChannelType.GuildText, access: "public", send: false },
    { name: "📢・announcement", type: ChannelType.GuildText, access: "staff", send: false },
  ]},
  { name: "━━ STORE ━━", channels: [
    { name: "🛒・catalog", type: ChannelType.GuildText, access: "public", send: false },
    { name: "🏷️・promo", type: ChannelType.GuildText, access: "staff", send: false },
    { name: "🧾・tos-xid", type: ChannelType.GuildText, access: "public", send: false },
    { name: "🎫・ticket-order", type: ChannelType.GuildText, access: "customer", send: true },
    { name: "📦・order-log", type: ChannelType.GuildText, access: "staff", send: false },
  ]},
  { name: "━━ COMMUNITY ━━", channels: [
    { name: "⭐・vouch", type: ChannelType.GuildText, access: "public", send: true },
    { name: "🏆・top-buyer", type: ChannelType.GuildText, access: "staff", send: false },
    { name: "💬・chat", type: ChannelType.GuildText, access: "public", send: true },
    { name: "🤖・bot-command", type: ChannelType.GuildText, access: "public", send: true },
  ]},
  { name: "━━ STAFF ZONE ━━", channels: [
    { name: "🛡️・staff-chat", type: ChannelType.GuildText, access: "staff", send: true },
    { name: "📋・staff-log", type: ChannelType.GuildText, access: "staff", send: false },
    { name: "⚙️・bot-config", type: ChannelType.GuildText, access: "admins", send: true },
  ]},
];

function overwriteFor(role, send) {
  const perms = { ViewChannel: true, ReadMessageHistory: true };
  if (send) { perms.SendMessages = true; perms.AddReactions = true; }
  else perms.SendMessages = false;
  return perms;
}

export async function setupServer(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Bot perlu izin Manage Channels dan Manage Roles. Pastikan role bot berada di atas role yang akan dibuat.");
  }

  const roleMap = new Map();
  for (const name of ROLE_NAMES) {
    let role = guild.roles.cache.find(item => item.name === name);
    if (!role) {
      role = await guild.roles.create({
        name,
        permissions: ROLE_PERMISSIONS[name] || [],
        mentionable: false,
        reason: "/setupserver role setup",
      });
    } else if (name === "Founder" || name === "Admin") {
      // Do not silently grant Administrator to an existing role; only create safe overwrite defaults.
      roleMap.set(name, role);
      continue;
    }
    roleMap.set(name, role);
  }

  const allChannels = await guild.channels.fetch();
  const deletable = [...allChannels.values()].filter(Boolean);
  // This command is explicitly destructive and only runs after the caller confirms.
  for (const channel of deletable) await channel.delete("Rebuild server layout via confirmed /setupserver");

  const everyone = guild.roles.everyone;
  const publicRoles = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"];
  const staffRoles = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper"];
  const adminRoles = ["Founder", "Admin", "Rap-Bot"];
  const created = [];

  for (const section of LAYOUT) {
    const categoryOverwrites = [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...publicRoles.map(name => ({
        id: roleMap.get(name).id,
        allow: section.name.includes("STAFF") ? [] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      })),
    ];
    if (section.name.includes("STAFF")) {
      for (const name of staffRoles) categoryOverwrites.push({ id: roleMap.get(name).id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    } else {
      for (const name of publicRoles) categoryOverwrites.push({ id: roleMap.get(name).id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    }
    const category = await guild.channels.create({ name: section.name, type: ChannelType.GuildCategory, permissionOverwrites: categoryOverwrites, reason: "/setupserver layout" });
    created.push(category.name);
    for (const spec of section.channels) {
      let allowedNames;
      if (spec.access === "public") allowedNames = publicRoles;
      else if (spec.access === "staff") allowedNames = staffRoles;
      else if (spec.access === "admins") allowedNames = adminRoles;
      else allowedNames = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Customer"];
      const overwrites = [
        { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...allowedNames.map(name => ({ id: roleMap.get(name).id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, ...(spec.send ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] : [])], deny: spec.send ? [] : [PermissionFlagsBits.SendMessages] })),
      ];
      await guild.channels.create({ name: spec.name, type: spec.type, parent: category.id, permissionOverwrites: overwrites, reason: "/setupserver layout" });
      created.push(spec.name);
    }
  }
  return { roles: ROLE_NAMES.length, channels: created.length - LAYOUT.length, categories: LAYOUT.length };
}
