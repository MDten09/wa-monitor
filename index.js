const express = require("express");
console.log("ENV CHECK - MY_MAIN_NUMBER:", process.env.MY_MAIN_NUMBER ? "SET" : "NOT SET");
console.log("ENV CHECK - ANTHROPIC_KEY:", process.env.ANTHROPIC_KEY ? "SET" : "NOT SET");
console.log("ENV CHECK - WA_TOKEN:", process.env.WA_TOKEN ? "SET" : "NOT SET");
const axios = require("axios");
const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  // Fill these after Meta setup
  VERIFY_TOKEN: "mayank_wa_monitor_2026",        // You choose this string
  WA_TOKEN: process.env.WA_TOKEN || "",          // From Meta dashboard
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID || "", // From Meta dashboard
  MY_MAIN_NUMBER: process.env.MY_MAIN_NUMBER || "",   // Your personal WA number with country code e.g. 919XXXXXXX
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY || "",     // From console.anthropic.com
  ALERT_COOLDOWN_MINUTES: 30,  // Don't re-alert same group within this many minutes
  NO_RESPONSE_ALERT_HOURS: 2,  // Alert if client message unanswered after this many hours
  DIGEST_HOUR: 19,             // 7 PM evening digest
};

// ─── GROUP CLASSIFICATION ──────────────────────────────────────────────────
// Add your group IDs here after setup (you'll find them in webhook logs)
const GROUP_CONFIG = {
  client_groups: [
    // "120363XXXXXXXXX@g.us",  // Nykaa group
    // "120363XXXXXXXXX@g.us",  // Ujjivan group
    // Add all 100 client groups here
  ],
  internal_groups: [
    // "120363XXXXXXXXX@g.us",  // Pan Ops group
  ],
};

// ─── YOUR TEAM MEMBERS ─────────────────────────────────────────────────────
// Names/numbers of YOUR team (Tenon team) - used to detect if team has replied
const TENON_TEAM_IDENTIFIERS = [
  "Anish Bhasin", "Manoj Singh", "Mohit Juneja", "Namrata Shukla",
  "Bedabrata Rath", "Sanjay Dutta", "Ashish Dixit", "raghvendra singh",
  "Mahendra Sethi", "Pankaj Kadam", "Kalpak Malankar", "Kannan N",
  "Nandini", "Saddam Gujarat", "Omer Pasha", "Vinodh",
  // Add more team member names here
];

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────
const state = {
  // Track unanswered client messages: { groupId: { messageTime, messageText, senderName } }
  unansweredClientMessages: {},
  // Track asks in internal groups: { groupId: [ {asker, ask, time, respondents} ] }
  internalPendingAsks: {},
  // Alert cooldown: { groupId: lastAlertTime }
  alertCooldowns: {},
  // Today's digest items
  digestItems: { client: [], internal: [] },
};

// ─── WEBHOOK VERIFICATION ──────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── INCOMING MESSAGE HANDLER ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately to Meta

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const messages = value.messages || [];

        for (const msg of messages) {
          if (msg.type !== "text" && msg.type !== "image" && msg.type !== "document") continue;

          const groupId = msg.from; // For groups, this is group ID
          const senderId = msg.from;
          const senderName = getSenderName(value.contacts, senderId);
          const text = msg.text?.body || msg.caption || "[media]";
          const timestamp = parseInt(msg.timestamp) * 1000;

          console.log(`📨 Message from ${senderName} in ${groupId}: ${text.substring(0, 80)}`);

          const isClientGroup = GROUP_CONFIG.client_groups.includes(groupId);
          const isInternalGroup = GROUP_CONFIG.internal_groups.includes(groupId);
          const isTenonMember = isTenonTeam(senderName, senderId);

          if (isClientGroup) {
            await handleClientGroupMessage({ groupId, senderName, senderId, text, timestamp, isTenonMember });
          } else if (isInternalGroup) {
            await handleInternalGroupMessage({ groupId, senderName, senderId, text, timestamp, isTenonMember });
          }
        }
      }
    }
  } catch (err) {
    console.error("Error processing webhook:", err.message);
  }
});

