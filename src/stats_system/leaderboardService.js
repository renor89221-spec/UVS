// stats_system/leaderboardService.js
const { supabase } = require("./supabase");
const { getGuildConfig } = require("./guildConfig");
const { formatCompact, formatDistance, formatHours } = require("../formatters");
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  WebhookClient
} = require("discord.js");

// ─── Emoji IDs ───
const E = {
  distance:         "<:distance:1567953812189225121>",
  clean_deliveries: "<:clean_deliveries:1567953809102213210>",
  score:            "<:score:1567953806959054859>",
  stars:            "<:stars:1567953804584951920>",
  time:             "<:time:1567953802022359112>",
  manager:          "<:manager:1567953799291740253>",
  drivers:          "<:drivers:1567953797094051911>",
  networth:         "<:networth:1567953794669481994>",
  founder:          "<:founder:1567953792652156989>",
  runs:             "<:runs:1567953790072524821>",
  driver:           "<:driver:1567954698642784316>",
};

// ─── Sort Options ───
const SORT_OPTIONS = [
  { label: "Seniority (Default)",   value: "seniority",  description: "By time registered in UVS" },
  { label: "Total Score",           value: "score",       description: "By highest total score" },
  { label: "Total Distance",        value: "distance",    description: "By most KMs driven" },
  { label: "Driving Time",          value: "time",        description: "By most hours driven" },
  { label: "Total Stars",           value: "stars",       description: "By most stars earned" },
  { label: "Clean Deliveries",      value: "clean",       description: "By most clean deliveries" },
  { label: "Net Worth",             value: "networth",    description: "By highest net worth" },
];

const SORT_LABELS = {
  seniority: "Seniority",
  score:     "Total Score",
  distance:  "Total Distance",
  time:      "Driving Time",
  stars:     "Total Stars",
  clean:     "Clean Deliveries",
  networth:  "Net Worth",
};

// ─── Speed classification ───
function getSpeedRating(avgSpeedKmh) {
  if (avgSpeedKmh < 30)  return { phrase: "slowly" };
  if (avgSpeedKmh < 50)  return { phrase: "leisurely" };
  if (avgSpeedKmh < 70)  return { phrase: "steadily" };
  if (avgSpeedKmh < 90)  return { phrase: "smoothly" };
  if (avgSpeedKmh < 110) return { phrase: "swiftly" };
  if (avgSpeedKmh < 130) return { phrase: "rapidly" };
  if (avgSpeedKmh < 150) return { phrase: "dynamically" };
  return { phrase: "at full throttle" };
}

// ─── Clean delivery / Driving discipline classification ───
function getDisciplineRating(cleanPct) {
  if (cleanPct >= 100) return { level: "Perfect",     phrase: "maintaining a perfect record" };
  if (cleanPct >= 90)  return { level: "Outstanding", phrase: "delivering with outstanding discipline" };
  if (cleanPct >= 70)  return { level: "Excellent",   phrase: "maintaining excellent discipline" };
  if (cleanPct >= 50)  return { level: "Good",        phrase: "delivering cleanly" };
  if (cleanPct >= 30)  return { level: "Fair",        phrase: "maintaining fair discipline" };
  return { level: "Poor", phrase: "delivering poorly" };
}

// ─── Guild name cache ───
const guildNameCache = new Map();
async function getGuildName(guildId) {
  if (guildNameCache.has(guildId)) return guildNameCache.get(guildId);
  const { data } = await supabase
    .from("approved_guilds")
    .select("guild_tag, guild_name")
    .eq("guild_id", guildId)
    .maybeSingle();
  const name = data ? `${data.guild_tag} ${data.guild_name}` : guildId;
  guildNameCache.set(guildId, name);
  return name;
}

// ─── Shared: build drivers array from stats rows ───
function buildDriversArray(statsRows) {
  return (statsRows || []).map(row => ({
    id:           row.players.id,
    username:     row.players.username,
    display_name: row.players.display_name,
    discord_id:   row.players.discord_id,
    guild_tag:    row.players.guild_tag,
    created_at:   row.players.created_at,
    stats: {
      total_score:        row.total_score,
      total_time_minutes: row.total_time_minutes,
      total_stars:        row.total_stars,
      total_distance_km:  row.total_distance_km,
      clean_deliveries:   row.clean_deliveries,
      net_worth:          row.net_worth || 0,
    }
  }));
}

