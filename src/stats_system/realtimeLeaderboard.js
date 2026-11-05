const cron = require("node-cron");
const { supabase } = require("./supabase");
const { updateLeaderboard, resetRosterToDefault } = require("./leaderboardService");

function registerLeaderboardRealtime(client) {
  let lastUpdate = 0;
  const MIN_INTERVAL = 3000; // 3 seconds

  // In-memory cache to detect meaningful changes and ignore self-updates (lb_msg_guilds, webhook_id, timestamps)
  const guildStateCache = new Map();

  supabase
    .channel("guild-income-changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "approved_guilds"
      },
      async (payload) => {
        try {
          const newData = payload.new;
          if (!newData || !newData.guild_id) return;

          const gid = newData.guild_id;
          const cached = guildStateCache.get(gid);

          const currentState = {
            guild_income:    newData.guild_income,
            net_worth:       newData.net_worth,
            runs:            newData.runs,
            founder:         newData.founder,
            manager:         newData.manager,
            temp_suspension: newData.temp_suspension,
          };

          if (cached) {
            const hasMeaningfulChange =
              cached.guild_income !== currentState.guild_income ||
              cached.net_worth !== currentState.net_worth ||
              cached.runs !== currentState.runs ||
              cached.founder !== currentState.founder ||
              cached.manager !== currentState.manager ||
              cached.temp_suspension !== currentState.temp_suspension;

            if (!hasMeaningfulChange) {
              // Ignore updates caused by lb_msg_guilds, webhook_id, or metadata
              return;
            }
          }

          // Update cache with the new meaningful values
          guildStateCache.set(gid, currentState);

          if (Date.now() - lastUpdate < MIN_INTERVAL) return;
          lastUpdate = Date.now();

          console.log(`[REALTIME] Guild stats/income updated: [${newData.guild_tag || gid}]`);

          // Only update the affected guild, NOT all 16 guilds!
          await updateLeaderboard(client, gid).catch(console.error);

          // If HQ is configured and different from the affected guild, update HQ too
          if (process.env.HQ_GUILD_ID && gid !== process.env.HQ_GUILD_ID) {
            await updateLeaderboard(client, process.env.HQ_GUILD_ID).catch(console.error);
          }
        } catch (err) {
          console.error("Realtime leaderboard update failed:", err);
        }
      }
    )
    .subscribe((status) => {
      console.log("[REALTIME] Leaderboard channel status:", status);
    });

  // ─── 9:00 AM IST daily: reset all roster embeds to default sort ───
  // 9:00 AM IST = 03:30 UTC
  cron.schedule("30 3 * * *", async () => {
    console.log("[Roster Reset] Running daily 9 AM IST roster reset...");
    try {
      const { data: guilds } = await supabase
        .from("approved_guilds")
        .select("guild_id")
        .eq("is_suspended", false);

      if (guilds) {
        for (const guild of guilds) {
          await resetRosterToDefault(client, guild.guild_id).catch(err =>
            console.error(`[Roster Reset] Failed for ${guild.guild_id}:`, err.message)
          );
        }
      }
      console.log("[Roster Reset] Done.");
    } catch (err) {
      console.error("[Roster Reset] Cron error:", err);
    }
  });

  console.log("✅ [Roster Reset] Cron scheduled for 9:00 AM IST daily.");
}

module.exports = { registerLeaderboardRealtime };
