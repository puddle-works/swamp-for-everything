import { assertEquals } from "jsr:@std/assert@1";
import { parseOptions, percent, stepKind } from "./present.ts";

Deno.test("only the ask step is the AI component; everything else is deterministic swamp", () => {
  assertEquals(stepKind("ask"), "ai");
  for (const s of ["frame", "resolve", "check"]) {
    assertEquals(stepKind(s), "deterministic");
  }
});

Deno.test("options are one per line, trimmed, blanks dropped", () => {
  assertEquals(parseOptions(" MongoDB \n\nPostgreSQL\n  \nDynamoDB\n"), [
    "MongoDB",
    "PostgreSQL",
    "DynamoDB",
  ]);
});

Deno.test("confidence renders as a whole percentage", () => {
  assertEquals(percent(0.67), "67%");
  assertEquals(percent(1), "100%");
  assertEquals(percent(0), "0%");
});
