import Anthropic from "@anthropic-ai/sdk";
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // A secret token you set to protect the endpoint
const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const token =
    req.headers["x-cron-secret"] || req.query.secret;
  if (!CRON_SECRET || token !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Morning Digest Worker",
    nextRun: "6:30 AM CST daily",
  });
});

// ─── Main digest endpoint ──────────────────────────────────────────────────────
app.post("/run-digest", requireSecret, async (req, res) => {
  console.log(`[${new Date().toISOString()}] Digest triggered`);

  // Respond immediately so cron-job.org doesn't time out (it has a 30s limit)
  res.json({ status: "started", message: "Digest running in background" });

  // Run the actual digest work asynchronously
  runDigest().catch((err) => {
    console.error("Digest failed:", err.message);
  });
});

// ─── Core digest logic ─────────────────────────────────────────────────────────
async function runDigest() {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });

  console.log("Step 1: Scanning Gmail for overnight news emails...");

  // Step 1: Scan Gmail via MCP
  let emailData = { emails: [], user_email: "" };
  try {
    const scanResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      mcp_servers: [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }],
      messages: [
        {
          role: "user",
          content: `Search Gmail for newsletter and news digest emails received in the last 12 hours (overnight, between 8pm and 6am). 
Search for: newsletter, digest, briefing, daily, morning, news, summary.
For each email found, extract: sender name, subject line, and 3-5 key topics/headlines from the body.
Also find the user's own email address.
Return ONLY valid JSON in this exact shape, no markdown, no explanation:
{
  "user_email": "string",
  "emails": [
    { "sender": "string", "subject": "string", "topics": ["string"], "body_preview": "string" }
  ]
}`,
        },
      ],
    });

    // Extract from MCP tool results or text blocks
    for (const block of scanResponse.content || []) {
      const text =
        block.type === "mcp_tool_result"
          ? block.content?.[0]?.text
          : block.type === "text"
          ? block.text
          : null;
      if (!text) continue;
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          emailData = JSON.parse(match[0]);
          break;
        } catch {}
      }
    }
  } catch (err) {
    console.error("Gmail scan error:", err.message);
  }

  const emailCount = emailData.emails?.length || 0;
  console.log(`Found ${emailCount} news emails`);

  // Step 2: Generate summary with Claude
  console.log("Step 2: Generating digest summary...");
  let digestText = "";
  try {
    const summaryPrompt =
      emailCount > 0
        ? `Here are the news emails from the user's Gmail for ${today}:

${JSON.stringify(emailData.emails, null, 2)}

Create a morning news digest email body.
- Length: ${lengthMap[length]}
- Tone: ${toneMap[tone]}
- Group stories by topic (Technology, Business, Finance, AI/ML, Geopolitics, etc.)
- Start with "Good morning! Here's your digest for ${today}."
- Use plain section headers like "=== TECHNOLOGY ===" 
- End with a one-line sign-off
- Do NOT use markdown asterisks`
        : `Create a morning news digest for ${today} with realistic current news content covering:
Technology, AI & ML, Business & Finance, Geopolitics.
Note at the top that this is a scheduled digest (no overnight emails were found today).
- Length: ${lengthMap[length]}
- Tone: ${toneMap[tone]}
- Use plain section headers like "=== TECHNOLOGY ==="
- Start with "Good morning!"`;

    const summaryResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: summaryPrompt }],
    });

    digestText = summaryResponse.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    console.error("Summary generation error:", err.message);
    digestText = `Good morning!\n\nYour Morning Digest ran at 6:30 AM but encountered an issue generating today's summary. Please check the logs.\n\nDate: ${today}`;
  }

  // Step 3: Send via Gmail MCP
  console.log("Step 3: Sending digest email...");
  const subject = `☀️ Morning Digest — ${today}`;
  const htmlBody = buildEmailHtml(digestText, today);

  try {
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      mcp_servers: [{ type: "url", url: GMAIL_MCP_URL, name: "gmail-mcp" }],
      messages: [
        {
          role: "user",
          content: `Send an email to ${emailData.user_email || "me"} (my own Gmail address) with:
Subject: ${subject}
HTML body: ${htmlBody}
Use the Gmail send tool now.`,
        },
      ],
    });
    console.log(`✓ Digest sent to ${emailData.user_email || "Gmail"}`);
  } catch (err) {
    console.error("Email send error:", err.message);
  }
}

// ─── Email HTML template ───────────────────────────────────────────────────────
function buildEmailHtml(text, date) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Style section headers
  const formatted = escaped.replace(
    /={3}\s*([^=]+?)\s*={3}/g,
    '<h2 style="font-size:14px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid #e5e7eb;padding-bottom:6px;margin:24px 0 10px;">$1</h2>'
  );

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
  <div style="background:#0f1117;padding:24px 28px;border-radius:8px 8px 0 0;">
    <p style="color:#4f8ef7;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Morning Digest</p>
    <p style="color:#ffffff;font-size:20px;font-weight:700;margin:0;">☀️ ${date}</p>
    <p style="color:#8b92a8;font-size:12px;margin:4px 0 0;">Dallas, TX · 6:30 AM · Powered by Claude AI</p>
  </div>
  <div style="padding:24px 28px;background:#ffffff;border:1px solid #e5e7eb;border-top:none;">
    <div style="font-size:14px;line-height:1.8;color:#374151;white-space:pre-wrap;">${formatted}</div>
  </div>
  <div style="padding:14px 28px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p style="font-size:11px;color:#9ca3af;margin:0;">Sent automatically at 6:30 AM CST · Morning Digest Routine · <a href="#" style="color:#9ca3af;">Manage preferences</a></p>
  </div>
</div>`;
}

// ─── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Morning Digest Worker running on port ${PORT}`);
  console.log(`POST /run-digest with header x-cron-secret: <your-secret>`);
});
