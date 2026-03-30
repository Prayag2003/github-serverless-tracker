require("dotenv").config();
const { Resend } = require("resend");
const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");

// ── Config ──────────────────────────────────────────────────────────────────
let GITHUB_USERNAME = process.env.GITHUB_USERNAME;
let NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || "30", 10);
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * 60 * 1000;

let resend;
const ssmClient = new SSMClient();

async function initSecrets() {
  if (resend) return;

  const isMissing = !process.env.RESEND_API_KEY || !GITHUB_USERNAME || !NOTIFY_EMAIL;

  if (isMissing) {
    console.log("Fetching config from SSM...");
    try {
      const command = new GetParametersCommand({
        Names: [
          "/github-tracker/prod/resend-api-key",
          "/github-tracker/prod/github-username",
          "/github-tracker/prod/notify-email"
        ],
        WithDecryption: true
      });
      const response = await ssmClient.send(command);
      
      for (const param of response.Parameters) {
        if (param.Name.includes("resend-api-key")) process.env.RESEND_API_KEY = param.Value;
        if (param.Name.includes("github-username")) GITHUB_USERNAME = param.Value;
        if (param.Name.includes("notify-email")) NOTIFY_EMAIL = param.Value;
      }
    } catch (err) {
      console.error("Failed to fetch from SSM:", err);
      throw err;
    }
  }

  resend = new Resend(process.env.RESEND_API_KEY);
}

// ── GitHub API ──────────────────────────────────────────────────────────────
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-tracker",
};

async function fetchPublicEvents() {
  const url = `https://api.github.com/users/${GITHUB_USERNAME}/events/public?per_page=30`;
  const res = await fetch(url, { headers: GITHUB_HEADERS });

  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText}`);
    return [];
  }

  return res.json();
}

// Fetch commit details via Compare API when events don't include them
async function fetchCommitsForPush(repoName, beforeSha, headSha) {
  const url = `https://api.github.com/repos/${repoName}/compare/${beforeSha}...${headSha}`;
  try {
    const res = await fetch(url, { headers: GITHUB_HEADERS });
    if (!res.ok) {
      console.error(`  Compare API error for ${repoName}: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.commits || []).map((c) => ({
      sha: c.sha,
      message: c.commit?.message || "(no message)",
      author: {
        name: c.commit?.author?.name || c.author?.login || "unknown",
        email: c.commit?.author?.email || "",
      },
      url: c.html_url,
    }));
  } catch (err) {
    console.error(`  Failed to fetch commits for ${repoName}:`, err.message);
    return [];
  }
}

// Enrich PushEvents that are missing commit data
async function enrichPushEvents(events) {
  for (const ev of events) {
    if (ev.type !== "PushEvent") continue;
    if (ev.payload.commits && ev.payload.commits.length > 0) continue;

    const { before, head } = ev.payload;
    if (!before || !head) continue;

    console.log(`  Fetching commits for ${ev.repo.name} (${before.substring(0, 7)}...${head.substring(0, 7)})`);
    const commits = await fetchCommitsForPush(ev.repo.name, before, head);
    ev.payload.commits = commits;
    ev.payload.size = commits.length;
    ev.payload.distinct_size = commits.length;
  }
  return events;
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

// ── AWS Lambda Handler ──────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  await initSecrets();

  if (!GITHUB_USERNAME || !NOTIFY_EMAIL || !resend) {
    console.error("Missing required config");
    return { statusCode: 500, body: "Server misconfiguration" };
  }

  console.log(`Lambda triggered. Checking events for ${GITHUB_USERNAME}...`);

  const events = await fetchPublicEvents();
  if (!events.length) {
    console.log("  No events found on GitHub.");
    return { statusCode: 200, body: "No events found" };
  }

  // Lambda is stateless. We filter events created within the last POLL_INTERVAL_MS.
  // This ensures we only email about events that happened since the last scheduled run.
  const timeWindowMs = Number(POLL_INTERVAL_MS);
  const cutoffTime = Date.now() - timeWindowMs;

  const newEvents = events.filter(ev => {
    const eventTime = new Date(ev.created_at).getTime();
    return eventTime >= cutoffTime;
  });

  if (!newEvents.length) {
    console.log("  No new events in the last time window.");
    return { statusCode: 200, body: "No new events" };
  }

  console.log(`  Found ${newEvents.length} new event(s).`);
  await enrichPushEvents(newEvents);
  await sendNotification(newEvents);

  return { statusCode: 200, body: `Processed ${newEvents.length} events` };
};
