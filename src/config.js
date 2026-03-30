require("dotenv").config();
const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");
const { Resend } = require("resend");

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

module.exports = {
  initSecrets,
  getResend: () => resend,
  getGithubUsername: () => GITHUB_USERNAME,
  getNotifyEmail: () => NOTIFY_EMAIL,
  POLL_INTERVAL_MS
};
