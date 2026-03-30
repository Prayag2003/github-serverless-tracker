const {
  initSecrets,
  getGithubUsername,
  getNotifyEmail,
  getResend,
  POLL_INTERVAL_MS
} = require("./config");
const { fetchPublicEvents, enrichPushEvents } = require("./github");
const { sendNotification } = require("./email");

exports.handler = async (event, context) => {
  await initSecrets();

  const GITHUB_USERNAME = getGithubUsername();
  const NOTIFY_EMAIL = getNotifyEmail();

  if (!GITHUB_USERNAME || !NOTIFY_EMAIL || !getResend()) {
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
