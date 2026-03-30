require("dotenv").config();
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const {
  GITHUB_USERNAME,
  RESEND_API_KEY,
  NOTIFY_EMAIL,
  POLL_INTERVAL_MS = "120000",
} = process.env;

if (!GITHUB_USERNAME || !RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error(
    "Missing required env vars. Copy .env.example to .env and fill it in."
  );
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);
const STATE_FILE = path.join(__dirname, "last_event_id.txt");

// ── State ───────────────────────────────────────────────────────────────────
function loadLastEventId() {
  try {
    return fs.readFileSync(STATE_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function saveLastEventId(id) {
  fs.writeFileSync(STATE_FILE, id, "utf-8");
}

// ── GitHub API ──────────────────────────────────────────────────────────────
async function fetchPublicEvents() {
  const url = `https://api.github.com/users/${GITHUB_USERNAME}/events/public?per_page=30`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-tracker",
    },
  });

  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText}`);
    return [];
  }

  return res.json();
}

// ── Email ───────────────────────────────────────────────────────────────────
function buildEmailHtml(events) {
  const totalCommits = events.reduce((sum, ev) => {
    if (ev.type === "PushEvent") return sum + (ev.payload.commits?.length || 0);
    return sum;
  }, 0);

  const sections = events.map((ev) => {
    const repo = ev.repo.name;
    const repoUrl = `https://github.com/${repo}`;
    const timestamp = new Date(ev.created_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    if (ev.type === "PushEvent") {
      const branch = ev.payload.ref.replace("refs/heads/", "");
      const commits = ev.payload.commits || [];
      const compareUrl = ev.payload.size > 0
        ? `${repoUrl}/compare/${ev.payload.before?.substring(0, 12)}...${ev.payload.head?.substring(0, 12)}`
        : repoUrl;

      const commitRows = commits.map((c) => {
        const shortSha = c.sha.substring(0, 7);
        const commitUrl = `${repoUrl}/commit/${c.sha}`;
        const msgLines = escapeHtml(c.message).split("\\n");
        const title = msgLines[0];
        const body = msgLines.length > 1 ? msgLines.slice(1).join("<br>") : "";

        return `
          <tr>
            <td style="padding:12px 16px;border-bottom:1px solid #f0f0f5;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="vertical-align:top;padding-right:12px;width:28px;">
                    <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;">
                      <img src="https://github.com/${c.author?.name || GITHUB_USERNAME}.png?size=28" 
                           width="28" height="28" 
                           style="border-radius:50%;display:block;" 
                           alt="" />
                    </div>
                  </td>
                  <td style="vertical-align:top;">
                    <a href="${commitUrl}" style="color:#1a1a2e;font-weight:600;font-size:14px;text-decoration:none;line-height:1.4;">
                      ${title}
                    </a>
                    ${body ? `<p style="margin:4px 0 0;color:#8888a0;font-size:12px;line-height:1.4;">${body}</p>` : ""}
                    <p style="margin:6px 0 0;">
                      <a href="${commitUrl}" style="text-decoration:none;">
                        <code style="background:#f0f0ff;color:#6366f1;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;letter-spacing:0.5px;">${shortSha}</code>
                      </a>
                      <span style="color:#b0b0c0;font-size:11px;margin-left:8px;">
                        ${c.sha}
                      </span>
                    </p>
                    <p style="margin:4px 0 0;color:#b0b0c0;font-size:11px;">
                      by <strong style="color:#6b6b80;">${escapeHtml(c.author?.name || "unknown")}</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
      }).join("\n");

      return `
        <!-- Push Event Card -->
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06),0 4px 12px rgba(0,0,0,0.04);">
          <!-- Card Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#f8f8ff,#f0f0ff);padding:16px 20px;border-bottom:1px solid #e8e8f0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size:18px;vertical-align:middle;">🚀</span>
                    <a href="${repoUrl}" style="color:#1a1a2e;font-weight:700;font-size:16px;text-decoration:none;vertical-align:middle;margin-left:4px;">${repo}</a>
                  </td>
                  <td style="text-align:right;">
                    <span style="background:#e0e7ff;color:#4f46e5;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:0.3px;">
                      🌿 ${escapeHtml(branch)}
                    </span>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 0;color:#8888a0;font-size:12px;">
                ${commits.length} commit${commits.length !== 1 ? "s" : ""} pushed · ${timestamp}
              </p>
            </td>
          </tr>
          <!-- Commits -->
          ${commitRows}
          <!-- Card Footer -->
          <tr>
            <td style="padding:12px 20px;background:#fafaff;text-align:center;">
              <a href="${compareUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;letter-spacing:0.3px;">
                View Full Diff →
              </a>
            </td>
          </tr>
        </table>`;
    }

    // ── Other event types ─────────────────────────────────────────────────
    const typeLabel = ev.type.replace("Event", "");
    const icons = {
      Create: "✨", Delete: "🗑️", Watch: "⭐", Fork: "🍴",
      Issues: "🐛", IssueComment: "💬", PullRequest: "🔀",
      PullRequestReview: "👀", Release: "📦", Public: "🌍",
    };
    const icon = icons[typeLabel] || "📌";
    const action = ev.payload.action ? ` · ${ev.payload.action}` : "";

    return `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06),0 4px 12px rgba(0,0,0,0.04);">
        <tr>
          <td style="background:linear-gradient(135deg,#f8f8ff,#f0f0ff);padding:16px 20px;">
            <span style="font-size:18px;vertical-align:middle;">${icon}</span>
            <strong style="color:#1a1a2e;font-size:15px;vertical-align:middle;margin-left:4px;">${typeLabel}</strong>
            <span style="color:#8888a0;font-size:13px;vertical-align:middle;">${action}</span>
            <br/>
            <a href="${repoUrl}" style="color:#6366f1;font-size:14px;text-decoration:none;font-weight:600;">${repo}</a>
            <span style="color:#b0b0c0;font-size:12px;margin-left:8px;">${timestamp}</span>
          </td>
        </tr>
      </table>`;
  });

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f8;padding:24px 0;">
        <tr>
          <td align="center">
            <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:32px 28px;border-radius:16px 16px 0 0;text-align:center;">
                  <p style="margin:0;font-size:28px;">🔔</p>
                  <h1 style="margin:8px 0 4px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">
                    GitHub Activity Alert
                  </h1>
                  <p style="margin:0;color:#a0a0c0;font-size:14px;">
                    New activity from <strong style="color:#818cf8;">@${GITHUB_USERNAME}</strong>
                  </p>
                  <table cellpadding="0" cellspacing="0" border="0" style="margin:16px auto 0;">
                    <tr>
                      <td style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 16px;text-align:center;">
                        <span style="color:#c7d2fe;font-size:12px;">Events</span><br/>
                        <strong style="color:#ffffff;font-size:18px;">${events.length}</strong>
                      </td>
                      <td width="12"></td>
                      <td style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 16px;text-align:center;">
                        <span style="color:#c7d2fe;font-size:12px;">Commits</span><br/>
                        <strong style="color:#ffffff;font-size:18px;">${totalCommits}</strong>
                      </td>
                      <td width="12"></td>
                      <td style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 16px;text-align:center;">
                        <span style="color:#c7d2fe;font-size:12px;">Repos</span><br/>
                        <strong style="color:#ffffff;font-size:18px;">${new Set(events.map((e) => e.repo.name)).size}</strong>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="background:#ffffff;padding:24px 20px;border-radius:0 0 16px 16px;">
                  ${sections.join("\n")}
                  <!-- Footer -->
                  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:12px;border-top:1px solid #f0f0f5;padding-top:16px;">
                    <tr>
                      <td style="text-align:center;">
                        <p style="margin:0;color:#b0b0c0;font-size:11px;">
                          Sent by <strong>GitHub Tracker</strong> · ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                        </p>
                        <p style="margin:4px 0 0;">
                          <a href="https://github.com/${GITHUB_USERNAME}" style="color:#6366f1;text-decoration:none;font-size:11px;font-weight:600;">
                            View @${GITHUB_USERNAME} on GitHub →
                          </a>
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendNotification(events) {
  const html = buildEmailHtml(events);
  const eventTypes = [...new Set(events.map((e) => e.type.replace("Event", "")))];

  try {
    const { data, error } = await resend.emails.send({
      from: "GitHub Tracker <onboarding@resend.dev>",
      to: [NOTIFY_EMAIL],
      subject: `[GitHub] ${events.length} new event(s) from ${GITHUB_USERNAME} — ${eventTypes.join(", ")}`,
      html,
    });

    if (error) {
      console.error("Resend error:", error);
      return;
    }

    console.log(`  ✉️  Email sent (id: ${data.id})`);
  } catch (err) {
    console.error("Failed to send email:", err.message);
  }
}

// ── Poll Loop ───────────────────────────────────────────────────────────────
async function poll() {
  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] Polling events for ${GITHUB_USERNAME}...`);

  const events = await fetchPublicEvents();
  if (!events.length) {
    console.log("  No events found.");
    return;
  }

  const lastEventId = loadLastEventId();
  let newEvents;

  if (!lastEventId) {
    // First run — don't flood inbox, just save the latest ID
    console.log(`  First run. Saving latest event ID: ${events[0].id}`);
    saveLastEventId(events[0].id);
    return;
  }

  // Collect all events newer than the last one we saw
  newEvents = [];
  for (const ev of events) {
    if (ev.id === lastEventId) break;
    newEvents.push(ev);
  }

  if (!newEvents.length) {
    console.log("  No new events.");
    return;
  }

  console.log(`  Found ${newEvents.length} new event(s).`);
  saveLastEventId(newEvents[0].id);
  await sendNotification(newEvents);
}

// ── Start ───────────────────────────────────────────────────────────────────
console.log(`
┌──────────────────────────────────────────┐
│         GitHub Activity Tracker          │
├──────────────────────────────────────────┤
│  Watching:  ${GITHUB_USERNAME.padEnd(28)}│
│  Notify:    ${NOTIFY_EMAIL.padEnd(28)}│
│  Interval:  ${(Number(POLL_INTERVAL_MS) / 1000 + "s").padEnd(28)}│
└──────────────────────────────────────────┘
`);

// Run immediately, then on interval
poll();
setInterval(poll, Number(POLL_INTERVAL_MS));
