/**
 * src/commands/ownerCmds.js
 * Owner-only administrative commands:
 *   /set-founder
 *   /set-manager
 *   /approve-guild
 *   /temp-suspend
 *   /owner-cmds
 */

const { supabase } = require("../stats_system/supabase");
const { isOwner } = require("../owner");
const { clearGuildConfigCache } = require("../stats_system/guildConfig");

// ─── /set-founder ───────────────────────────────────────────────────────────
async function setfounder(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const isHQ = interaction.guild?.id === process.env.HQ_GUILD_ID;
  if (!isHQ)
    return interaction.editReply("❌ This command can only be used in the HQ/VTC Hub server.");

  // Accept either user mention or raw ID string
  const userOption    = interaction.options.getUser("user", false);
  const userIdOption  = interaction.options.getString("user_id", false);
  const guildIdOption = interaction.options.getString("guild_id", true);

  const targetDiscordId = userOption?.id || userIdOption;
  if (!targetDiscordId)
    return interaction.editReply("❌ Please provide either a user mention or a user ID.");

  // Check the target guild exists
  const { data: targetGuild } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, founder")
    .eq("guild_id", guildIdOption)
    .maybeSingle();

  if (!targetGuild)
    return interaction.editReply(`❌ No approved guild found with ID \`${guildIdOption}\`.`);

  const { error } = await supabase
    .from("approved_guilds")
    .update({ founder: targetDiscordId })
    .eq("guild_id", guildIdOption);

  if (error)
    return interaction.editReply(`❌ Database error: ${error.message}`);

  clearGuildConfigCache(guildIdOption);

  return interaction.editReply(
    `✅ Set <@${targetDiscordId}> as **Founder** of **${targetGuild.guild_name}** (${targetGuild.guild_tag}).`
  );
}

// ─── /set-manager ───────────────────────────────────────────────────────────
async function setmanager(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const isHQ = interaction.guild?.id === process.env.HQ_GUILD_ID;
  if (!isHQ)
    return interaction.editReply("❌ This command can only be used in the HQ/VTC Hub server.");

  const userOption    = interaction.options.getUser("user",    false);
  const userIdOption  = interaction.options.getString("user_id", false);
  const guildIdOption = interaction.options.getString("guild_id", true);
  const action        = interaction.options.getString("action", true); // "add" | "remove"

  const targetDiscordId = userOption?.id || userIdOption;
  if (!targetDiscordId)
    return interaction.editReply("❌ Please provide either a user mention or a user ID.");

  const { data: targetGuild } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, manager")
    .eq("guild_id", guildIdOption)
    .maybeSingle();

  if (!targetGuild)
    return interaction.editReply(`❌ No approved guild found with ID \`${guildIdOption}\`.`);

  let managers = targetGuild.manager
    ? targetGuild.manager.split(",").map(m => m.trim()).filter(Boolean)
    : [];

  if (action === "add") {
    if (managers.includes(targetDiscordId))
      return interaction.editReply(`ℹ️ <@${targetDiscordId}> is already a manager of **${targetGuild.guild_name}**.`);
    managers.push(targetDiscordId);
  } else {
    if (!managers.includes(targetDiscordId))
      return interaction.editReply(`ℹ️ <@${targetDiscordId}> is not currently a manager of **${targetGuild.guild_name}**.`);
    managers = managers.filter(m => m !== targetDiscordId);
  }

  const { error } = await supabase
    .from("approved_guilds")
    .update({ manager: managers.length > 0 ? managers.join(",") : null })
    .eq("guild_id", guildIdOption);

  if (error)
    return interaction.editReply(`❌ Database error: ${error.message}`);

  clearGuildConfigCache(guildIdOption);

  const verb = action === "add" ? "Added" : "Removed";
  const prep = action === "add" ? "to"    : "from";
  return interaction.editReply(
    `✅ ${verb} <@${targetDiscordId}> ${prep} managers of **${targetGuild.guild_name}** (${targetGuild.guild_tag}).`
  );
}

// ─── /approve-guild ─────────────────────────────────────────────────────────
async function approveguild(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const guild_id               = interaction.options.getString("guild_id",               true);
  const guild_name             = interaction.options.getString("guild_name",             true);
  const guild_tag              = interaction.options.getString("guild_tag",              true);
  const avatar_url             = interaction.options.getString("avatar_url",             true);
  const embed_color_hex        = interaction.options.getString("embed_color",            false) || "FF7801";
  const screenshot_channel_id  = interaction.options.getString("screenshot_channel_id", false) || null;
  const leaderboard_channel_id = interaction.options.getString("leaderboard_channel_id",false) || null;

  // Parse embed_color
  let embed_color = 0xff7801;
  try {
    embed_color = parseInt(embed_color_hex.replace("#", ""), 16);
    if (isNaN(embed_color) || embed_color < 0 || embed_color > 16777215) embed_color = 0xff7801;
  } catch (_) {}

  const { error } = await supabase.from("approved_guilds").upsert({
    guild_id,
    guild_name,
    guild_tag,
    avatar_url,
    embed_color,
    screenshot_channel_id,
    leaderboard_channel_id,
    is_suspended: false,
    temp_suspension: false,
  }, { onConflict: "guild_id" });

  if (error)
    return interaction.editReply(`❌ Failed to approve guild: ${error.message}`);

  return interaction.editReply(
    `✅ Guild **${guild_name}** (\`${guild_id}\`) approved successfully!\n` +
    `Tag: **${guild_tag}** | Color: **#${embed_color.toString(16).padStart(6, "0").toUpperCase()}**`
  );
}

