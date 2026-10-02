import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { checkProtection, type FetchLike, parseRepoUrl } from "./check.ts";

Deno.test("parseRepoUrl accepts the canonical https URL", () => {
  assertEquals(parseRepoUrl("https://github.com/mesgme/swamp-for-everything"), {
    owner: "mesgme",
    repo: "swamp-for-everything",
  });
});

Deno.test("parseRepoUrl strips a trailing .git", () => {
  assertEquals(parseRepoUrl("https://github.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });
});

Deno.test("parseRepoUrl ignores a trailing slash, query and fragment", () => {
  assertEquals(parseRepoUrl("https://github.com/owner/repo/"), {
    owner: "owner",
    repo: "repo",
  });
  assertEquals(parseRepoUrl("https://github.com/owner/repo?x=1#y"), {
    owner: "owner",
    repo: "repo",
  });
});

Deno.test("parseRepoUrl ignores extra path segments (tree, blob, ...)", () => {
  assertEquals(parseRepoUrl("https://github.com/owner/repo/tree/main/src"), {
    owner: "owner",
    repo: "repo",
  });
});

Deno.test("parseRepoUrl rejects non-GitHub hosts", () => {
  assertThrows(() => parseRepoUrl("https://gitlab.com/owner/repo"));
  assertThrows(() => parseRepoUrl("https://github.example.com/owner/repo"));
  assertThrows(() => parseRepoUrl("https://notgithub.com/owner/repo"));
});

Deno.test("parseRepoUrl rejects URLs without an owner/repo path", () => {
  assertThrows(() => parseRepoUrl("https://github.com/owner"));
  assertThrows(() => parseRepoUrl("https://github.com/"));
  assertThrows(() => parseRepoUrl("https://github.com"));
});

Deno.test("parseRepoUrl rejects non-URL input", () => {
  assertThrows(() => parseRepoUrl("not a url"));
  assertThrows(() => parseRepoUrl(""));
  assertThrows(() => parseRepoUrl("git@github.com:owner/repo.git"));
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes GETs to canned responses keyed by pathname. */
function fakeFetch(routes: Record<string, () => Response>): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input);
    calls.push(url.pathname);
    assertEquals(
      (init?.headers as Record<string, string>)?.Authorization,
      "Bearer test-token",
    );
    const route = routes[url.pathname];
    if (!route) return Promise.resolve(jsonResponse(404, { message: "nope" }));
    return Promise.resolve(route());
  };
  return { fetch, calls };
}

Deno.test("checkProtection reports a classic-protected default branch", async () => {
  const { fetch, calls } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "main" }),
    "/repos/owner/repo/branches/main": () =>
      jsonResponse(200, { name: "main", protected: true }),
  });

  const result = await checkProtection(fetch, "test-token", {
    owner: "owner",
    repo: "repo",
  });

  assertEquals(result, {
    repo: "owner/repo",
    branch: "main",
    protected: true,
  });
  assertEquals(calls, [
    "/repos/owner/repo",
    "/repos/owner/repo/branches/main",
  ]);
});

Deno.test("checkProtection reports an unprotected branch", async () => {
  const { fetch } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "main" }),
    "/repos/owner/repo/branches/main": () =>
      jsonResponse(200, { name: "main", protected: false }),
    "/repos/owner/repo/rules/branches/main": () => jsonResponse(200, []),
  });

  const result = await checkProtection(fetch, "test-token", {
    owner: "owner",
    repo: "repo",
  });

  assertEquals(result.protected, false);
});

Deno.test("checkProtection treats a ruleset-only branch as protected", async () => {
  const { fetch } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "main" }),
    "/repos/owner/repo/branches/main": () =>
      jsonResponse(200, { name: "main", protected: false }),
    "/repos/owner/repo/rules/branches/main": () =>
      jsonResponse(200, [{ type: "required_status_checks" }]),
  });

  const result = await checkProtection(fetch, "test-token", {
    owner: "owner",
    repo: "repo",
  });

  assertEquals(result, {
    repo: "owner/repo",
    branch: "main",
    protected: true,
  });
});

Deno.test("checkProtection falls through to rulesets when the branch endpoint 404s", async () => {
  const { fetch } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "trunk" }),
    "/repos/owner/repo/rules/branches/trunk": () =>
      jsonResponse(200, [{ type: "pull_request" }]),
  });

  const result = await checkProtection(fetch, "test-token", {
    owner: "owner",
    repo: "repo",
  });

  assertEquals(result, {
    repo: "owner/repo",
    branch: "trunk",
    protected: true,
  });
});

Deno.test("checkProtection honours a non-default default_branch", async () => {
  const { fetch, calls } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "develop" }),
    "/repos/owner/repo/branches/develop": () =>
      jsonResponse(200, { name: "develop", protected: true }),
  });

  const result = await checkProtection(fetch, "test-token", {
    owner: "owner",
    repo: "repo",
  });

  assertEquals(result.branch, "develop");
  assertEquals(calls, [
    "/repos/owner/repo",
    "/repos/owner/repo/branches/develop",
  ]);
});

Deno.test("checkProtection throws when the repo lookup fails", async () => {
  const { fetch } = fakeFetch({
    "/repos/owner/missing": () => jsonResponse(404, { message: "Not Found" }),
  });

  await assertRejects(
    () =>
      checkProtection(fetch, "test-token", {
        owner: "owner",
        repo: "missing",
      }),
    Error,
    "repos/owner/missing: 404",
  );
});

Deno.test("checkProtection skips the ruleset call when already protected", async () => {
  const { fetch, calls } = fakeFetch({
    "/repos/owner/repo": () => jsonResponse(200, { default_branch: "main" }),
    "/repos/owner/repo/branches/main": () =>
      jsonResponse(200, { name: "main", protected: true }),
  });

  await checkProtection(fetch, "test-token", { owner: "owner", repo: "repo" });

  assertEquals(calls, [
    "/repos/owner/repo",
    "/repos/owner/repo/branches/main",
  ]);
});