// ─── CLIENT GROUP HANDLER ─────────────────────────────────────────────────
async function handleClientGroupMessage({ groupId, senderName, senderId, text, timestamp, isTenonMember }) {

  // If Tenon team replied, clear unanswered flag
  if (isTenonMember) {
    if (state.unansweredClientMessages[groupId]) {
      console.log(`✅ Team replied in client group ${groupId}`);
      delete state.unansweredClientMessages[groupId];
    }
    return;
  }

  // Client message — analyze with Claude
  const analysis = await analyzeMessage(text, "client");

  // Track as unanswered
  state.unansweredClientMessages[groupId] = {
    messageTime: timestamp,
    messageText: text,
    senderName,
    analysis,
  };

  // Immediate alert if critical
  if (analysis.isCritical) {
    await sendAlertToMe(
      `🔴 *CRITICAL MESSAGE — Client Group*\n\n` +
      `*From:* ${senderName}\n` +
      `*Message:* ${text}\n\n` +
      `*Why critical:* ${analysis.reason}\n\n` +
      `_Awaiting team response..._`
    );
  }

  // Check if tagged
  if (text.includes("@Mayank") || text.includes("Mayank Dixit")) {
    await sendAlertToMe(
      `📌 *YOU WERE TAGGED*\n\n` +
      `*From:* ${senderName}\n` +
      `*Message:* ${text}`
    );
  }

  // Add to digest
  state.digestItems.client.push({
    groupId, senderName, text, timestamp, analysis, resolved: false
  });
}

// ─── INTERNAL GROUP HANDLER ───────────────────────────────────────────────
async function handleInternalGroupMessage({ groupId, senderName, senderId, text, timestamp, isTenonMember }) {

  // Check if this is a response to an existing ask
  const asks = state.internalPendingAsks[groupId] || [];
  for (const ask of asks) {
    if (timestamp > ask.time && isTenonMember && senderName !== ask.asker) {
      ask.respondents = ask.respondents || [];
      ask.respondents.push(senderName);
    }
  }

  // Detect if this is a new ask/task directed at someone
  const askAnalysis = await analyzeMessage(text, "internal");

  if (askAnalysis.isAsk) {
    if (!state.internalPendingAsks[groupId]) state.internalPendingAsks[groupId] = [];
    state.internalPendingAsks[groupId].push({
      asker: senderName,
      ask: text,
      time: timestamp,
      respondents: [],
      tagged: askAnalysis.taggedPerson,
    });

    // Add to digest
    state.digestItems.internal.push({
      groupId, asker: senderName, ask: text, timestamp,
      tagged: askAnalysis.taggedPerson, resolved: false
    });
  }

  // Alert if you are tagged in internal group too
  if (text.includes("@Mayank") || text.includes("Mayank Dixit")) {
    await sendAlertToMe(
      `📌 *YOU WERE TAGGED — Internal Group*\n\n` +
      `*From:* ${senderName}\n` +
      `*Message:* ${text}`
    );
  }
}

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────
async function analyzeMessage(text, type) {
  try {
    const systemPrompt = type === "client"
      ? `You analyze WhatsApp messages in client groups for an FM/staffing company called Tenon.
         Tenon provides housekeeping staff to clients like Nykaa, Ujjivan Bank etc.
         
         Determine if a message is CRITICAL. Critical means any of:
         - Complaint about service failure (HK absent, reliever not arrived, cleaning not done)
         - Salary/payment issue causing staff to leave or threaten to leave
         - Client expressing strong frustration, urgency, or escalating to senior management
         - Site unmanned for hours or days
         - Client threatening consequences
         - Message pending for 2+ hours with no team response
         
         Respond ONLY with JSON: {"isCritical": true/false, "reason": "brief reason", "urgencyScore": 1-10}`
      : `You analyze WhatsApp messages in internal operations groups for an FM/staffing company called Tenon.
         
         Determine if this is an ASK/TASK directed at someone that needs a response or action.
         Examples: requests for DMR, billing, attendance, reliever arrangement, tracker sharing, salary processing.
         
         Respond ONLY with JSON: {"isAsk": true/false, "taggedPerson": "name or null", "taskType": "brief description or null"}`;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: "user", content: text }],
      },
      {
        headers: {
          "x-api-key": CONFIG.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const raw = response.data.content[0].text.trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("Claude analysis error:", err.message);
    return { isCritical: false, isAsk: false, reason: "analysis failed" };
  }
}