// ─── Sort drivers array ───
function sortDrivers(allDrivers, sortKey, founderDiscordId, managerDiscordIds) {
  if (sortKey === "seniority") {
    // Founder pinned at #1, managers sorted by seniority from #2, rest sorted by seniority after
    const founder  = allDrivers.filter(d => founderDiscordId && d.discord_id === founderDiscordId);
    const managers = allDrivers.filter(d =>
      (!founderDiscordId || d.discord_id !== founderDiscordId) &&
      managerDiscordIds && managerDiscordIds.includes(d.discord_id)
    );
    const rest = allDrivers.filter(d =>
      (!founderDiscordId || d.discord_id !== founderDiscordId) &&
      (!managerDiscordIds || !managerDiscordIds.includes(d.discord_id))
    );

    const bySeniority = arr => arr.slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    return [...bySeniority(founder), ...bySeniority(managers), ...bySeniority(rest)];
  }

  const getVal = (d) => {
    const s = d.stats || {};
    if (sortKey === "score")    return Number(s.total_score        || 0);
    if (sortKey === "distance") return Number(s.total_distance_km  || 0);
    if (sortKey === "time")     return Number(s.total_time_minutes || 0);
    if (sortKey === "stars")    return Number(s.total_stars        || 0);
    if (sortKey === "clean")    return Number(s.clean_deliveries   || 0);
    if (sortKey === "networth") return Number(s.net_worth          || 0);
    return 0;
  };

  return allDrivers.slice().sort((a, b) => getVal(b) - getVal(a));
}

// ─── Build Combined VTC Leaderboard (1 Embed + Components v2) ───
const PAGE_SIZE = 10;

