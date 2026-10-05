import { assertEquals } from "jsr:@std/assert@1";
import { findCheck, githubRepoUrl, normalise } from "./registry.ts";

const PROTECTED = "Is the default branch of this repository protected?";

Deno.test("normalise trims, lower-cases and collapses whitespace", () => {
  assertEquals(normalise("  Is  THIS\n\tok? "), "is this ok?");
});

Deno.test("findCheck matches the branch-protection question exactly", () => {
  const check = findCheck({ type: "noul", instructions: PROTECTED });
  assertEquals(check?.workflow, "branch-protection");
  assertEquals(
    findCheck({
      type: "noul",
      instructions: "  is the DEFAULT branch of this repository   protected? ",
    })?.workflow,
    "branch-protection",
  );
});

Deno.test("findCheck does not match a reworded question, another type, or non-text", () => {
  assertEquals(
    findCheck({ type: "noul", instructions: "Is main protected?" }),
    undefined,
  );
  assertEquals(
    findCheck({
      type: "choice",
      instructions: PROTECTED,
      criteria: { yes: null, no: null },
    }),
    undefined,
  );
  assertEquals(
    findCheck({ type: "noul", instructions: { question: PROTECTED } }),
    undefined,
  );
});

Deno.test("githubRepoUrl finds the repo in text", () => {
  assertEquals(
    githubRepoUrl("The repo https://github.com/o/r.git is ours."),
    "https://github.com/o/r",
  );
  assertEquals(
    githubRepoUrl("see https://github.com/o/r/tree/main/src"),
    "https://github.com/o/r",
  );
  assertEquals(
    githubRepoUrl("It is https://github.com/o/my.repo."),
    "https://github.com/o/my.repo",
  );
});

Deno.test("githubRepoUrl finds the repo anywhere in an object or array", () => {
  assertEquals(
    githubRepoUrl({ repository: { url: "https://github.com/o/r" }, n: 1 }),
    "https://github.com/o/r",
  );
  assertEquals(
    githubRepoUrl([{ links: ["https://github.com/o/r"] }]),
    "https://github.com/o/r",
  );
});

Deno.test("githubRepoUrl is undefined when there is no repo or more than one", () => {
  assertEquals(githubRepoUrl("no links here"), undefined);
  assertEquals(githubRepoUrl("https://gitlab.com/o/r"), undefined);
  assertEquals(
    githubRepoUrl("https://github.com/o/a and https://github.com/o/b"),
    undefined,
  );
  assertEquals(
    githubRepoUrl("https://github.com/O/R and https://github.com/o/r.git"),
    "https://github.com/O/R",
  );
});

Deno.test("the branch-protection check maps protected to a certain noul", () => {
  const check = findCheck({ type: "noul", instructions: PROTECTED })!;
  assertEquals(check.inputs("https://github.com/o/r"), {
    url: "https://github.com/o/r",
  });
  assertEquals(check.inputs("nothing"), undefined);
  assertEquals(check.answer({ protected: true }), { type: "noul", noul: 1 });
  assertEquals(check.answer({ protected: false }), { type: "noul", noul: 0 });
  assertEquals(check.answer({}), undefined);
});
