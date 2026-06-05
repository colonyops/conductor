import { definePlugin } from "../sdk/index.js";

// ── GitHub API types ──────────────────────────────────────────────────────────

interface GitHubLabel {
  name: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  labels: GitHubLabel[];
  state: "open" | "closed";
  repository_url: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function issueSlug(number: number, title: string, maxLen = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = `gh-${number}-`;
  return (prefix + slug).slice(0, maxLen).replace(/-$/, "");
}

// ── GitHub REST helpers ───────────────────────────────────────────────────────

async function fetchIssues(token: string, repo: string, labels: string[], assignee?: string): Promise<GitHubIssue[]> {
  const labelParam = encodeURIComponent(labels.join(","));
  let url = `https://api.github.com/repos/${repo}/issues?state=open&labels=${labelParam}&per_page=100`;
  if (assignee) {
    url += `&assignee=${encodeURIComponent(assignee)}`;
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 401 || res.status === 403) {
    const rateLimitRemaining = res.headers.get("X-RateLimit-Remaining");
    if (rateLimitRemaining === "0") {
      throw new Error(`GitHub rate limit exceeded (status ${res.status}). Backing off.`);
    }
    throw new Error(`GitHub API authentication error (status ${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(`GitHub API error fetching issues: HTTP ${res.status}`);
  }

  return res.json() as Promise<GitHubIssue[]>;
}

async function addLabel(token: string, repo: string, issueNumber: number, label: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) {
    throw new Error(`Failed to add label "${label}" to issue #${issueNumber}: HTTP ${res.status}`);
  }
}

// ── KV schema ─────────────────────────────────────────────────────────────────
//   "seen:<issueId>"      → { sessionId: string; issueNumber: number; createdAt: string }
//   "session:<sessionId>" → { issueId: number; issueNumber: number; repo: string }

interface SeenEntry {
  sessionId: string;
  issueNumber: number;
  createdAt: string;
}

interface SessionEntry {
  issueId: number;
  issueNumber: number;
  repo: string;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default definePlugin({
  id: "conductor.builtin.github-issues",
  name: "GitHub Issues",
  requiredSecrets: [],

  async init({ kv, hive, secrets, scheduler, logger }) {
    // Config is provided via conductor.config.json builtins["github-issues"].
    // We access it through the hive client's session manager config indirectly,
    // but since PluginContext doesn't expose raw config, we read it from
    // process.env or rely on the plugin being skipped if config is absent.
    //
    // For v1, the plugin reads its config from env or conductor.config.json
    // via the secrets client for the token, and relies on the conductor
    // startup to validate and pass config as env vars.
    //
    // Actual config fields are read from env vars set by conductor startup
    // (set in conductor start action) or from the conductor.config.json
    // builtins section. Since PluginContext doesn't expose raw config,
    // the builtin plugin reads from process.env for its configuration.

    const repo = process.env.CONDUCTOR_GITHUB_REPO;
    const labelsStr = process.env.CONDUCTOR_GITHUB_LABELS;
    const pollIntervalMs = Number(process.env.CONDUCTOR_GITHUB_POLL_INTERVAL_MS ?? "300000");
    const tokenSecretKey = process.env.CONDUCTOR_GITHUB_TOKEN_SECRET_KEY ?? "github.token";
    const tokenSource = process.env.CONDUCTOR_GITHUB_TOKEN_SOURCE ?? "secret";
    const assignee = process.env.CONDUCTOR_GITHUB_ASSIGNEE || undefined;
    const inProgressLabel = process.env.CONDUCTOR_GITHUB_IN_PROGRESS_LABEL;
    const doneLabel = process.env.CONDUCTOR_GITHUB_DONE_LABEL;

    if (!repo || !labelsStr) {
      logger.warn("GitHub Issues plugin: missing CONDUCTOR_GITHUB_REPO or CONDUCTOR_GITHUB_LABELS, skipping");
      return;
    }

    const labels = labelsStr
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    if (labels.length === 0) {
      logger.warn("GitHub Issues plugin: no labels configured, skipping");
      return;
    }

    let token: string;
    try {
      token = await secrets.get(tokenSecretKey, {
        env: "GITHUB_TOKEN",
        ghCLI: tokenSource === "gh-cli",
      });
    } catch (err) {
      logger.error("GitHub Issues plugin: failed to resolve token", {
        secretKey: tokenSecretKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    logger.info("GitHub Issues plugin initialized", {
      repo,
      labels,
      assignee,
      pollIntervalMs,
    });

    async function poll(): Promise<void> {
      let issues: GitHubIssue[];
      try {
        issues = await fetchIssues(token, repo as string, labels, assignee);
      } catch (err) {
        logger.error("GitHub Issues: poll failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      for (const issue of issues) {
        const seenKey = `seen:${issue.id}`;
        if (await kv.has(seenKey)) continue;

        logger.info("GitHub Issues: new issue found, creating session", {
          issueNumber: issue.number,
          title: issue.title,
        });

        let sessionId: string;
        try {
          const session = await hive.newSession({
            name: issueSlug(issue.number, issue.title),
            remote: `https://github.com/${repo}`,
            context: `Issue #${issue.number}: ${issue.title}\n${issue.html_url}`,
          });
          sessionId = session.id;
        } catch (err) {
          logger.error("GitHub Issues: failed to create session", {
            issueNumber: issue.number,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        await kv.set<SeenEntry>(seenKey, {
          sessionId,
          issueNumber: issue.number,
          createdAt: new Date().toISOString(),
        });
        await kv.set<SessionEntry>(`session:${sessionId}`, {
          issueId: issue.id,
          issueNumber: issue.number,
          repo: repo as string,
        });

        if (inProgressLabel) {
          try {
            await addLabel(token, repo as string, issue.number, inProgressLabel);
          } catch (err) {
            logger.warn("GitHub Issues: failed to add in-progress label", {
              issueNumber: issue.number,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    scheduler.interval(pollIntervalMs, poll);

    hive.onSessionComplete(async ({ session }) => {
      const entry = await kv.get<SessionEntry>(`session:${session.id}`);
      if (!entry) return;

      logger.info("GitHub Issues: session complete, PR review pending", {
        issueNumber: entry.issueNumber,
        sessionId: session.id,
      });

      if (doneLabel) {
        try {
          await addLabel(token, entry.repo, entry.issueNumber, doneLabel);
        } catch (err) {
          logger.warn("GitHub Issues: failed to add done label", {
            issueNumber: entry.issueNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await kv.delete(`seen:${entry.issueId}`);
      await kv.delete(`session:${session.id}`);
    });
  },
});