function buildCombinedVTCLeaderboard({ guildRow, statsRows, guildConfig, page = 0, sortKey = "seniority" }) {
  const stats = statsRows || [];
  const totalDistanceKm = stats.reduce((s, r) => s + (Number(r.total_distance_km)  || 0), 0);
  const totalTimeMin    = stats.reduce((s, r) => s + (Number(r.total_time_minutes) || 0), 0);
  const totalScore      = stats.reduce((s, r) => s + (Number(r.total_score)        || 0), 0);
  const totalStars      = stats.reduce((s, r) => s + (Number(r.total_stars)        || 0), 0);
  const totalClean      = stats.reduce((s, r) => s + (Number(r.clean_deliveries)   || 0), 0);

  const totalRuns   = Number(guildRow.runs)      || 0;
  const netWorth    = Number(guildRow.net_worth) || 0;
  const memberCount = stats.length;

  // Velocity: km / (minutes/60)
  const avgSpeedKmh = totalTimeMin > 0 ? (totalDistanceKm / (totalTimeMin / 60)) : 0;
  const speed = getSpeedRating(avgSpeedKmh);

  // Clean delivery %: sum(clean_deliveries) / total_runs * 100
  const cleanPct = totalRuns > 0 ? Math.round((totalClean / totalRuns) * 100) : 0;
  const discipline = getDisciplineRating(cleanPct);

  const guildName = guildRow.guild_name || guildConfig.guild_name || "Unknown VTC";
  const guildTag  = guildRow.guild_tag  || guildConfig.guild_tag  || "";

  // Leadership IDs
  const founderDiscordId  = guildRow.founder || null;
  const managerDiscordIds = guildRow.manager
    ? guildRow.manager.split(",").map(m => m.trim()).filter(Boolean)
    : [];

  // Drivers roster & pagination
  const allDrivers    = buildDriversArray(stats);
  const sortedDrivers = sortDrivers(allDrivers, sortKey, founderDiscordId, managerDiscordIds);
  const totalPages    = Math.max(1, Math.ceil(sortedDrivers.length / PAGE_SIZE));
  const safePage      = Math.min(Math.max(0, page), totalPages - 1);
  const slice         = sortedDrivers.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const rosterLines = slice.map((d, i) => {
    const globalNum = safePage * PAGE_SIZE + i + 1;
    const name = d.display_name || d.username || "Unknown";
    const isFounder = founderDiscordId && d.discord_id === founderDiscordId;
    const isManager = managerDiscordIds && managerDiscordIds.includes(d.discord_id);

    let roleEmoji = E.driver;
    let roleLabel = "";
    if (isFounder) {
      roleEmoji = E.founder;
      roleLabel = " **[Founder]**";
    } else if (isManager) {
      roleEmoji = E.manager;
      roleLabel = " **[Manager]**";
    }

    let stat = "";
    if (d.stats) {
      const s = d.stats;
      if      (sortKey === "score")    stat = ` — ${Math.round(s.total_score || 0).toLocaleString()} pts`;
      else if (sortKey === "distance") stat = ` — ${formatDistance(s.total_distance_km || 0)}`;
      else if (sortKey === "time")     stat = ` — ${formatHours(s.total_time_minutes || 0)}`;
      else if (sortKey === "stars")    stat = ` — ${Math.round(s.total_stars || 0)} ⭐`;
      else if (sortKey === "clean")    stat = ` — ${s.clean_deliveries || 0} clean`;
      else if (sortKey === "networth") stat = ` — \$${formatCompact(s.net_worth || 0)}`;
      else                             stat = ` — ${formatDistance(s.total_distance_km || 0)}`;
    }

    return `${roleEmoji} \`${String(globalNum).padStart(2, " ")}.\` **${name}**${roleLabel}${stat}`;
  });

  // ─── Fields Layout ───
  const fields = [
    { name: `${E.networth} Net Worth`,      value: `**\$${formatCompact(netWorth)}**`,            inline: true },
    { name: `${E.drivers} Drivers`,        value: `**${memberCount}**`,                          inline: true },
    { name: `${E.runs} Total Runs`,        value: `**${totalRuns.toLocaleString()}**`,           inline: true },

    { name: `${E.distance} Distance`,       value: `**${formatDistance(totalDistanceKm)}**`,      inline: true },
    { name: `${E.time} Drive Time`,        value: `**${formatHours(totalTimeMin)}**`,            inline: true },
    { name: `${E.score} Total Score`,      value: `**${Math.round(totalScore).toLocaleString()}**`, inline: true },

    { name: `${E.stars} Total Stars`,      value: `**${Math.round(totalStars).toLocaleString()}**`, inline: true },
    { name: `${E.clean_deliveries} Clean`, value: `**${totalClean.toLocaleString()}** (${cleanPct}%)`, inline: true },
    { name: `🛡️ Discipline`,               value: `**${discipline.level}**`,                     inline: true },
  ];

  // Leadership section (only if founder or managers set)
  const leadershipParts = [];
  if (founderDiscordId) {
    leadershipParts.push(`${E.founder} **Founder:** <@${founderDiscordId}>`);
  }
  if (managerDiscordIds.length > 0) {
    leadershipParts.push(`${E.manager} **Managers:** ${managerDiscordIds.map(id => `<@${id}>`).join(", ")}`);
  }
  if (leadershipParts.length > 0) {
    fields.push({
      name: "👑 Leadership",
      value: leadershipParts.join("\n"),
      inline: false
    });
  }

  // Fleet Operations status sentence
  const cleanPhraseFormatted = discipline.phrase.charAt(0).toUpperCase() + discipline.phrase.slice(1);
  fields.push({
    name: "🧭 Fleet Operations",
    value: [
      `*${guildName} is moving **${speed.phrase}** forward with an average speed of **${Math.round(avgSpeedKmh)} km/h**.*`,
      `*${cleanPhraseFormatted} (${cleanPct}% clean delivery rate).*`
    ].join("\n"),
    inline: false
  });

  // Driver Roster section
  const currentSortLabel = SORT_LABELS[sortKey] || sortKey;
  fields.push({
    name: `📋 Driver Roster (Page ${safePage + 1}/${totalPages} • ${currentSortLabel})`,
    value: rosterLines.length > 0 ? rosterLines.join("\n") : "*No registered drivers.*",
    inline: false
  });

  const embed = {
    title: `🏢 ${guildTag} ${guildName}`.trim(),
    color: guildConfig.embed_color || 0xff7801,
    thumbnail: (guildConfig.thumbnail || guildRow.avatar_url)
      ? { url: guildConfig.thumbnail || guildRow.avatar_url }
      : undefined,
    fields,
    footer: {
      text: `Page ${safePage + 1}/${totalPages} • ${allDrivers.length} Drivers • Sorted by: ${currentSortLabel} • Resets daily at 9:00 AM IST • Managed by NMC`
    }
  };

  // ─── Discord Components v2 ───
  // Component Row 1: Sort Dropdown
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`roster_sort:${guildRow.guild_id}:${safePage}`)
    .setPlaceholder(`Sort by: ${currentSortLabel}`)
    .addOptions(
      SORT_OPTIONS.map(opt =>
        new StringSelectMenuOptionBuilder()
          .setLabel(opt.label)
          .setValue(opt.value)
          .setDescription(opt.description)
          .setDefault(opt.value === sortKey)
      )
    );
  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  // Component Row 2: Pagination & Reset Buttons
  const prevBtn = new ButtonBuilder()
    .setCustomId(`roster_page:${guildRow.guild_id}:${safePage - 1}:${sortKey}`)
    .setLabel("Prev")
    .setEmoji("◀️")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(safePage === 0);

  const pageIndicatorBtn = new ButtonBuilder()
    .setCustomId(`roster_noop:${guildRow.guild_id}`)
    .setLabel(`${safePage + 1} / ${totalPages}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`roster_page:${guildRow.guild_id}:${safePage + 1}:${sortKey}`)
    .setLabel("Next")
    .setEmoji("▶️")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(safePage >= totalPages - 1);

  const resetBtn = new ButtonBuilder()
    .setCustomId(`roster_reset:${guildRow.guild_id}`)
    .setLabel("Reset")
    .setEmoji("🔄")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage === 0 && sortKey === "seniority");

  const buttonRow = new ActionRowBuilder().addComponents(prevBtn, pageIndicatorBtn, nextBtn, resetBtn);

  return {
    embeds: [embed],
    components: [selectRow, buttonRow]
  };
}

// ─── Queue system to serialize updates per guild ───
const updateQueue = new Map();

async function updateLeaderboard(client, guildId) {
  if (!updateQueue.has(guildId)) {
    updateQueue.set(guildId, { isUpdating: false, needsAnotherUpdate: false });
  }
  const state = updateQueue.get(guildId);
  if (state.isUpdating) {
    state.needsAnotherUpdate = true;
    return;
  }
  state.isUpdating = true;
  try {
    await performLeaderboardUpdate(client, guildId);
  } finally {
    state.isUpdating = false;
    if (state.needsAnotherUpdate) {
      state.needsAnotherUpdate = false;
      setTimeout(() => updateLeaderboard(client, guildId), 5000);
    }
  }
}

// ─── Main leaderboard update ───
async function performLeaderboardUpdate(client, guildId) {
  try {
    const guildConfig = await getGuildConfig(guildId);

    if (!guildConfig.leaderboard_channel_id) {
      const skipName = await getGuildName(guildId);
      console.warn(`[Leaderboard] Skipping ${skipName} — no leaderboard_channel_id set.`);
      return;
    }

    const { data: guildRow, error: guildErr } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_name, guild_tag, net_worth, runs, embed_color, avatar_url, lb_msg_guilds, founder, manager, is_suspended, temp_suspension")
      .eq("guild_id", guildId)
      .single();

    if (guildErr || !guildRow) {
      const errName = await getGuildName(guildId);
      console.error(`[Leaderboard] Failed to fetch guild row for ${errName}:`, guildErr?.message);
      return;
    }

    const isHQ = guildId === process.env.HQ_GUILD_ID;

    // ─── HQ Server: Global dashboard (unchanged) ───
    if (isHQ) {
      await performHQLeaderboardUpdate(client, guildId, guildConfig, guildRow);
      return;
    }

    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch(async (err) => {
      const chErrName = await getGuildName(guildId);
      console.error(`[Leaderboard] Cannot fetch channel for ${chErrName}:`, err.message);
      return null;
    });
    if (!channel) return;

    // ─── Clean up any leftover secondary message from older 2-message split ───
    const rawStored = String(guildRow.lb_msg_guilds || "").trim();
    const storedIds = rawStored ? rawStored.split(",").map(s => s.trim()).filter(Boolean) : [];
    const currentId = storedIds[0] || null;
    const extraId   = storedIds[1] || null;

    if (extraId) {
      try {
        const extraMsg = await channel.messages.fetch(extraId);
        await extraMsg.delete().catch(() => {});
        console.log(`[Leaderboard] Cleaned up legacy secondary message ${extraId}`);
      } catch (_) {}
    }

    // ─── Fetch player stats for this guild ───
    const { data: statsRows } = await supabase
      .from("player_stats")
      .select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(id, username, display_name, discord_id, guild_id, guild_tag, created_at)")
      .eq("players.guild_id", guildId);

    // ─── Build Single Combined Leaderboard Message ───
    const payload = buildCombinedVTCLeaderboard({
      guildRow,
      statsRows: statsRows || [],
      guildConfig,
      page: 0,
      sortKey: "seniority"
    });

    const newMsgId = await sendOrEditMessage(channel, currentId, payload);

    // Save single message ID back to lb_msg_guilds ONLY if changed
    if (newMsgId && newMsgId !== rawStored) {
      await supabase
        .from("approved_guilds")
        .update({ lb_msg_guilds: newMsgId })
        .eq("guild_id", guildId);
    }

    const lbName = await getGuildName(guildId);
    console.log(`[Leaderboard] Updated for ${lbName}.`);

  } catch (err) {
    console.error("[Leaderboard] Update failed:", err);
  }
}

// ─── Send new message or edit existing one ───
async function sendOrEditMessage(channel, currentId, payload) {
  if (currentId) {
    try {
      const msg = await channel.messages.fetch(currentId);
      await msg.edit(payload);
      return currentId;
    } catch (_) {
      // Message deleted or not found — send new
    }
  }
  try {
    const newMsg = await channel.send(payload);
    return newMsg.id;
  } catch (err) {
    console.error(`[Leaderboard] Failed to send message in channel ${channel.id}:`, err.message);
    return null;
  }
}

// ─── Re-render leaderboard on sort or page change ───
async function renderRosterPage(guildId, sortKey = "seniority", page = 0) {
  const { data: guildRow } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, net_worth, runs, embed_color, avatar_url, founder, manager")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (!guildRow) return null;

  const guildConfig = await getGuildConfig(guildId);

  const { data: statsRows } = await supabase
    .from("player_stats")
    .select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(id, username, display_name, discord_id, guild_id, guild_tag, created_at)")
    .eq("players.guild_id", guildId);

  return buildCombinedVTCLeaderboard({
    guildRow,
    statsRows: statsRows || [],
    guildConfig,
    page,
    sortKey
  });
}

// ─── Reset leaderboard to default sort at 9 AM IST (called by cron) ───
async function resetRosterToDefault(client, guildId) {
  try {
    const guildConfig = await getGuildConfig(guildId);
    if (!guildConfig.leaderboard_channel_id) return;

    const { data: guildRow } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_name, guild_tag, net_worth, runs, embed_color, avatar_url, lb_msg_guilds, founder, manager")
      .eq("guild_id", guildId)
      .maybeSingle();

    if (!guildRow) return;

    const msgId = (guildRow.lb_msg_guilds || "").split(",")[0]?.trim();
    if (!msgId) return;

    const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch(() => null);
    if (!channel) return;

    const { data: statsRows } = await supabase
      .from("player_stats")
      .select("total_score, total_time_minutes, total_stars, total_distance_km, clean_deliveries, players!inner(id, username, display_name, discord_id, guild_id, guild_tag, created_at)")
      .eq("players.guild_id", guildId);

    const payload = buildCombinedVTCLeaderboard({
      guildRow,
      statsRows: statsRows || [],
      guildConfig,
      page: 0,
      sortKey: "seniority"
    });

    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit(payload);
      console.log(`[Roster Reset] Reset leaderboard to default for ${guildRow.guild_name}`);
    } catch (_) {}

  } catch (err) {
    console.error(`[Roster Reset] Failed for ${guildId}:`, err.message);
  }
}

// ─── HQ Server: Global dashboard (3 Components v2 Containers in 1 message) ───
const HQ_SORT_CONFIG = {
  distance: { label: "Distance", emoji: "🛤️", col: "total_distance_km", fmt: r => formatDistance(r.total_distance_km) },
  time:     { label: "Drive Time", emoji: "⏱️", col: "total_time_minutes", fmt: r => formatHours(r.total_time_minutes) },
  score:    { label: "Total Score", emoji: "🏆", col: "total_score", fmt: r => `${Math.round(r.total_score || 0).toLocaleString()} pts` },
  stars:    { label: "Total Stars", emoji: "⭐", col: "total_stars", fmt: r => `${Math.round(r.total_stars || 0).toLocaleString()} ★` },
  clean:    { label: "Clean Deliveries", emoji: "✅", col: "clean_deliveries", fmt: r => `${(r.clean_deliveries || 0).toLocaleString()} clean` },
};

const HQ_SORT_ORDER = ["distance", "time", "score", "stars", "clean"];

function nextHqSort(current) {
  const idx = HQ_SORT_ORDER.indexOf(current);
  return HQ_SORT_ORDER[(idx + 1) % HQ_SORT_ORDER.length];
}

async function fetchHQLBSlice(activeGuildIds, sortKey, page) {
  const cfg = HQ_SORT_CONFIG[sortKey] || HQ_SORT_CONFIG.distance;
  const pageSize = 5;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, count } = await supabase
    .from("player_stats")
    .select(`${cfg.col}, players!inner(username, display_name, guild_tag, guild_id)`, { count: "exact" })
    .or(`guild_id.in.(${activeGuildIds.join(",")}),guild_id.is.null`, { referencedTable: "players" })
    .gt(cfg.col, 0)
    .order(cfg.col, { ascending: false })
    .range(from, to);

  return { rows: data || [], total: count || 0, cfg };
}

function buildHQLeaderboardContainer(lbIndex, sortKey, page, slice, otherSort, otherPage, accentColor) {
  const { rows, total, cfg } = slice;
  const totalPages = Math.max(1, Math.ceil(total / 5));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const nextSortKey = nextHqSort(sortKey);
  const nextSortCfg = HQ_SORT_CONFIG[nextSortKey];

  const lines = rows.length > 0
    ? rows.map((row, i) => {
        const rank = safePage * 5 + i + 1;
        const tag = row.players?.guild_tag ? `\`${row.players.guild_tag}\` ` : "";
        const name = row.players?.display_name || row.players?.username || "Unknown";
        return `**#${rank}** ${tag}**${name}** — ${cfg.fmt(row)}`;
      }).join("\n")
    : "*No drivers recorded yet.*";

  const prevState = lbIndex === 1
    ? `hq_lb:1:${sortKey}:${safePage - 1}:${otherSort}:${otherPage}`
    : `hq_lb:2:${otherSort}:${otherPage}:${sortKey}:${safePage - 1}`;
  const nextState = lbIndex === 1
    ? `hq_lb:1:${sortKey}:${safePage + 1}:${otherSort}:${otherPage}`
    : `hq_lb:2:${otherSort}:${otherPage}:${sortKey}:${safePage + 1}`;
  const sortState = lbIndex === 1
    ? `hq_lb:1:${nextSortKey}:0:${otherSort}:${otherPage}`
    : `hq_lb:2:${otherSort}:${otherPage}:${nextSortKey}:0`;

  return {
    type: 17,
    accent_color: accentColor,
    components: [
      { type: 10, content: `### ${cfg.emoji} ${cfg.label} Leaderboard (Global)\n-# Page ${safePage + 1}/${totalPages} • Top 5 per page • Whole Network` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: lines },
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Prev", emoji: { name: "◀️" }, custom_id: prevState, disabled: safePage === 0 },
          { type: 2, style: 2, label: `${safePage + 1} / ${totalPages}`, custom_id: `hq_noop:${lbIndex}`, disabled: true },
          { type: 2, style: 1, label: "Next", emoji: { name: "▶️" }, custom_id: nextState, disabled: safePage >= totalPages - 1 },
          { type: 2, style: 2, label: `Sort: ${nextSortCfg.label}`, emoji: { name: "🔀" }, custom_id: sortState }
        ]
      }
    ]
  };
}

