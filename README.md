# omp-advisor-consensus

An adversarial goal loop for omp. After every agent turn the plugin runs **its
own reviewer turn** over the live conversation and asks one question: was the
user's goal actually met? If not, the main session is re-prompted with the
findings and the loop repeats.

When omp's **advisor** is on, its unanswered notes are a second, independent
source of findings: the goal is accepted only when the reviewer says it is met
**and** the advisor has nothing left unanswered. The reviewer still works with
the advisor off, so the loop has no hard dependency on it.

There is **no escalation path**: an unmet goal never gets handed back to the
operator as a failure state. The episode ends only when both sources agree, or
when you pause/stop the loop.

Think Ralph loop (`while not done: run again`) with a second pass of the same
model as the termination oracle, a per-prompt ledger, stall pressure, and an
audit record in the session.

Off by default. Nothing runs until you arm it.

## Install

```bash
# local checkout (symlinked, edits are live)
omp plugin link /home/asdf/Downloads/omp-advisor-consensus

# git
omp plugin install github:alosslessdev/omp-advisor-consensus

# marketplace (this repo ships .omp-plugin/marketplace.json)
omp plugin marketplace add alosslessdev/omp-advisor-consensus
omp plugin install advisor-consensus@omp-advisor-consensus

# one-off
omp --extension /home/asdf/Downloads/omp-advisor-consensus/extensions/consensus.ts
```

The reviewer uses `ctx.runEphemeralTurn` (the `/btw` side-turn pipeline) on the
session's live model. Hosts without that API say so with a toast instead of
silently doing nothing.

## Turning it on

```text
/adversarial              # toggle: on <-> off (off cancels)
/adversarial on           # arm for this session
/adversarial pause        # stop acting, keep the episode and its budget
/adversarial resume       # continue the same episode
/adversarial off          # disarm and cancel the in-flight episode
/adversarial status       # mode, reviewer, config, round, converged count
/adversarial review       # evaluate now; spend a round if the goal is unmet
/adversarial config       # TUI editor for rounds, repeats, severity, notify
/adversarial max 12       # soft budget for this session (1..100)
/adversarial repeats 4    # re-raises of one finding before stall pressure (1..10)
/adversarial severity concern
/adversarial advisor on    # count advisor notes as findings (default)
/adversarial advisor off   # reviewer-only; ignore advisor notes
```

Arming is recorded in the session transcript, so `/adversarial on` survives
`omp --resume`. While armed, the status line next to the message box shows the
effective configuration and the live round:

```text
adversarial on · 100 rounds (soft) · repeats 3
adversarial 4/100 · 2 open
adversarial 4/100 · 2 open · stall 1
adversarial converged · 4/100
adversarial paused · 4/100
```

`off` is not `pause`: off writes a `settled: "cancelled"` marker for the active
episode so a later settle cannot restart it. Pause leaves the ledger untouched;
resume continues from the same round.

Durable settings live in the plugin lockfile:

```bash
omp plugin config --set enabled=true
omp plugin config --set maxRounds=12
omp plugin config --set maxRepeats=4
omp plugin config --set minSeverity=concern
```

## Loop

```text
user prompt
    |
    v
agent turn  --->  own reviewer turn (ephemeral, same model + context)
    |                    |
    |             goal met?  +  no unanswered advisor notes?
    |                    |
    |             yes ---+--- no
    |             |           |
    |             v           v
    |          settle    continuation turn with the findings
    |                        |
    +------------------------+   (round++, budget is soft)
```

Optionally, the advisor reviews each turn in parallel; its notes after the last
assistant message are merged into the same finding list, deduped by normalized
text at the higher severity.

The reviewer sees the same conversation the agent saw and is told to default to
"not met" unless the transcript shows the work and its verification. It replies
with one machine-readable block:

```xml
<review>
{"goal_met": false, "goal": "…", "summary": "…",
 "findings": [{"severity": "blocker", "text": "…"}]}
</review>
```

A reply that does not parse is retried once with a strict prompt; if it still
fails, the loop settles *without* continuing and warns. It never treats a broken
review as agreement.

### Why there is no escalation

Escalating an unmet goal to the operator means "the goal was not met" — the loop
quitting on its own. This plugin does not do that:

- **`maxRounds` is a soft budget.** Crossing it produces another round with a
  visible budget notice, not a hand-off. The round counter runs past the budget.
- **Repeats raise pressure, not the white flag.** A finding the reviewer raises
  `maxRepeats` times switches the next continuation into stall mode: the agent is
  told the previous approach failed, that repetition is failure, and to change
  the concrete action or name the exact missing input.
- **Only the reviewer closes an episode.** The agent cannot self-certify, and the
  operator's only exits are explicit: pause, off, or interrupting the turn.

Interrupted (`aborted`) and provider-errored turns are never reviewed, so
Ctrl-C stops the loop for that turn instead of starting another.

### Advisor notes (second source)

With `includeAdvisor` (default on) and a working advisor:

- **Unanswered advisor notes count.** A note that lands after the last assistant
  message becomes a finding even when the reviewer would accept the goal. The
  continuation lists it with `advisor="<name>"`.
- **`[converged]` is not a finding.** The advisor's reserved `advise` stop call
  is filtered out; agreement is still the reviewer's call, so an advisor stop
  does not close the loop on its own.
