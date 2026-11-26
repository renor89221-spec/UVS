const { supabase } = require("./supabase");

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function sendHeartbeat() {
  try {
    const { error } = await supabase
      .from("bot_heartbeats")
      .upsert(
        {
          bot_name: "uvs",
          last_ping: new Date().toISOString(),
          status: "online",
        },
        { onConflict: "bot_name" }
      );

    if (error) {
      console.warn("[Heartbeat] Failed to update bot_heartbeats:", error.message);
    }
  } catch (err) {
    console.warn("[Heartbeat] Error sending heartbeat:", err.message);
  }
}

function startHeartbeat() {
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  console.log("💓 [Heartbeat] UVS 5-minute heartbeat started.");
}

module.exports = { startHeartbeat, sendHeartbeat };
