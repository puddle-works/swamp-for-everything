# Jev router: investigation (#16)

## In short

A small service that accepts the same requests as Jev (`POST /v1/systemone`). It
handles each question in a request as follows:

1. **A swamp check exists for it**: it answers the question itself, in Jev's
   format, with certainty (`noul` 1 or 0, or `choice` with probability 1).
2. **No check, but it could be deterministic**: it raises a puddle asking for a
   check to be built, and passes the question through to Jev.
3. **Not deterministic**: it passes the question through to Jev.

Callers don't change anything except the base URL.

**Recommendation: worth building, as a small spike.** Start with one check,
spike 1's branch-protection workflow, and the three rules above. Nothing else.
The build plan is at the end.

---

## 1. Jev's interface

Jev is TypeSafe's "System One" model. It doesn't write text. You give it some
state plus typed questions, and it returns a probability for each answer.

Source: <https://docs.typesafe.ai/api.md> and the `@swamp/typesafe-ai` swamp
extension (`models/_lib/client.ts`), which match each other.

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

### Request

| Field       | Type                     | Notes                                  |
| ----------- | ------------------------ | -------------------------------------- |
| `state`     | string, object, or array | What to evaluate                       |
| `model`     | string                   | e.g. `jev-latest`                      |
| `questions` | map of id → question     | At least one; ids are the caller's own |

Each question has a `type`, `instructions` (a string, object or array), and
`criteria`:

| `type`   | Asks                        | `criteria`                                     |
| -------- | --------------------------- | ---------------------------------------------- |
| `noul`   | Is this true?               | Optional `{ "true": …, "false": … }`           |
| `choice` | Which of these options?     | Map of option → description, at least 2        |
| `score`  | Which level on this rubric? | Ordered list of level descriptions, at least 2 |

### Response

```json
{
  "model": "jev-…",
  "answers": {
    "is_protected": { "type": "noul", "noul": 0.91 },
    "severity": {
      "type": "choice",
      "choice": "high",
      "probabilities": { "high": 0.8, "low": 0.2 },
      "confidence": 0.7
    },
    "quality": {
      "type": "score",
      "score": 1.6,
      "legend": { "…": "…" },
      "probabilities": { "…": 0.0 },
      "confidence": 0.6
    }
  },
  "usage": { "input_tokens": 294, "output_tokens": 20 }
}
```

### Errors

`401` bad key, `422` validation failed, `429` rate limited, `529` overloaded.
The docs recommend exponential backoff for 429 and 529.

There's also `GET /v1/models`, which lists the models an account can use. The
extension uses it, but the API reference doesn't mention it.

### Checked for real

The puddleworks-apps repo (`~/dev/puddleworks`) has a `jev` model pointing at
`https://opencode.ai/zen` with model `jev-1.13-free`. I sent it one `noul`
question through the extension, which sends exactly the official request shape.
The call succeeded:

- state: "The repository mesgme/swamp-for-everything has branch protection
  enabled on main."
- question: "Is the default branch of this repository protected?"
- answer: `noul: 0.91` (294 input tokens, 20 output)

So the OpenCode Zen route accepts the official request shape. The answer also
shows why the router is useful: Jev gives 0.91 for something a GitHub API call
answers with certainty.

### Reusable code

The extension's `models/_lib/client.ts` already has Zod schemas for every
request and response field, plus retries that honour `Retry-After`. The router
should copy the schemas and the client rather than write new ones. The extension
is licensed AGPL-3.0 with a swamp extension exception, so keep its header if we
copy it.

---

## 2. "A check exists": matching a question to a swamp workflow

The router keeps a short **registry**, a list where each entry says:

- **matches**: the question's `type` and its `instructions` text, compared after
  trimming, lower-casing and collapsing whitespace. It must be an exact match.
- **workflow**: the swamp workflow to run, e.g. `branch-protection`.
- **inputs from state**: how to get the workflow's inputs out of `state`. For an
  object, a field path (e.g. `repository.url`). For text, a pattern (e.g. the
  first `https://github.com/owner/repo` URL).
- **answer**: how to turn the workflow's result into a Jev answer, e.g.
  `protected: true` → `noul: 1`.

If anything doesn't line up (no match, or the inputs can't be found in `state`),
the question falls through to rules 2 and 3. **A wrong match must never produce
a confident wrong answer.** That's why matching is exact and not left to Jev.

Why not match on the question id: ids are chosen by each caller, so two callers
asking the same thing will use different ids. The `instructions` text is the
actual question.

Accepted limitation: rewording the question misses the check and falls through
to Jev. That's safe, and the puddle log (section 4) will show which wordings are
common enough to add.

### Answers in Jev's format

| Type     | Deterministic answer                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| `noul`   | `noul: 1` or `noul: 0`                                                             |
| `choice` | `choice: X`, `probabilities: {X: 1, others: 0}`, `confidence: 1`                   |
| `score`  | `score: <level>`, one-hot `probabilities`, `legend` from criteria, `confidence: 1` |

