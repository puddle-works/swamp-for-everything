import { assertEquals } from "jsr:@std/assert@1";
import { describeEvidence, stepKind } from "./present.ts";

Deno.test("only the inspect step calls out to GitHub; everything else is deterministic swamp", () => {
  assertEquals(stepKind("inspect"), "external");
  for (const s of ["parse", "check"]) {
    assertEquals(stepKind(s), "deterministic");
  }
});

Deno.test("evidence says which kind of protection GitHub reported", () => {
  assertEquals(
    describeEvidence({ branchProtected: true, rules: [] }),
    "branch protection",
  );
  assertEquals(
    describeEvidence({
      branchProtected: false,
      rules: ["deletion", "pull_request"],
    }),
    "ruleset rules: deletion, pull_request",
  );
  assertEquals(
    describeEvidence({ branchProtected: true, rules: ["pull_request"] }),
    "branch protection; ruleset rules: pull_request",
  );
  assertEquals(
    describeEvidence({ branchProtected: false, rules: [] }),
    "no branch protection and no ruleset rules",
  );
});
