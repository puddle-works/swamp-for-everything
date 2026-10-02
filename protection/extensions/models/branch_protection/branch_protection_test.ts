import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0";
import { model } from "./branch_protection.ts";

Deno.test("branch-protection type declares parse and inspect with target/protection resources", () => {
  assertEquals(model.type, "@mesgme/branch-protection");
  assertEquals(Object.keys(model.methods).sort(), ["inspect", "parse"]);
  assertEquals(Object.keys(model.resources).sort(), ["protection", "target"]);
});

Deno.test("parse writes a target resource with owner and repo", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "parse",
  });
  const url = "https://github.com/denoland/deno.git";
  const result = await model.methods.parse.execute({ url }, context);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "target");
  assertEquals(written.data, { url, owner: "denoland", repo: "deno" });
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("parse throws and writes nothing for a link that is not a GitHub repo", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "parse",
  });
  await assertRejects(
    () => model.methods.parse.execute({ url: "https://example.com" }, context),
    Error,
    "not a GitHub repository link",
  );
  assertEquals(getWrittenResources().length, 0);
});

/** Swap globalThis.fetch for the duration of fn. */
async function withFetch(
  routes: Record<string, unknown>,
  fn: () => Promise<void>,
) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    return Promise.resolve(
      path in routes
        ? new Response(JSON.stringify(routes[path]))
        : new Response("{}", { status: 404 }),
    );
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("inspect writes a protection resource with the boolean answer and evidence", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "inspect",
  });
  await withFetch({
    "/repos/denoland/deno": {
      full_name: "denoland/deno",
      default_branch: "main",
    },
    "/repos/denoland/deno/branches/main": { protected: true },
    "/repos/denoland/deno/rules/branches/main": [],
  }, async () => {
    await model.methods.inspect.execute(
      { owner: "denoland", repo: "deno" },
      context,
    );
  });
  const [written] = getWrittenResources();
  assertEquals(written.specName, "protection");
  assertEquals(written.data.protected, true);
  assertEquals(written.data.fullName, "denoland/deno");
  assertEquals(written.data.defaultBranch, "main");
  assertEquals(written.data.branchProtected, true);
  assertEquals(written.data.rules, []);
  assert(!Number.isNaN(Date.parse(String(written.data.checkedAt))));
});

Deno.test("inspect throws and writes nothing when the repo is not visible", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "inspect",
  });
  await withFetch({}, async () => {
    await assertRejects(
      () =>
        model.methods.inspect.execute(
          { owner: "mesgme", repo: "private" },
          context,
        ),
      Error,
      "not found",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});