// ─── /temp-suspend ──────────────────────────────────────────────────────────
async function tempsuspend(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const targetId = interaction.options.getString("guild_id", true);

  const { data: targetGuild } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, webhook_id, temp_suspension")
    .eq("guild_id", targetId)
    .maybeSingle();

  if (!targetGuild)
    return interaction.editReply(`❌ No approved guild found with ID \`${targetId}\`.`);

  if (targetGuild.temp_suspension)
    return interaction.editReply(`ℹ️ **${targetGuild.guild_name}** is already temp-suspended.`);

  // Set temp_suspension = true — the webhook update loop will delete their card
  const { error } = await supabase
    .from("approved_guilds")
    .update({ temp_suspension: true })
    .eq("guild_id", targetId);

  if (error)
    return interaction.editReply(`❌ Database error: ${error.message}`);

  // Try to delete webhook card immediately
  const webhookUrlsStr = process.env.GLOBAL_LB_WEBHOOK_URL;
  if (webhookUrlsStr && targetGuild.webhook_id) {
    const { WebhookClient } = require("discord.js");
    const webhookUrls = webhookUrlsStr.split(",").map(u => u.trim()).filter(Boolean);
    const storedIds   = String(targetGuild.webhook_id).split(",").map(id => id.trim());

    for (let idx = 0; idx < webhookUrls.length; idx++) {
      const messageId = storedIds[idx] || null;
      if (!messageId) continue;
      try {
        const wc = new WebhookClient({ url: webhookUrls[idx] });
        await wc.deleteMessage(messageId);
        console.log(`[temp-suspend] Deleted webhook card for ${targetGuild.guild_name}`);
      } catch (err) {
        console.warn(`[temp-suspend] Could not delete webhook card: ${err.message}`);
      }
    }

    await supabase.from("approved_guilds").update({ webhook_id: null }).eq("guild_id", targetId);
  }

  return interaction.editReply(
    `✅ Temp-suspended **${targetGuild.guild_name}** (${targetGuild.guild_tag}). Their VTC card has been removed from the webhook. Stats and leaderboard remain intact.`
  );
}

// ─── /lift-temp-suspend ─────────────────────────────────────────────────────
async function lifttempsuspend(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const targetId = interaction.options.getString("guild_id", true);

  const { data: targetGuild } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_name, guild_tag, temp_suspension")
    .eq("guild_id", targetId)
    .maybeSingle();

  if (!targetGuild)
    return interaction.editReply(`❌ No approved guild found with ID \`${targetId}\`.`);

  if (!targetGuild.temp_suspension)
    return interaction.editReply(`ℹ️ **${targetGuild.guild_name}** is not temp-suspended.`);

  const { error } = await supabase
    .from("approved_guilds")
    .update({ temp_suspension: false })
    .eq("guild_id", targetId);

  if (error)
    return interaction.editReply(`❌ Database error: ${error.message}`);

  return interaction.editReply(
    `✅ Lifted temp-suspension for **${targetGuild.guild_name}** (${targetGuild.guild_tag}). Their VTC card will appear again on the next webhook update.`
  );
}

// ─── /owner-cmds ────────────────────────────────────────────────────────────
async function ownercmds(interaction) {
  if (!isOwner(interaction.user.id))
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const embed = {
    title: "🔑 Owner-Only Commands Reference",
    color: 0x2f3136,
    fields: [
      {
        name: "🏢 Guild Management",
        value: [
          "`/approve-guild` — Add a new VTC to the approved guilds table (guild_id, name, tag, avatar_url, embed_color, screenshot_channel_id, leaderboard_channel_id)",
          "`/suspendvtc <guild_id>` — Fully suspend a VTC (removes from leaderboards, bot leaves server)",
          "`/restorevtc <guild_id>` — Restore a fully suspended VTC",
          "`/temp-suspend <guild_id>` — Remove VTC's global webhook card without suspending their account",
          "`/lift-temp-suspend <guild_id>` — Restore a temp-suspended VTC's webhook card",
        ].join("\n"),
        inline: false
      },
      {
        name: "👑 Role Assignment",
        value: [
          "`/set-founder <guild_id> [user] [user_id]` — Set the Founder of a VTC (shown on leaderboard & webhook)",
          "`/set-manager <guild_id> [user] [user_id] <action: add|remove>` — Add or remove a Manager of a VTC",
        ].join("\n"),
        inline: false
      },
      {
        name: "📊 Player Management",
        value: [
          "`/clearstats <user>` — Reset a player's stats completely",
          "`/suspenduser <user> <reason>` — Suspend a player and remove their contributions",
          "`/changeguild <user>` — Move a player to a different VTC",
          "`/changelevel <new_level> [user] [user_id] [username]` — Override a player's career level",
        ].join("\n"),
        inline: false
      },
      {
        name: "🔧 Bot Utilities",
        value: [
          "`/codes` — View job log error codes",
          "`/activateunbeconomy` — Enable UnbelievaBoat economy for this server",
          "`/owner-cmds` — Show this reference",
        ].join("\n"),
        inline: false
      },
    ],
    footer: { text: "Owner-only • Commands only work for the configured OWNER_ID" }
  };

  return interaction.editReply({ embeds: [embed] });
}

module.exports = {
  setfounder,
  setmanager,
  approveguild,
  tempsuspend,
  lifttempsuspend,
  ownercmds,
};