The key format Jev uses in `score`'s `legend` and `probabilities` needs checking
against a real Jev response before we build a score check. The spike only needs
`noul`.

### If a check fails

Spike 1's rule was that a GitHub error fails the check and never becomes a wrong
`false`. In the router, a failed check **falls through to Jev** and the failure
is logged. The caller still gets an answer, just as they would today, and never
a wrong certain one.

---

## 3. "Could be deterministic": who decides

**Recommendation: ask Jev, in the same call.**

When the router forwards questions to Jev, it adds one extra `noul` question for
each forwarded question, e.g.:

> Could this question be answered exactly by code, from facts available to a
> program (an API, a database, a fixed rule), without judgement? Question: "<the
> caller's instructions>"

It strips those extra answers out before replying to the caller.

- There's no extra round trip, and only a few more tokens.
- It's a judgement call, which is exactly what Jev is for.
- A wrong "yes" costs one puddle that gets triaged away. A wrong "no" means a
  missed puddle. Neither ever changes the caller's answer.
- A threshold decides: raise a puddle at ≥ 0.8. Tune it once real traffic shows
  how it behaves.

Rejected: a hand-written list of "deterministic-looking" phrases. It would miss
most cases and need constant upkeep.

---

## 4. Raising the puddle

A puddle is a Puddleworks App Request (`@mesgme/puddle/request`, in
`~/dev/puddle`, repo `puddle-works/puddleworks`). It's a request for someone to
build something. Here, that something is the missing check.

| Field                | Value                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `title`              | `Deterministic check: <instructions, shortened>`                                                 |
| `requester`          | The router's owner (config), e.g. `mark@mesg.solutions`                                          |
| `acceptanceUser`     | Same                                                                                             |
| `problemDescription` | The question type, instructions, criteria, and one example `state`                               |
| `currentProcess`     | "Answered by Jev (an LLM) via the Jev router. Jev rated it <p> likely to be answerable by code." |
| `frequency`          | `event_triggered`                                                                                |
| `sourceRef`          | `jev-router:<hash of type + normalised instructions>`                                            |

**No duplicates.** The same question will arrive many times. The `sourceRef` is
stable for the same question, so the router raises a puddle only the first time
it sees that `sourceRef`. After that it just counts repeats. A high count is a
good reason to build the check first.

**Only a submitted puddle counts.** The router submits the puddle, not just
drafts it, so triage sees it.

**Dependency: puddle-works/puddleworks#132.** There isn't yet one call to create
a puddle; today it takes `swamp model create`, then `draft`, then `submit`.
Until #132 exists, the spike runs those three CLI steps against `~/dev/puddle`.
Puddle creation must never slow down or fail the caller's request, so it happens
after the reply is sent.

This gives #132 a clear first caller, with these needs: create and submit in one
call, return the existing puddle for a repeated `sourceRef`, and name the puddle
from `sourceRef`.

---

## 5. Mixed requests

One request can hold several questions that end up on different routes:

1. Split the questions into those that **match** a check and **the rest**.
2. Run the matched checks. Send the rest, plus the "could be deterministic"
   questions, to Jev in **one** call with the same `state` and `model`.
3. Merge both sets of answers under the caller's original ids.
4. `usage`: report Jev's figures as they are, or `0/0` if Jev wasn't called. Jev
   doesn't split usage per question, so the extra questions' tokens are
   included.
5. `model`: Jev's value if Jev was called. Otherwise, echo the requested `model`
   so callers that check it don't break.
6. After replying, raise any puddles (section 4).

If Jev returns an error, the router returns that same error to the caller, even
if some questions were answered locally. Callers already handle Jev's errors, so
this keeps behaviour unchanged.

**Auth:** the spike passes the caller's `Authorization` header through to Jev,
so the router holds no TypeSafe key. Questions answered locally don't check the
key in the spike. Fix that before the router is exposed beyond localhost.

---

## Build plan (for approval)

**What it proves:** a Jev caller gets certain answers where a swamp check
exists, gets Jev's answers everywhere else, and missing checks turn up as
puddles. It needs no change on the caller's side beyond the base URL.

**What it is NOT:** a general registry editor, a UI, or several checks. It uses
one check (branch protection), `noul` only, and runs on localhost.

1. **Router API**: `POST /v1/systemone` in `spikes/branch-protection-api/api/`, next to spike 1's `/check`.
   Copy the request/response schemas from `@swamp/typesafe-ai`.
2. **Registry**: one entry, mapping "Is the default branch of this repository
   protected?" to the `branch-protection` workflow, with the GitHub URL taken
   from `state`.
3. **Forwarding**: send everything that doesn't match to Jev (OpenCode Zen
   route), with the "could be deterministic" question added and then stripped.
4. **Puddles**: at ≥ 0.8, raise a submitted puddle once per `sourceRef` (CLI
   steps against `~/dev/puddle` until #132 lands).
5. **Tests first** (TDD), with Jev and swamp faked. Then one real run with a
   request containing three questions: one that matches the check, one that
   could be deterministic, and one that is pure judgement.
