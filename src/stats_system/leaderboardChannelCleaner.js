/**
 * leaderboardChannelCleaner.js
 *
 * Deletes all messages in each guild's leaderboard channel
 * EXCEPT the ones stored in lb_msg_guilds as "statsId,rosterId" (VTC stats card + driver roster).
 *
 * - Runs on bot restart
 * - Scheduled daily at 1:00 AM IST (UTC+5:30 = 19:30 UTC previous day → cron "30 19 * * *")
 */

const cron = require("node-cron");
const { supabase } = require("./supabase");

async function cleanLeaderboardChannels(client) {
  console.log("🧹 [LeaderboardCleaner] Starting leaderboard channel cleanup...");

  const { data: guilds, error } = await supabase
    .from("approved_guilds")
    .select("guild_id, guild_tag, leaderboard_channel_id, lb_msg_guilds");

  if (error || !guilds) {
    console.error("❌ [LeaderboardCleaner] Failed to fetch guilds:", error?.message);
    return;
  }

  for (const guild of guilds) {
    if (!guild.leaderboard_channel_id) {
      console.log(`⏭️  [LeaderboardCleaner] [${guild.guild_tag}] No leaderboard_channel_id — skipping.`);
      continue;
    }

    console.log(`🔍 [LeaderboardCleaner] [${guild.guild_tag}] Cleaning channel ${guild.leaderboard_channel_id} ...`);

    let channel;
    try {
      channel = await client.channels.fetch(guild.leaderboard_channel_id);
    } catch (err) {
      console.warn(`  ⚠️  [LeaderboardCleaner] Could not fetch channel: ${err.message}`);
      continue;
    }

    let messages;
    try {
      messages = await channel.messages.fetch({ limit: 100 });
    } catch (err) {
      console.warn(`  ⚠️  [LeaderboardCleaner] Could not fetch messages: ${err.message}`);
      continue;
    }

    // Keep both the stats embed AND the roster embed (stored as "statsId,rosterId" in lb_msg_guilds)
    const keepIds = new Set(
      (guild.lb_msg_guilds || "").split(",").map((s) => s.trim()).filter(Boolean)
    );

    let deleted = 0;
    let skipped = 0;

    for (const [id, msg] of messages) {
      if (keepIds.has(id)) {
        skipped++;
        continue;
      }
      try {
        await msg.delete();
        deleted++;
        console.log(`  🗑️  Deleted message ${id}`);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.warn(`  ⚠️  [LeaderboardCleaner] Could not delete ${id}: ${err.message}`);
      }
    }

    console.log(`  ✔️  [LeaderboardCleaner] [${guild.guild_tag}] Done — deleted ${deleted}, kept ${skipped}.`);
  }

  console.log("✅ [LeaderboardCleaner] All leaderboard channels cleaned.");
}

function registerLeaderboardChannelCleaner(client) {
  // Schedule daily at 1:00 AM IST (UTC = 19:30 previous day)
  cron.schedule("30 19 * * *", () => {
    cleanLeaderboardChannels(client);
  });

  console.log("✅ [LeaderboardCleaner] Cron scheduled for 1:00 AM IST daily.");

  // Fire immediately on bot restart
  cleanLeaderboardChannels(client);
}

module.exports = { registerLeaderboardChannelCleaner, cleanLeaderboardChannels };