- **`syncBacklog` is pinned to `strict`** while armed (`forceSyncBacklog`), so a
  scheduled advisor review is not still in flight when the verdict is taken.
  `/adversarial sync` is gone; the pin is released on off/shutdown.
- **The advisor model follows the session** (`useSessionModel`) unless
  `modelRoles.advisor` is configured explicitly or a `WATCHDOG.yml` roster entry
  names its own model. Sweep `/adversarial advisor off` to go reviewer-only.
- **Arming turns a disabled advisor on for the session** (runtime override, not
  persisted) so its notes exist to supplement the reviewer. Turning it back off
  with `/advisor off` is respected.
- **Late notes are caught.** If a note arrives after the run settled, the plugin
  re-runs the reviewer for up to ten minutes; an unmet goal reopens the
  converged episode and steers another round.

The advisor needs `advisor.enabled: true` and a resolvable `advisor` model role
(or a `WATCHDOG.yml` roster). Without it, the loop is reviewer-only and says so.

### What the agent sees

Each continuation carries a machine-shaped block, not a paraphrase:

```xml
<adversarial-review round="2" max_rounds="10">
An independent reviewer judged the goal NOT met after your last turn.
Round 2 of a soft 10-round budget; the loop continues while the goal is unmet.

Open findings:
1. [concern] Missing regression test for the new parser branch
2. [blocker] Division by zero is unhandled

For each finding either fix it (and verify the fix) or rebut it with new, concrete evidence:
file:line, command output, a spec quote. …

Report per item, and do not claim the loop is over — the reviewer decides that:
1: fixed | rebutted | blocked — one line of evidence
2: …
</adversarial-review>
```

Stall rounds add a `<stall tier="N">` block with the repeated findings; rounds
past the budget add a `<budget>` block.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Arm the loop. Off until you turn it on. |
| `minSeverity` | `nit` | Lowest finding severity (reviewer or advisor) that keeps the loop running. |
| `maxRounds` | `100` | Soft budget of continuations per user prompt (1..100). |
| `maxRepeats` | `3` | Re-raises of one finding before stall pressure (1..10). |
| `includeAdvisor` | `true` | Count unanswered advisor notes alongside the reviewer. |
| `forceSyncBacklog` | `true` | Pin `advisor.syncBacklog: strict` while armed. |
| `useSessionModel` | `true` | Default the advisor model to the session's live model. |
| `notify` | `true` | Toast each round, convergence, stall, budget, late reopen. |

Env overrides for one process: `OMP_ADVISOR_CONSENSUS_ENABLED`,
`OMP_ADVISOR_CONSENSUS_MIN_SEVERITY`, `OMP_ADVISOR_CONSENSUS_MAX_ROUNDS`,
`OMP_ADVISOR_CONSENSUS_MAX_REPEATS`, `OMP_ADVISOR_CONSENSUS_INCLUDE_ADVISOR`,
`OMP_ADVISOR_CONSENSUS_FORCE_SYNC_BACKLOG`,
`OMP_ADVISOR_CONSENSUS_USE_SESSION_MODEL`, `OMP_ADVISOR_CONSENSUS_NOTIFY`.

### Models

The reviewer runs through `ctx.runEphemeralTurn`, so it uses the session's live
model and honors `/model` switches. The advisor, when included, is pinned to the
same live model by default so both sides argue from the same capability floor;
an explicitly configured `modelRoles.advisor` or WATCHDOG roster model wins.

## When it stays out of the way

- loop not armed
- advisor notes excluded (`/adversarial advisor off`)
- plan mode active
- errored or aborted turns
- sessions that are not the main agent (subagents, task children)
- an episode already settled for the current user prompt
- paused, or turned off
- a reviewer turn is already in flight

## Limits

- Rounds 1-6 ride the host's `session_stop` continuation (capped at 8 per
  prompt, shared with other stop hooks). Later rounds are steered from
  `agent_end` as agent-initiated turns, which is what lets the budget reach 100.
- Each round costs one agent turn **plus one reviewer turn**, plus the advisor's
  review when it is enabled. `maxRepeats` usually ends a deadlock with pressure
  far sooner than the budget.
- The reviewer judges the transcript, not the filesystem. It cannot run commands
  (ephemeral tool calls are discarded by the host); it can only refuse claims
  the transcript does not back.
- The repeat detector compares normalized finding text. A determined paraphrase
  passes; stall pressure still escalates the wording each time.
- Headless `-p` sessions settle the same way; `/adversarial review` gives you a
  manual nudge when there is no turn to hook.
- Advisor notes are read from transcript entries (`customType: "advisor"`), so
  anything the host delivers as an advisor note is in scope.

## State and audit

Each round appends a `custom` session entry:

```json
{ "v": 2, "anchor": "<last user message id>", "round": 2, "seen": { "missing test": 1 }, "stalls": 1, "settled": "converged" }
```

`anchor` scopes the episode to one user prompt, so a new prompt starts a fresh
budget and a resumed session continues an interrupted episode. Advisor findings
are not duplicated into the ledger; they are re-read from the transcript each
round. Ledger `v: 1` entries are still read; a legacy `settled: "escalated"` is
treated as a closed episode, never reopened.

## Development

```bash
bun install
bun test          # decision core + host wiring, reviewer stubbed
bun run typecheck
```

## License

MIT