async function buildHQComponentsPayload(guildConfig, lb1Sort = "distance", lb1Page = 0, lb2Sort = "time", lb2Page = 0) {
  const { data: activeGuildsRaw } = await supabase.from("approved_guilds").select("guild_id").eq("is_suspended", false);
  const activeGuildIds = activeGuildsRaw ? activeGuildsRaw.map(g => g.guild_id) : [];
  if (activeGuildIds.length === 0) return null;

  const [
    { count: totalPlayers },
    { data: allStats },
    { data: guildsData },
    lb1Slice,
    lb2Slice
  ] = await Promise.all([
    supabase.from("players").select("*", { count: "exact", head: true }),
    supabase.from("player_stats").select("total_distance_km, total_time_minutes"),
    supabase.from("approved_guilds").select("guild_id, guild_tag, guild_name").eq("is_suspended", false),
    fetchHQLBSlice(activeGuildIds, lb1Sort, lb1Page),
    fetchHQLBSlice(activeGuildIds, lb2Sort, lb2Page),
  ]);

  const activeVTCCount  = (guildsData || []).filter(g => g.guild_id !== process.env.HQ_GUILD_ID).length;
  const totalDistanceKm = (allStats || []).reduce((s, r) => s + (Number(r.total_distance_km)  || 0), 0);
  const totalTimeMin    = (allStats || []).reduce((s, r) => s + (Number(r.total_time_minutes) || 0), 0);
  const accentColor = guildConfig?.embed_color || 0xff7801;

  const statusContainer = {
    type: 17,
    accent_color: accentColor,
    components: [
      { type: 10, content: "# 🌐 UVS — Network Status\n-# Live statistics across all registered VTCs and Independent Drivers." },
      { type: 14, divider: true, spacing: 1 },
      {
        type: 10,
        content:
          `${E.drivers} **Registered Truckers:** \`${(totalPlayers || 0).toLocaleString()}\`\n` +
          `🏢 **Unified VTCs:** \`${activeVTCCount}\`\n` +
          `${E.distance} **Total Distance:** \`${formatDistance(totalDistanceKm)}\`\n` +
          `${E.time} **Total Drive Time:** \`${formatHours(totalTimeMin)}\``
      },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: "-# Managed by NMC • Use bot commands for full leaderboards" }
    ]
  };

  const lb1Container = buildHQLeaderboardContainer(1, lb1Sort, lb1Page, lb1Slice, lb2Sort, lb2Page, accentColor);
  const lb2Container = buildHQLeaderboardContainer(2, lb2Sort, lb2Page, lb2Slice, lb1Sort, lb1Page, accentColor);

  return {
    embeds: [],
    components: [statusContainer, lb1Container, lb2Container],
    flags: 32768
  };
}

