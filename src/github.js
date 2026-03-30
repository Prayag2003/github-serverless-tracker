const { getGithubUsername } = require("./config");

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-tracker",
};

async function fetchPublicEvents() {
  const GITHUB_USERNAME = getGithubUsername();
  const url = `https://api.github.com/users/${GITHUB_USERNAME}/events/public?per_page=30`;
  const res = await fetch(url, { headers: GITHUB_HEADERS });

  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText}`);
    return [];
  }

  return res.json();
}

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

module.exports = { fetchPublicEvents, enrichPushEvents };
