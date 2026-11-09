# The Jev router: certain answers where we can, Jev where we can't

People ask Jev (TypeSafe's System One model) questions like "is the default
branch of this repository protected?" Jev gives a good estimate. But that
question has an exact answer, and swamp already has a check that finds it. So we
built a router. It takes the same requests as Jev and answers what it can from
swamp. It sends everything else to Jev. When a question looks like it could have
an exact answer, the router asks for a check to be built. It worked on the first
real run. Its first home turned out to be the wrong one, and one small parsing
shortcut nearly let it give certain answers about the wrong repo.

## What we built

The router is a small Deno server in `spikes/jev-router/`. It serves Jev's API,
`POST /v1/systemone`, at `http://127.0.0.1:8788`. A request carries some `state`
(any text or JSON) and a set of questions. A `noul` question asks for a
probability from 0 to 1. For each question:

1. **A swamp check exists.** The question matches a registered check word for
   word, and the check's inputs can be found in `state`. The router runs the
   check's swamp workflow and answers with certainty: `noul` 1 or 0. Today there
   is one check: branch protection, which runs spike 1's `branch-protection`
   workflow.
2. **No check.** The question goes to Jev. In the same call, the router also
   asks Jev: "could this question be answered exactly by code, without
   judgement?"
3. **Jev says it could (≥ 0.8).** After the reply has gone back to the caller,
   the router raises a puddle (an App Request in Puddleworks) asking for the
   check to be built.

The caller changes only its base URL. Over time, as checks get built, more
answers become certain without the caller doing anything.

We built it in five stages, tests first, with Jev and swamp both faked. Then we
did one real run with three questions:

| Question                             | Answer       | Route                                                   |
| ------------------------------------ | ------------ | ------------------------------------------------------- |
| Is the default branch protected?     | `noul: 1`    | swamp check (GitHub agrees: `protected: true`)          |
| Does the repo have a LICENSE file?   | `noul: 0.53` | Jev, rated 0.82 "could be code", so a puddle was raised |
| Is the README friendly to newcomers? | `noul: 0.45` | Jev, rated 0.14, so no puddle                           |

## What went well

**We copied the contract instead of guessing it.** Swamp's `@swamp/typesafe-ai`
extension already had Jev's request and response schemas, and a client that
retries and checks Jev's replies. We copied the file unchanged, licence header
and all. Bad requests get the same 422 that Jev would give, and Jev's own errors
come back unchanged. When we sent a request with an empty key, the caller got
Jev's 401 exactly as Jev sent it.

**One call to Jev, not two.** The "could this be code?" question goes into the
same request as the caller's own questions, and the router removes it from the
reply. The caller never sees it, and there's no second round trip. A
three-question request took about 1.5 seconds end to end. `usage` is Jev's
figures as they are, so the caller can see the extra question in the token
count, which is honest.

**Puddles never slow the reply.** The router raises puddles after the response
has been sent, and if raising one fails, it only logs the failure. Each puddle
is named from a hash of the question's type and wording, so the puddle repo
itself remembers which questions already have one. Sending the same request
again logged "repeat 2" and created nothing. After a restart, the router found
the existing puddle and said "already exists".

**Moving it was cheap.** The router only ever talked to spike 1 through
`swamp serve`, over a WebSocket. So moving it into its own spike (see below) was
a `git mv`, a small server file and a README. The routing code didn't change.
The only edit was one string: the registry's path in the puddle text.

## What went badly

### 1. We built it in the wrong place

The build plan said to put the router in spike 1, `branch-protection-api`, next
to its `/check` route. That was convenient, because spike 1 already had the
swamp serve and the workflow.

But spike 1's README opens with "A fully deterministic API — no LLM anywhere."
To add the router, we had to change that to "no LLM anywhere (except the Jev
router below…)". That "except" was the warning sign, and we wrote it anyway.
After the PR was up, the request came back: give the router its own spike and
its own URL. Spike 1 is now back exactly as it was on main.

**Lesson:** if adding something means a spike's one-line description needs an
"except", the new thing is a separate spike.

### 2. A shortcut that could give a certain, wrong answer

The router finds the repo by looking for a GitHub URL in `state`. The first
pattern stopped at the first full stop it found, so
`https://github.com/o/my.repo` became `o/my`. The branch-protection check would
then have run against a different repo, and the caller would have got `noul: 1`
or `0`. That's a certain answer about the wrong thing.

That's the worst thing this router can do. A wrong estimate from Jev is
expected. A wrong answer with certainty is the one thing the router promises not
to give. We caught it while reviewing that stage, before it shipped. The fix
reads the whole name, then removes a sentence's full stop and a `.git` suffix.
We made the same call for other unclear cases: if `state` names two different
repos, the question goes to Jev rather than to the check.

**Lesson:** when your whole value is certainty, every parsing shortcut is a way
to be confidently wrong. When in doubt, send the question to Jev.

### 3. The threshold sits on a knife edge

Jev rated the LICENSE question 0.82, then 0.81, then exactly 0.8 across three
runs, against a threshold of 0.8. The same question lands on either side of it
from run to run. A puddle is only raised once per question, so a noisy score
only has to cross the line once. That pushes towards more puddles, not fewer.
Three runs aren't enough to pick a better number.

**Lesson:** run a borderline question several times before choosing a threshold,
and expect to tune it against real traffic.

### 4. An empty key that looked like a bad one

The first real run failed with Jev's 401. The key was fine. It was never read.
`swamp vault read-secret` asks for confirmation before showing a secret. Inside
`$(...)` there's no terminal to ask in, so it fails, prints nothing, and the
variable ends up empty. Adding `--yes` fixed it. The one upside was that the
failed run proved Jev's errors come back to the caller unchanged.

### Smaller snags

- **No puddle API yet.** Until puddleworks#132 lands, the router raises a puddle
  by running three swamp commands in the puddle repo: create, draft and submit.
  It retries once if swamp exits 137, the same `swamp update` race from the
  [mod diary](../claude-mod/swamp-diary-2026-10-05.md).
- **A formatter that rewrote a whole file.** Adding the router to spike 1's
  OpenAPI document with a JSON library and then `deno fmt` reformatted every
  line: a 274-line diff for one new path. We put the original back and inserted
  only the new parts. (It all moved to its own file in the end anyway.)
- **Matching is strict.** A question only matches a check word for word,
  ignoring case and spacing. "Is main protected?" goes to Jev. That's on
  purpose, but it means today the router only helps callers who ask the exact
  wording.

## What we'd do differently

- **Decide where a spike lives by what it claims.** Spike 1 claimed "no LLM",
  and the router broke that claim on day one.
- **Write the wrong-answer tests first.** The router's main risk is answering
  with certainty when it shouldn't. Tests with odd repo names, several repos and
  missing inputs should come before the happy path, not after it.
- **Measure the "could be code" score before choosing 0.8.** A handful of runs
  per question would have shown how much it moves.

## What's next

The router has already asked for its next check. The LICENSE question is now a
submitted puddle, `jev-router-252804b204f5cca1`, asking for a deterministic
"does this repo have a LICENSE file?" check. Building it would be the first
check that came from the router's own request, and the first proof that the loop
works.

After that: tune the threshold against real questions, replace the CLI steps
when the puddle API lands, and look at matching beyond exact wording. That last
one is where the risk is, so it needs the same rule as everything else here:
when the router isn't sure, Jev answers.
