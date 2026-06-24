const express = require("express");
const https = require("https");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";
const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Morning Digest Worker", nextRun: "6:30 AM CST daily" });
});

// ─── Test trigger (GET) — open this in browser to manually test ───────────────
app.get("/run-digest", (req, res) => {
  const token = req.query.secret || "";
  if (CRON_SECRET && token !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized — add ?secret=YOUR_SECRET to the URL" });
  }
  res.json({ status: "started", message: "Digest running — check your Gmail in ~60 seconds" });
  runDigest().catch((err) => console.error("Digest failed:", err.message));
});

// ─── Cron trigger (POST) — called by cron-job.org ────────────────────────────
app.post("/run-digest", (req, res) => {
  const token = req.headers["x-cron-secret"] || req.headers["authorization"] || req.query.secret || "";
  if (CRON_SECRET && token !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  console.log(`[${new Date().toISOString()}] Digest triggered via POST`);
  res.json({ status: "started", message: "Digest running in background" });
  runDigest().catch((err) => console.error("Digest failed:", err.message));
});

// ─── Anthropic API helper ─────────────────────────────────────────────────────
function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Bad API response: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Core digest logic ────────────────────────────────────────────────────────
async function runDigest() {
  const length = process.env.DIGEST_LENGTH || "standard";
  const tone = process.env.DIGEST_TONE || "neutral";

  const lengthMap = {
    brief: "3-5 bullet points per topic, very concise",
    standard: "2-3 sentences per story, 1-2 minute read total",
    detailed: "full paragraph per story with context and analysis",
  };
  const toneMap = {
    neutral: "neutral and professional",
    casual: "casual and conversational",
    executive: "executive briefing style — very concise, action-oriented",
    analytical: "analytical and data-focused, include numbers and trends",
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Chicago",
  });

  // Step 1: Scan Gmail
  console.log("Step 1: Scanning Gmail...");
  let emailData = { emails: [], user_email: "" };
  try {
    const scanResponse = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      mcp_servers: [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }],
      messages: [{
        role: "user",
        content: `Search Gmail for newsletter and news digest emails received in the last 12 hours. Search for: newsletter, digest, briefing, daily, morning, news, summary. For each email extract: sender name, subject line, and 3-5 key topics. Also find the user's own email address. Return ONLY valid JSON, no markdown:
{"user_email":"string","emails":[{"sender":"string","subject":"string","topics":["string"],"body_preview":"string"}]}`
      }],
    });
    for (const block of scanResponse.content || []) {
      const text = block.type === "mcp_tool_result"
        ? block.content?.[0]?.text
        : block.type === "text" ? block.text : null;
      if (!text) continue;
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { emailData = JSON.parse(match[0]); break; } catch {} }
    }
    console.log(`Found ${emailData.emails?.length || 0} emails, user: ${emailData.user_email}`);
  } catch (err) {
    console.error("Gmail scan error:", err.message);
  }

  // Step 2: Generate summary
  console.log("Step 2: Generating summary...");
  let digestText = "";
  try {
    const emailCount = emailData.emails?.length || 0;
    const prompt = emailCount > 0
      ? `Here are news emails from Gmail for ${today}:\n\n${JSON.stringify(emailData.emails, null, 2)}\n\nCreate a morning digest. Length: ${lengthMap[length]}. Tone: ${toneMap[tone]}. Group by topic with headers like "=== TECHNOLOGY ===". Start with "Good morning!". No markdown asterisks.`
      : `Create a morning news digest for ${today}. No overnight emails found. Cover: Technology, AI, Business, Geopolitics. Length: ${lengthMap[length]}. Tone: ${toneMap[tone]}. Use headers like "=== TECHNOLOGY ===". Start with "Good morning!".`;

    const summaryResponse = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });
    digestText = (summaryResponse.content || [])
      .filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    console.log("Summary generated, length:", digestText.length);
  } catch (err) {
    console.error("Summary error:", err.message);
    digestText = `Good morning!\n\nDigest ran on ${today} but hit an error. Check Render logs.`;
  }

  // Step 3: Send email
  console.log("Step 3: Sending email...");
  const subject = `☀️ Morning Digest — ${today}`;
  const htmlBody = buildEmailHtml(digestText, today);
  try {
    const sendResponse = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      mcp_servers: [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }],
      messages: [{
        role: "user",
        content: `Send an email to ${emailData.user_email || "me"} with subject "${subject}" and this HTML body: ${htmlBody}. Use the Gmail send tool.`,
      }],
    });
    console.log("Send response:", JSON.stringify(sendResponse.content?.map(b => b.type)));
    console.log("✓ Digest sent!");
  } catch (err) {
    console.error("Email send error:", err.message);
  }
}

// ─── Email HTML builder ───────────────────────────────────────────────────────
function buildEmailHtml(text, date) {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const formatted = escaped.replace(
    /={3}\s*([^=]+?)\s*={3}/g,
    '<h2 style="font-size:14px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin:24px 0 10px;">$1</h2>'
  );
  return `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#0f1117;padding:24px 28px;border-radius:8px 8px 0 0;">
    <p style="color:#4f8ef7;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Morning Digest</p>
    <p style="color:#fff;font-size:20px;font-weight:700;margin:0;">☀️ ${date}</p>
    <p style="color:#8b92a8;font-size:12px;margin:4px 0 0;">Dallas, TX · 6:30 AM · Powered by Claude AI</p>
  </div>
  <div style="padding:24px 28px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    <div style="font-size:14px;line-height:1.8;color:#374151;white-space:pre-wrap;">${formatted}</div>
  </div>
  <div style="padding:14px 28px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p style="font-size:11px;color:#9ca3af;margin:0;">Sent at 6:30 AM CST · Morning Digest Routine</p>
  </div>
</div>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Morning Digest Worker running on port ${PORT}`);
  console.log(`  GET  / — health check`);
  console.log(`  GET  /run-digest?secret=XXX — manual browser trigger`);
  console.log(`  POST /run-digest — cron-job.org trigger`);
});
