import type { GitHubIssuesBuiltinConfig } from "../config.js";
import { definePlugin } from "../sdk/index.js";
import type { Plugin } from "../types.js";

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

// parseNextLink extracts the rel="next" URL from a GitHub Link response header.
// GitHub paginates list endpoints and advertises the next page via this header,
// e.g. `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`.
// Returns undefined when there is no further page.
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

async function fetchIssues(
  token: string,
  repo: string,
  labels: string[],
  assignee?: string,
  onRateLimit?: () => void,
): Promise<GitHubIssue[]> {
  const labelParam = encodeURIComponent(labels.join(","));
  let url: string | undefined =
    `https://api.github.com/repos/${repo}/issues?state=open&labels=${labelParam}&per_page=100`;
  if (assignee) {
    url += `&assignee=${encodeURIComponent(assignee)}`;
  }

  const issues: GitHubIssue[] = [];
  while (url) {
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
        onRateLimit?.();
        throw new Error(`GitHub rate limit exceeded (status ${res.status}). Backing off.`);
      }
      throw new Error(`GitHub API authentication error (status ${res.status}).`);
    }

    if (!res.ok) {
      throw new Error(`GitHub API error fetching issues: HTTP ${res.status}`);
    }

    const page = (await res.json()) as GitHubIssue[];
    issues.push(...page);
    url = parseNextLink(res.headers.get("Link"));
  }

  return issues;
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
//   "seen:<issueId>"      → { sessionId?: string; issueNumber: number; createdAt: string; completedAt?: string }
//   "session:<sessionId>" → { issueId: number; issueNumber: number; repo: string }
//
// The "seen:" marker is permanent for the lifetime of an open issue. It is set
// *before* a session is spawned and is NOT removed when that session
// completes — otherwise a still-open issue (PR review pending) would be picked
// up again on the next poll, spawning an endless stream of duplicate sessions.
//
// Writing "seen:" before newSession() closes a crash window: if the process
// dies after the session starts but before the marker is written, the next poll
// would see the issue as unseen and spawn a duplicate. With this ordering a
// crash instead leaves a phantom "seen:" marker (no session) — safe, since at
// worst an issue is skipped rather than worked twice. The marker carries no
// sessionId until the session is created, so it is optional here. A *caught*
// newSession() failure removes the marker so the issue can be retried next poll.

interface SeenEntry {
  sessionId?: string;
  issueNumber: number;
  createdAt: string;
  completedAt?: string;
}

interface SessionEntry {
  issueId: number;
  issueNumber: number;
  repo: string;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const PLUGIN_ID = "conductor.builtin.github-issues";

// Builds the builtin GitHub Issues plugin from validated config. Config is
// passed explicitly by the loader rather than read from process.env, so values
// stay scoped to this instance and never leak into the process environment.
export function createGitHubIssuesPlugin(config: GitHubIssuesBuiltinConfig): Plugin {
  return definePlugin({
    id: PLUGIN_ID,
    name: "GitHub Issues",
    requiredSecrets: [],

    async init({ kv, hive, secrets, scheduler, logger, metrics }) {
      const {
        repo,
        labels,
        pollIntervalMs,
        tokenSecretKey,
        tokenSource,
        assignee,
        inProgressLabel,
        doneLabel,
        maxOpenSessions,
      } = config;

      if (!repo || labels.length === 0) {
        logger.warn("GitHub Issues plugin: missing repo or labels, skipping");
        return;
      }

      const pollsTotal = metrics.counter({
        name: "polls_total",
        help: "Poll attempts by result",
        labelNames: ["result"],
      });
      const pollDuration = metrics.histogram({
        name: "poll_duration_ms",
        help: "Poll duration in milliseconds",
        buckets: [50, 100, 500, 1000, 5000, 10000],
      });
      const issuesSeen = metrics.counter({
        name: "issues_seen_total",
        help: "New issues picked up across polls",
      });
      const sessionsCreated = metrics.counter({
        name: "sessions_created_total",
        help: "Sessions created by result",
        labelNames: ["result"],
      });
      const rateLimited = metrics.counter({
        name: "rate_limited_total",
        help: "GitHub rate-limit responses encountered",
      });
      const labelUpdates = metrics.counter({
        name: "label_updates_total",
        help: "Issue label updates by label and result",
        labelNames: ["label", "result"],
      });
      const openSessions = metrics.gauge({
        name: "open_sessions",
        help: "Currently open sessions owned by this plugin",
      });

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
        const endTimer = pollDuration.startTimer();
        try {
          await pollOnce();
          pollsTotal.inc({ result: "ok" });
        } catch (err) {
          pollsTotal.inc({ result: "error" });
          logger.error("GitHub Issues: poll failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          endTimer();
        }
      }

      async function pollOnce(): Promise<void> {
        const issues = await fetchIssues(token, repo, labels, assignee, () => rateLimited.inc());

        openSessions.set(hive.listSessions().filter((s) => s.pluginId === PLUGIN_ID).length);

        for (const issue of issues) {
          const seenKey = `seen:${issue.id}`;
          if (await kv.has(seenKey)) continue;

          if (maxOpenSessions !== undefined) {
            const openCount = hive.listSessions().filter((s) => s.pluginId === PLUGIN_ID).length;
            if (openCount >= maxOpenSessions) {
              logger.info("GitHub Issues: max open sessions reached, deferring issue", {
                issueNumber: issue.number,
                openCount,
                maxOpenSessions,
              });
              break;
            }
          }

          issuesSeen.inc();
          logger.info("GitHub Issues: new issue found, creating session", {
            issueNumber: issue.number,
            title: issue.title,
          });

          // Mark the issue seen BEFORE spawning the session. A crash between this
          // write and newSession() leaves a phantom marker (no session) — the
          // issue is skipped, never worked twice.
          await kv.set<SeenEntry>(seenKey, {
            issueNumber: issue.number,
            createdAt: new Date().toISOString(),
          });

          let sessionId: string;
          try {
            const session = await hive.newSession({
              name: issueSlug(issue.number, issue.title),
              remote: `https://github.com/${repo}`,
              context: `Issue #${issue.number}: ${issue.title}\n${issue.html_url}`,
            });
            sessionId = session.id;
            sessionsCreated.inc({ result: "ok" });
          } catch (err) {
            sessionsCreated.inc({ result: "error" });
            // Remove the marker so a transient failure can be retried next poll.
            await kv.delete(seenKey);
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
            repo,
          });

          if (inProgressLabel) {
            try {
              await addLabel(token, repo, issue.number, inProgressLabel);
              labelUpdates.inc({ label: inProgressLabel, result: "ok" });
            } catch (err) {
              labelUpdates.inc({ label: inProgressLabel, result: "error" });
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
            labelUpdates.inc({ label: doneLabel, result: "ok" });
          } catch (err) {
            labelUpdates.inc({ label: doneLabel, result: "error" });
            logger.warn("GitHub Issues: failed to add done label", {
              issueNumber: entry.issueNumber,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Keep the "seen:" marker so the still-open issue is not re-spawned on the
        // next poll. Stamp it as completed for observability. Drop the
        // session-scoped entry since that session no longer exists.
        const seen = await kv.get<SeenEntry>(`seen:${entry.issueId}`);
        if (seen) {
          await kv.set<SeenEntry>(`seen:${entry.issueId}`, {
            ...seen,
            completedAt: new Date().toISOString(),
          });
        }
        await kv.delete(`session:${session.id}`);
      });
    },
  });
}
