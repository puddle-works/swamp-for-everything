/**
 * Pure branch-protection logic. No swamp APIs, no global state: everything the
 * network needs is injected, so it is exhaustively testable with a fake fetch.
 *
 * @module
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ProtectionResult {
  repo: string;
  branch: string;
  protected: boolean;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const API = "https://api.github.com";

/**
 * Parse `https://github.com/<owner>/<repo>[.git][/...]`.
 *
 * Accepts an optional trailing `.git`, trailing slashes, and extra path
 * segments (e.g. `/tree/main`). Rejects anything that is not a github.com
 * owner/repo URL — the caller turns that throw into a failed step.
 */
export function parseRepoUrl(input: string): RepoRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`not a valid URL: ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`not an http(s) URL: ${input}`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com") {
    throw new Error(`not a github.com URL: ${input}`);
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new Error(`URL is missing an owner/repo path: ${input}`);
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!owner || !repo) {
    throw new Error(`URL is missing an owner/repo path: ${input}`);
  }
  return { owner, repo };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "swamp-branch-protection",
  };
}

async function getJson(
  fetch: FetchLike,
  path: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    headers: headers(token),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

function messageOf(body: unknown): string {
  if (body && typeof body === "object" && "message" in body) {
    return String((body as { message: unknown }).message);
  }
  return "request failed";
}

/**
 * Decide whether a repository's default branch is protected, covering both
 * classic branch protection and repository rulesets.
 *
 *   1. GET /repos/{o}/{r}                    -> default_branch
 *   2. GET /repos/{o}/{r}/branches/{branch}  -> .protected
 *   3. GET /repos/{o}/{r}/rules/branches/{b} -> >=1 rule
 *
 * Steps 2 and 3 are read-only and need no admin access. A missing branch or
 * rules endpoint counts as "no protection" from that source rather than an
 * error; only the initial repo lookup failing aborts the check.
 */
export async function checkProtection(
  fetch: FetchLike,
  token: string,
  ref: RepoRef,
): Promise<ProtectionResult> {
  const slug = `${ref.owner}/${ref.repo}`;

  const repoRes = await getJson(fetch, `/repos/${slug}`, token);
  if (!repoRes.ok) {
    throw new Error(
      `repos/${slug}: ${repoRes.status} ${messageOf(repoRes.body)}`,
    );
  }
  const branch = (repoRes.body as { default_branch?: unknown })?.default_branch;
  if (typeof branch !== "string" || !branch) {
    throw new Error(`repos/${slug}: response had no default_branch`);
  }

  let protectedBranch = false;
  const branchRes = await getJson(
    fetch,
    `/repos/${slug}/branches/${branch}`,
    token,
  );
  if (branchRes.ok) {
    protectedBranch =
      (branchRes.body as { protected?: unknown })?.protected === true;
  }

  let protectedByRuleset = false;
  if (!protectedBranch) {
    const rulesRes = await getJson(
      fetch,
      `/repos/${slug}/rules/branches/${branch}`,
      token,
    );
    if (rulesRes.ok && Array.isArray(rulesRes.body)) {
      protectedByRuleset = rulesRes.body.length >= 1;
    }
  }

  return {
    repo: slug,
    branch,
    protected: protectedBranch || protectedByRuleset,
  };
}