// ─── NO-RESPONSE CHECKER (runs every 15 minutes) ──────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [groupId, data] of Object.entries(state.unansweredClientMessages)) {
    const hoursElapsed = (now - data.messageTime) / (1000 * 60 * 60);

    if (hoursElapsed >= CONFIG.NO_RESPONSE_ALERT_HOURS) {
      // Check cooldown
      const lastAlert = state.alertCooldowns[groupId] || 0;
      const cooldownElapsed = (now - lastAlert) / (1000 * 60);

      if (cooldownElapsed >= CONFIG.ALERT_COOLDOWN_MINUTES) {
        state.alertCooldowns[groupId] = now;
        await sendAlertToMe(
          `⏰ *NO RESPONSE ALERT*\n\n` +
          `Client message has been unanswered for *${Math.floor(hoursElapsed)} hours*\n\n` +
          `*From:* ${data.senderName}\n` +
          `*Message:* ${data.messageText}\n\n` +
          `_Please follow up with your team immediately._`
        );
      }
    }
  }
}, 15 * 60 * 1000); // Every 15 minutes

// ─── EVENING DIGEST (runs every hour, triggers at 7 PM) ───────────────────
setInterval(async () => {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  if (hour === CONFIG.DIGEST_HOUR && minute < 10) {
    await sendEveningDigest();
  }
}, 10 * 60 * 1000); // Check every 10 minutes

async function sendEveningDigest() {
  const now = Date.now();
  let digest = `📊 *EVENING DIGEST — ${new Date().toLocaleDateString("en-IN")}*\n\n`;

  // ── Client issues ──
  const unresolvedClient = Object.entries(state.unansweredClientMessages);
  if (unresolvedClient.length > 0) {
    digest += `*🔴 UNRESOLVED CLIENT ISSUES (${unresolvedClient.length})*\n`;
    for (const [groupId, data] of unresolvedClient) {
      const hoursAgo = Math.floor((now - data.messageTime) / (1000 * 60 * 60));
      digest += `• ${data.senderName}: "${data.messageText.substring(0, 60)}..." _(${hoursAgo}h ago)_\n`;
    }
    digest += "\n";
  } else {
    digest += `*✅ CLIENT GROUPS — All messages responded to*\n\n`;
  }

  // ── Internal pending asks ──
  const allPendingAsks = [];
  for (const [groupId, asks] of Object.entries(state.internalPendingAsks)) {
    for (const ask of asks) {
      if (!ask.respondents || ask.respondents.length === 0) {
        const hoursAgo = Math.floor((now - ask.time) / (1000 * 60 * 60));
        if (hoursAgo > 1) { // Only show asks older than 1 hour
          allPendingAsks.push({ ...ask, hoursAgo });
        }
      }
    }
  }

  if (allPendingAsks.length > 0) {
    digest += `*🟡 INTERNAL PENDING ASKS (${allPendingAsks.length})*\n`;
    for (const ask of allPendingAsks.slice(0, 10)) { // Show max 10
      digest += `• *${ask.asker}* asked${ask.tagged ? ` @${ask.tagged}` : ""}: "${ask.ask.substring(0, 60)}..." _(${ask.hoursAgo}h ago, no response)_\n`;
    }
    digest += "\n";
  } else {
    digest += `*✅ INTERNAL — No pending asks*\n\n`;
  }

  digest += `_Reply to this message if you need Claude to draft a response for any issue above._`;

  await sendAlertToMe(digest);

  // Reset digest items for next day
  state.digestItems = { client: [], internal: [] };
}