async function performHQLeaderboardUpdate(client, guildId, guildConfig, guildRow) {
  const channel = await client.channels.fetch(guildConfig.leaderboard_channel_id).catch(async (err) => {
    console.error(`[Leaderboard][HQ] Cannot fetch channel:`, err.message);
    return null;
  });
  if (!channel) return;

  const payload = await buildHQComponentsPayload(guildConfig, "distance", 0, "time", 0);
  if (!payload) return;

  const currentId = (guildRow.lb_msg_guilds || "").split(",")[0]?.trim() || null;
  const newId = await sendOrEditMessage(channel, currentId, payload);
  if (newId && newId !== guildRow.lb_msg_guilds) {
    await supabase.from("approved_guilds").update({ lb_msg_guilds: newId }).eq("guild_id", guildId);
  }
}

async function renderHQLeaderboardPage(guildId, lb1Sort = "distance", lb1Page = 0, lb2Sort = "time", lb2Page = 0) {
  const guildConfig = await getGuildConfig(guildId);
  return buildHQComponentsPayload(guildConfig, lb1Sort, lb1Page, lb2Sort, lb2Page);
}

// ─────────────────────────────────────────────────────────────
// GLOBAL WEBHOOK SUPPORT
// ─────────────────────────────────────────────────────────────

