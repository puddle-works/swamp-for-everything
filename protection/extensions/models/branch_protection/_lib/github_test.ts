import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { inspectProtection, parseRepoUrl } from "./github.ts";

Deno.test("parseRepoUrl accepts the usual shapes of a GitHub repo link", () => {
  const cases: [string, string, string][] = [
    ["https://github.com/denoland/deno", "denoland", "deno"],
    ["https://github.com/denoland/deno/", "denoland", "deno"],
    ["https://github.com/denoland/deno.git", "denoland", "deno"],
    ["http://www.github.com/denoland/deno", "denoland", "deno"],
    ["  https://github.com/denoland/deno  ", "denoland", "deno"],
    ["https://github.com/denoland/deno/tree/main/cli", "denoland", "deno"],
    ["https://github.com/denoland/deno?tab=readme", "denoland", "deno"],
    ["https://github.com/octo-org/my.repo_name", "octo-org", "my.repo_name"],
  ];
  for (const [url, owner, repo] of cases) {
    assertEquals(parseRepoUrl(url), { owner, repo }, url);
  }
});

Deno.test("parseRepoUrl rejects anything that is not a GitHub repo link", () => {
  for (
    const url of [
      "",
      "denoland/deno",
      "ftp://github.com/denoland/deno",
      "https://gitlab.com/denoland/deno",
      "https://github.com.evil.example/denoland/deno",
      "https://github.com/denoland",
      "https://github.com/",
      "https://github.com/-bad-/deno",
      "https://github.com/denoland/..",
      "https://user:pw@github.com/denoland/deno",
    ]
  ) {
    assertThrows(() => parseRepoUrl(url), Error, "GitHub repository", url);
  }
});

type Route = { status?: number; body?: unknown; headers?: HeadersInit };

/** A fetch that serves canned GitHub API responses and records each URL. */
function fakeGitHub(routes: Record<string, Route>) {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    headers.push(new Headers(init?.headers));
    const path = url.replace("https://api.github.com", "");
    const route = routes[path];
    if (!route) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: route.headers,
      }),
    );
  };
  return { fetchFn: fetchFn as typeof fetch, urls, headers };
}

const REPO = {
  "/repos/denoland/deno": {
    body: { full_name: "denoland/deno", default_branch: "main" },
  },
};

Deno.test("protected when GitHub reports the default branch as protected", async () => {
  const gh = fakeGitHub({
    ...REPO,
    "/repos/denoland/deno/branches/main": { body: { protected: true } },
    "/repos/denoland/deno/rules/branches/main": { body: [] },
  });
  const result = await inspectProtection(
    { owner: "denoland", repo: "deno" },
    gh.fetchFn,
  );
  assertEquals(result, {
    fullName: "denoland/deno",
    defaultBranch: "main",
    protected: true,
    branchProtected: true,
    rules: [],
  });
  assertEquals(gh.urls.length, 3);
  assertEquals(gh.headers[0].get("accept"), "application/vnd.github+json");
  assertEquals(gh.headers[0].has("authorization"), false);
});

Deno.test("protected when only ruleset rules apply to the default branch", async () => {
  const gh = fakeGitHub({
    ...REPO,
    "/repos/denoland/deno/branches/main": { body: { protected: false } },
    "/repos/denoland/deno/rules/branches/main": {
      body: [
        { type: "pull_request" },
        { type: "deletion" },
        { type: "pull_request" },
      ],
    },
  });
  const result = await inspectProtection(
    { owner: "denoland", repo: "deno" },
    gh.fetchFn,
  );
  assertEquals(result.protected, true);
  assertEquals(result.branchProtected, false);
  assertEquals(result.rules, ["deletion", "pull_request"]);
});

Deno.test("not protected when neither branch protection nor rules apply", async () => {
  const gh = fakeGitHub({
    "/repos/torvalds/linux": {
      body: { full_name: "torvalds/linux", default_branch: "master" },
    },
    "/repos/torvalds/linux/branches/master": { body: { protected: false } },
    "/repos/torvalds/linux/rules/branches/master": { body: [] },
  });
  const result = await inspectProtection(
    { owner: "torvalds", repo: "linux" },
    gh.fetchFn,
  );
  assertEquals(result.protected, false);
  assertEquals(result.defaultBranch, "master");
});

Deno.test("follows a renamed repo by using GitHub's canonical full_name", async () => {
  const gh = fakeGitHub({
    "/repos/old-owner/old-name": {
      body: { full_name: "new-owner/new-name", default_branch: "trunk" },
    },
    "/repos/new-owner/new-name/branches/trunk": { body: { protected: true } },
    "/repos/new-owner/new-name/rules/branches/trunk": { body: [] },
  });
  const result = await inspectProtection(
    { owner: "old-owner", repo: "old-name" },
    gh.fetchFn,
  );
  assertEquals(result.fullName, "new-owner/new-name");
  assertEquals(result.protected, true);
});

Deno.test("encodes branch names with slashes segment by segment", async () => {
  const gh = fakeGitHub({
    "/repos/a/b": {
      body: { full_name: "a/b", default_branch: "release/v1#x" },
    },
    "/repos/a/b/branches/release/v1%23x": { body: { protected: false } },
    "/repos/a/b/rules/branches/release/v1%23x": { body: [] },
  });
  const result = await inspectProtection({ owner: "a", repo: "b" }, gh.fetchFn);
  assertEquals(result.defaultBranch, "release/v1#x");
  assertEquals(result.protected, false);
});

Deno.test("a missing or private repo is an error, not false", async () => {
  const gh = fakeGitHub({});
  await assertRejects(
    () => inspectProtection({ owner: "nobody", repo: "nothing" }, gh.fetchFn),
    Error,
    "nobody/nothing not found",
  );
});

Deno.test("rate limiting is reported as such, with the reset time", async () => {
  const gh = fakeGitHub({
    "/repos/denoland/deno": {
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
    },
  });
  await assertRejects(
    () => inspectProtection({ owner: "denoland", repo: "deno" }, gh.fetchFn),
    Error,
    "rate limit exceeded; resets at 1970-01-01T00:00:00.000Z",
  );
});

Deno.test("any other GitHub failure names the request and status", async () => {
  const gh = fakeGitHub({
    ...REPO,
    "/repos/denoland/deno/branches/main": { status: 500 },
  });
  await assertRejects(
    () => inspectProtection({ owner: "denoland", repo: "deno" }, gh.fetchFn),
    Error,
    "GET /repos/denoland/deno/branches/main failed: HTTP 500",
  );
});
