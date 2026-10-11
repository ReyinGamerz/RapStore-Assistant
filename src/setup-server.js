import { ChannelType, PermissionFlagsBits } from "discord.js";

const ROLE_NAMES = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"];
const P = PermissionFlagsBits;

const LAYOUT = [
  { name: "━━ WELCOME ━━", visibility: "public", channels: [
    { label: "👋：ᴡᴇʟᴄᴏᴍᴇ", name: "welcome", access: "public", send: [] },
    { label: "📜：ʀᴜʟᴇs", name: "rules", access: "public", send: [] },
    { label: "📢：sᴄᴀᴍᴍᴇʀ", name: "scammer", access: "public", send: [] },
    { label: "📣：ᴀɴɴᴏᴜɴᴄᴇᴍᴇɴᴛ", name: "announcement", access: "public", send: ["Founder", "Admin", "Rap-Bot"] },
  ]},
  { name: "━━ STORE ━━", visibility: "public", channels: [
    { label: "🛒：ᴄᴀᴛᴀʟᴏɢ", name: "catalog", access: "public", send: [] },
    { label: "📜：ᴛᴏs-xɪᴅ", name: "tos-xid", access: "public", send: [] },
    { label: "🏷️：ᴘʀᴏᴍᴏ", name: "promo", access: "public", send: ["Founder", "Admin", "Rap-Bot"] },
    { label: "📢：ᴀᴜᴛᴏᴘᴏsᴛ", name: "autopost", access: "public", send: ["Founder", "Admin", "Rap-Bot"] },
    { label: "🛒：ᴛɪᴄᴋᴇᴛ-ᴏʀᴅᴇʀ", name: "ticket-order", access: "public", send: ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Customer"] },
    { label: "📦：ᴏʀᴅᴇʀ-ʟᴏɢ", name: "order-log", access: "staff", send: [] },
  ]},
  { name: "━━ COMMUNITY ━━", visibility: "public", channels: [
    { label: "⭐：ᴠᴏᴜᴄʜ", name: "vouch", access: "public", send: ["Founder", "Admin", "Rap-Bot"] },
    { label: "⭐：ʀᴇᴘᴜᴛᴀsɪ", name: "reputasi", access: "public", send: [] },
    { label: "👑：ᴛᴏᴘ-ʙᴜʏᴇʀ", name: "top-buyer", access: "public", send: [] },
    { label: "🤖：ʙᴏᴛ-ᴄᴏᴍᴍᴀɴᴅ", name: "bot-command", access: "public", send: ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"] },
    { label: "💭：ᴄʜᴀᴛ", name: "chat", access: "public", send: ["Founder", "Admin", "Rap-Bot", "Staff", "Helper", "Reseller", "Booster", "Customer", "Visitor"] },
  ]},
  { name: "━━ RESELLER ━━", visibility: "reseller", channels: [
    { label: "💬：ʀᴇsᴇʟʟᴇʀ-ᴄʜᴀᴛ", name: "reseller-chat", access: "reseller", send: ["Reseller", "Founder", "Admin", "Rap-Bot"] },
    { label: "📦：ᴅᴀғᴛᴀʀ-ᴘʀᴏᴅᴜᴋ", name: "daftar-produk", access: "reseller", send: [] },
  ]},
  { name: "━━ STAFF / ADMIN ZONE ━━", visibility: "staff", channels: [
    { label: "💬：sᴛᴀғғ-ᴄʜᴀᴛ", name: "staff-chat", access: "staff", send: ["Founder", "Admin", "Rap-Bot", "Staff", "Helper"] },
    { label: "📋：sᴛᴀғғ-ʟᴏɢ", name: "staff-log", access: "staff", send: [] },
    { label: "⚙️：ʙᴏᴛ-ᴄᴏɴғɪɢ", name: "bot-config", access: "staff", send: ["Founder", "Admin", "Rap-Bot"] },
  ]},
];

function makeRoleOverwrites(guild, roleMap, visibleNames, sendNames) {
  const overwrites = [{
    id: guild.roles.everyone.id,
    deny: [
      P.ViewChannel, P.SendMessages, P.AddReactions,
      P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads,
    ],
  }];
  for (const name of ROLE_NAMES) {
    const role = roleMap.get(name);
    const canView = visibleNames.includes(name);
    const canSend = canView && sendNames.includes(name);
    overwrites.push({
      id: role.id,
      allow: [
        ...(canView ? [P.ViewChannel, P.ReadMessageHistory] : []),
        ...(canSend ? [P.SendMessages, P.SendMessagesInThreads, P.AddReactions, P.EmbedLinks, P.AttachFiles] : []),
        ...(name === "Booster" ? [P.ChangeNickname] : []),
        ...(name === "Admin" ? [P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers] : []),
        ...(name === "Staff" ? [P.ManageMessages, P.ModerateMembers] : []),
        ...(name === "Helper" ? [P.ReadMessageHistory] : []),
      ],
      deny: [
        ...(!canView ? [P.ViewChannel] : []),
        ...(!canSend ? [P.SendMessages, P.SendMessagesInThreads, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads] : []),
      ],
    });
  }
  return overwrites;
}

export async function setupServer(guild) {
  if (!guild.members.me?.permissions.has(P.ManageChannels)) {
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
  // /setupserver is destructive by design and must only be run on the test server.
  for (const channel of deletable) await channel.delete("Rebuild server layout via confirmed /setupserver");

  const staffNames = ["Founder", "Admin", "Rap-Bot", "Staff", "Helper"];
  const adminNames = ["Founder", "Admin", "Rap-Bot"];
  const resellerNames = ["Founder", "Admin", "Rap-Bot", "Reseller"];
  const created = [];

  for (const section of LAYOUT) {
    const visibleNames = section.visibility === "staff" ? staffNames
      : section.visibility === "reseller" ? resellerNames
      : ROLE_NAMES;
    const category = await guild.channels.create({
      name: section.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: makeRoleOverwrites(guild, roleMap, visibleNames, []),
      reason: "/setupserver layout and strict role permissions",
    });
    created.push(category.name);

    for (const [i, spec] of section.channels.entries()) {
      const channelVisible = spec.access === "staff" ? staffNames
        : spec.access === "reseller" ? resellerNames
        : ROLE_NAMES;
      const overwrites = makeRoleOverwrites(guild, roleMap, channelVisible, spec.send);
      const prefix = i === 0 ? "╭" : i === section.channels.length - 1 ? "╰" : "┊";
      const channelName = prefix + "・" + spec.label;
      await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
        reason: "/setupserver layout and strict role permissions",
      });
      created.push(channelName);
    }
  }

  return {
    roles: ROLE_NAMES.length,
    categories: LAYOUT.length,
    channels: created.length - LAYOUT.length,
  };
}
