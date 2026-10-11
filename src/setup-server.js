import { ChannelType, PermissionFlagsBits } from "discord.js";

const ROLE_NAMES = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"];

const LAYOUT = [
  { name: "━━ WELCOME ━━", channels: [
    { name: "👋・welcome", type: ChannelType.GuildText, access: "public", send: false },
    { name: "📜・rules", type: ChannelType.GuildText, access: "public", send: false },
    { name: "📢・announcement", type: ChannelType.GuildText, access: "staff", send: false, sendAccess: "admins" },
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

export async function setupServer(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Bot perlu izin Manage Channels untuk membuat channel dan mengatur permission.");
  }

  const roleMap = new Map();
  const missingRoles = [];
  for (const name of ROLE_NAMES) {
    const role = guild.roles.cache.find(item => item.name === name);
    if (!role) missingRoles.push(name);
    else roleMap.set(name, role);
  }
  if (missingRoles.length) {
    throw new Error("Buat role ini secara manual terlebih dahulu (nama harus persis sama): " + missingRoles.join(", ") + ". Belum ada channel yang dihapus.");
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
    const categoryAllowed = section.name.includes("STAFF") ? staffRoles : publicRoles;
    const categoryOverwrites = [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...publicRoles.map(name => ({
        id: roleMap.get(name).id,
        allow: categoryAllowed.includes(name) ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] : [],
        deny: categoryAllowed.includes(name) ? [] : [PermissionFlagsBits.ViewChannel],
      })),
    ];
    const category = await guild.channels.create({ name: section.name, type: ChannelType.GuildCategory, permissionOverwrites: categoryOverwrites, reason: "/setupserver layout" });
    created.push(category.name);
    for (const [channelIndex, spec] of section.channels.entries()) {
      let allowedNames;
      if (spec.access === "public") allowedNames = publicRoles;
      else if (spec.access === "staff") allowedNames = staffRoles;
      else if (spec.access === "admins") allowedNames = adminRoles;
      else if (spec.access === "customer") allowedNames = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Customer"];
      else allowedNames = [];
      const sendNames = spec.sendAccess === "admins"
        ? adminRoles
        : spec.sendAccess === "staff"
          ? staffRoles
          : spec.send
            ? allowedNames
            : [];
      const overwrites = [
        { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads] },
        ...publicRoles.map(name => {
          const canView = allowedNames.includes(name);
          const canSend = sendNames.includes(name);
          return {
            id: roleMap.get(name).id,
            allow: [
              ...(canView ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] : []),
              ...(canSend ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.SendMessagesInThreads] : []),
            ],
            deny: [
              ...(!canView ? [PermissionFlagsBits.ViewChannel] : []),
              ...(!canSend ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads] : []),
            ],
          };
        }),
      ];
      const treePrefix = channelIndex === 0 ? "╭" : channelIndex === section.channels.length - 1 ? "╰" : "┊";
      const channelName = treePrefix + "・" + spec.name.replace("・", "：");
      await guild.channels.create({ name: channelName, type: spec.type, parent: category.id, permissionOverwrites: overwrites, reason: "/setupserver layout" });
      created.push(channelName);
    }
  }
  return { roles: ROLE_NAMES.length, channels: created.length - LAYOUT.length, categories: LAYOUT.length };
}