// ─── SEND MESSAGE TO MY MAIN NUMBER ──────────────────────────────────────
async function sendAlertToMe(message) {
  if (!CONFIG.WA_TOKEN || !CONFIG.PHONE_NUMBER_ID || !CONFIG.MY_MAIN_NUMBER) {
    console.log("⚠️  Alert (not sent - config missing):\n", message);
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: CONFIG.MY_MAIN_NUMBER,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.WA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Alert sent to Mayank");
  } catch (err) {
    console.error("Failed to send alert:", err.response?.data || err.message);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function getSenderName(contacts, senderId) {
  if (!contacts) return senderId;
  const contact = contacts.find((c) => c.wa_id === senderId);
  return contact?.profile?.name || senderId;
}

function isTenonTeam(senderName, senderId) {
  return TENON_TEAM_IDENTIFIERS.some((identifier) =>
    senderName?.toLowerCase().includes(identifier.toLowerCase())
  );
}

// ─── TASKER MESSAGE ENDPOINT ──────────────────────────────────────────────
app.post("/message", async (req, res) => {
  res.sendStatus(200);
  try {
    const { text, sender, app } = req.body;
    if (!text || !sender) return;

    console.log(`📨 Tasker message from ${sender}: ${text.substring(0, 80)}`);

    // Ignore status messages and non-content
    if (text.length < 3) return;

    // Determine if client or internal group based on sender name
    const isInternal = TENON_TEAM_IDENTIFIERS.some(name =>
      sender?.toLowerCase().includes(name.toLowerCase())
    );

    // Analyze with Claude
    const analysis = await analyzeMessage(text, isInternal ? "internal" : "client");

    // Check if you are mentioned
    const taggedMe = text.toLowerCase().includes("mayank");

    // Send immediate alert if critical or tagged
    if (taggedMe) {
      await sendAlertToMe(
        `📌 *YOU WERE MENTIONED*\n\n` +
        `*From:* ${sender}\n` +
        `*Message:* ${text}`
      );
    } else if (!isInternal && analysis.isCritical) {
      await sendAlertToMe(
        `🔴 *CRITICAL CLIENT MESSAGE*\n\n` +
        `*From:* ${sender}\n` +
        `*Message:* ${text}\n\n` +
        `*Why:* ${analysis.reason}`
      );
    } else if (isInternal && analysis.isAsk) {
      // Track internal asks for evening digest
      const groupKey = sender;
      if (!state.internalPendingAsks[groupKey]) state.internalPendingAsks[groupKey] = [];
      state.internalPendingAsks[groupKey].push({
        asker: sender,
        ask: text,
        time: Date.now(),
        respondents: [],
        tagged: analysis.taggedPerson,
      });
    }

    // Track unanswered client messages
    if (!isInternal && !taggedMe) {
      const isTenonSender = isTenonTeam(sender, sender);
      if (!isTenonSender) {
        state.unansweredClientMessages[sender] = {
          messageTime: Date.now(),
          messageText: text,
          senderName: sender,
          analysis,
        };
      } else {
        // Team replied - clear unanswered
        delete state.unansweredClientMessages[sender];
      }
    }

  } catch (err) {
    console.error("Tasker message error:", err.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    unansweredClientMessages: Object.keys(state.unansweredClientMessages).length,
    pendingInternalAsks: Object.values(state.internalPendingAsks).flat().filter(a => !a.respondents?.length).length,
    uptime: Math.floor(process.uptime() / 60) + " minutes",
  });
});

// ─── START ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WA Monitor running on port ${PORT}`);
  console.log(`📱 Will alert: ${CONFIG.MY_MAIN_NUMBER || "NOT SET"}`);
  console.log(`🤖 Claude: ${CONFIG.ANTHROPIC_KEY ? "Connected" : "NOT SET"}`);
});
