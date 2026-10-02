/**
 * Pure logic for the branch-protection check. Kept out of the model file so
 * it can be tested without swamp, with `fetch` injected.
 *
 * @module
 */

export type RepoRef = { owner: string; repo: string };

export type Protection = {
  /** Canonical `owner/name` as GitHub reports it (follows renames). */
  fullName: string;
  defaultBranch: string;
  /** The answer: classic branch protection or any ruleset rule applies. */
  protected: boolean;
  /** GitHub's `protected` flag on the default branch. */
  branchProtected: boolean;
  /** Distinct ruleset rule types that apply to the default branch. */
  rules: string[];
};

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Parse a public GitHub repository link into owner and repo. */
export function parseRepoUrl(url: string): RepoRef {
  const invalid = () =>
    new Error(`not a GitHub repository link: ${JSON.stringify(url)}`);
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["github.com", "www.github.com"].includes(parsed.hostname) ||
    parsed.username || parsed.password
  ) {
    throw invalid();
  }
  const [owner, rawRepo] = parsed.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, "");
  if (
    !owner || !repo || !OWNER.test(owner) || owner.endsWith("-") ||
    !REPO.test(repo) || repo === "." || repo === ".."
  ) {
    throw invalid();
  }
  return { owner, repo };
}

const encodePath = (s: string) =>
  s.split("/").map(encodeURIComponent).join("/");

async function getJson<T>(path: string, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "swamp-branch-protection",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return await res.json() as T;
  await res.body?.cancel();
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? NaN);
    const when = Number.isFinite(reset)
      ? new Date(reset * 1000).toISOString()
      : "a later time";
    throw new Error(`GitHub API rate limit exceeded; resets at ${when}`);
  }
  throw new Error(`GitHub API GET ${path} failed: HTTP ${res.status}`);
}

/**
 * Ask GitHub, unauthenticated, whether the repo's default branch is protected
 * by classic branch protection or by any ruleset.
 */
export async function inspectProtection(
  ref: RepoRef,
  fetchFn: typeof fetch = fetch,
): Promise<Protection> {
  const repoPath = `/repos/${ref.owner}/${ref.repo}`;
  let repo: { full_name: string; default_branch: string };
  try {
    repo = await getJson(repoPath, fetchFn);
  } catch (e) {
    if ((e as Error).message.endsWith("HTTP 404")) {
      throw new Error(
        `repository ${ref.owner}/${ref.repo} not found (it may be private or not exist)`,
      );
    }
    throw e;
  }
  const base = `/repos/${repo.full_name}`;
  const branch = encodePath(repo.default_branch);
  const [info, rules] = await Promise.all([
    getJson<{ protected: boolean }>(`${base}/branches/${branch}`, fetchFn),
    getJson<{ type: string }[]>(`${base}/rules/branches/${branch}`, fetchFn),
  ]);
  const ruleTypes = [...new Set(rules.map((r) => r.type))].sort();
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    protected: info.protected === true || ruleTypes.length > 0,
    branchProtected: info.protected === true,
    rules: ruleTypes,
  };
}