let globalWebhookUpdating = false;
let globalWebhookNeedsUpdate = false;

async function updateGlobalWebhook(client, guildId = null) {
  if (globalWebhookUpdating) {
    globalWebhookNeedsUpdate = true;
    return;
  }
  globalWebhookUpdating = true;
  try {
    await performGlobalWebhookUpdate(client, guildId);
  } finally {
    globalWebhookUpdating = false;
    if (globalWebhookNeedsUpdate) {
      globalWebhookNeedsUpdate = false;
      setTimeout(() => updateGlobalWebhook(client, guildId), 5000);
    }
  }
}

async function performGlobalWebhookUpdate(client, guildId = null) {
  const webhookUrlsStr = process.env.GLOBAL_LB_WEBHOOK_URL;
  if (!webhookUrlsStr) return;

  const webhookUrls = webhookUrlsStr.split(",").map(url => url.trim()).filter(url => url.length > 0);
  if (webhookUrls.length === 0) return;

  try {
    let guildsQuery = supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag, guild_name, net_worth, embed_color, webhook_id, avatar_url, runs, founder, manager, temp_suspension")
      .eq("is_suspended", false);

    if (guildId) guildsQuery = guildsQuery.eq("guild_id", guildId);

    const { data: guildsData } = await guildsQuery;

    let guildStatsQuery = supabase
      .from("player_stats")
      .select("total_time_minutes, total_distance_km, players!inner(guild_id)");

    if (guildId) guildStatsQuery = guildStatsQuery.eq("players.guild_id", guildId);

    const { data: guildStats } = await guildStatsQuery;

    if (!guildsData) return;

    const guildAggregates = new Map();
    for (const guild of guildsData) {
      guildAggregates.set(guild.guild_id, {
        ...guild,
        total_income:       Number(guild.net_worth) || 0,
        total_runs:         Number(guild.runs)       || 0,
        total_time_minutes: 0,
        total_distance_km:  0,
        driver_count:       0
      });
    }

    if (guildStats) {
      for (const stat of guildStats) {
        const gid = stat.players?.guild_id;
        if (!gid || !guildAggregates.has(gid)) continue;
        const agg = guildAggregates.get(gid);
        agg.total_time_minutes += Number(stat.total_time_minutes || 0);
        agg.total_distance_km  += Number(stat.total_distance_km  || 0);
        agg.driver_count += 1;
      }
    }

    for (const guild of guildAggregates.values()) {
      if (guild.guild_id === process.env.HQ_GUILD_ID) continue;

      // Temp-suspended: delete card and clear webhook_id
      if (guild.temp_suspension) {
        const storedIds = guild.webhook_id ? String(guild.webhook_id).split(",").map(id => id.trim()) : [];
        for (let idx = 0; idx < webhookUrls.length; idx++) {
          const messageId = storedIds[idx] || null;
          if (!messageId) continue;
          try {
            const wc = new WebhookClient({ url: webhookUrls[idx] });
            await wc.deleteMessage(messageId);
            console.log(`[Global Webhook] Deleted temp-suspended card for ${guild.guild_name}`);
          } catch (_) {}
        }
        if (guild.webhook_id) {
          await supabase.from("approved_guilds").update({ webhook_id: null }).eq("guild_id", guild.guild_id);
        }
        continue;
      }

      // Role lines for webhook card
      const founderDiscordId  = guild.founder || null;
      const managerDiscordIds = guild.manager ? guild.manager.split(",").map(m => m.trim()).filter(Boolean) : [];

      const founderLine  = founderDiscordId  ? `<:founder:1567953792652156989> **Founder:** <@${founderDiscordId}>\n` : "";
      const managersLine = managerDiscordIds.length > 0
        ? `<:manager:1567953799291740253> **Managers:** ${managerDiscordIds.map(id => `<@${id}>`).join(", ")}\n`
        : "";

      const description =
        `${founderLine}` +
        `${managersLine}` +
        (founderLine || managersLine ? "\n" : "") +
        `<:networth:1567953794669481994> **Net Worth:** \$${formatCompact(guild.total_income)}\n` +
        `<:drivers:1567953797094051911> **Drivers:** ${guild.driver_count}\n` +
        `<:time:1567953802022359112> **Time:** ${formatHours(guild.total_time_minutes)}\n` +
        `<:distance:1567953812189225121> **Distance:** ${formatDistance(guild.total_distance_km)}\n` +
        `<:runs:1567953790072524821> **Runs:** ${guild.total_runs}`;

      let parsedColor = 0xffffff;
      if (typeof guild.embed_color === "number") parsedColor = guild.embed_color;
      else if (typeof guild.embed_color === "string") parsedColor = parseInt(guild.embed_color.replace("#", ""), 16);
      if (isNaN(parsedColor) || parsedColor > 16777215 || parsedColor < 0) parsedColor = 0xffffff;

      const { data: latestRun } = await supabase
        .from("runs")
        .select("created_at, players!inner(guild_id)")
        .eq("players.guild_id", guild.guild_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let footerText = "• No jobs logged yet •";
      if (latestRun?.created_at) {
        footerText = `• Latest Job • ${new Date(latestRun.created_at).toLocaleString()}`;
      }

      const embed = {
        title: `🏢 ${guild.guild_tag || "[VTC]"} ${guild.guild_name || "Unknown Guild"}`,
        description,
        color: parsedColor,
        thumbnail: guild.avatar_url ? { url: guild.avatar_url } : undefined,
        footer: { text: footerText }
      };

      const storedIds = guild.webhook_id ? String(guild.webhook_id).split(",").map(id => id.trim()) : [];
      const newIds = [];

      for (let idx = 0; idx < webhookUrls.length; idx++) {
        const url = webhookUrls[idx];
        const messageId = storedIds[idx] || null;
        const webhookClient = new WebhookClient({ url });

        let sentId = null;
        if (messageId) {
          try {
            await webhookClient.editMessage(messageId, { content: null, embeds: [embed] });
            sentId = messageId;
          } catch (err) {
            console.warn(`[Global Webhook] Failed to edit msg ${messageId} on webhook ${idx}: ${err.message}. Sending new...`);
          }
        }

        if (!sentId) {
          try {
            const sentMessage = await webhookClient.send({ content: null, embeds: [embed] });
            sentId = sentMessage.id;
            console.log(`[Global Webhook] Sent new embed on webhook ${idx} (ID: ${sentId})`);
          } catch (err) {
            console.error(`[Global Webhook] Failed to send to webhook ${idx}:`, err.message);
          }
        }

        newIds.push(sentId || messageId || "");
      }

      const serializedIds = newIds.join(",");
      if (serializedIds !== guild.webhook_id) {
        await supabase
          .from("approved_guilds")
          .update({ webhook_id: serializedIds })
          .eq("guild_id", guild.guild_id);
      }
    }

  } catch (err) {
    console.error("Global Webhook update failed:", err);
  }
}

module.exports = {
  updateLeaderboard,
  updateGlobalWebhook,
  renderRosterPage,
  renderHQLeaderboardPage,
  resetRosterToDefault,
};
