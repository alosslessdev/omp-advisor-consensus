# omp-advisor-consensus

An adversarial loop between omp's **advisor** and the **main agent**. The
advisor reviews each turn; every finding the agent has not answered becomes a
continuation turn that quotes the finding, demands a fix or an evidence-backed
rebuttal, and re-reviews. The run only settles when the advisor raises nothing
further **and** the agent does not claim its own work is still open.

Think Ralph loop (`while not done: run again`), but with a second model as the
termination oracle, a per-prompt round budget, a repeat detector, and an audit
ledger persisted in the session.

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

Requires the advisor subsystem to be usable: set `advisor.enabled: true` and a
resolvable `advisor` model role (or a `WATCHDOG.yml` roster). The plugin warns
once per session when the advisor is off.

## Turning it on

```text
/adversarial              # toggle: on <-> off (off cancels)
/adversarial on           # arm for this session
/adversarial pause        # stop acting, keep the episode and its round budget
/adversarial resume       # continue the same episode
/adversarial off          # disarm and cancel the in-flight episode
/adversarial status       # mode, advisor, config, sync policy, round, converged count
/adversarial config       # TUI editor for rounds, repeats, severity, notify, sync, model
/adversarial max 12       # rounds for this session (1..100)
/adversarial repeats 4    # re-raises of one finding before escalation (1..10)
/adversarial severity concern
/adversarial require-stop off # allow silence to close (default: required)
/adversarial model session     # default: advisor runs the session's live model
/adversarial model configured  # use modelRoles.advisor / the WATCHDOG entry model
/adversarial sync off     # release the advisor.syncBacklog pin
```

Arming brings the reviewer up: if `advisor.enabled` is false, `/adversarial on`
(or a resumed session that was armed) overrides it to true for this session,
runtime-only, cleared by `/adversarial off` and on shutdown. Nothing is written
to your config. If the override is unavailable the plugin says so with a
transient toast instead of looking broken later.

Arming is recorded in the session transcript, so `/adversarial on` survives
`omp --resume`. The plugin also re-reads `advisor.enabled` at every settle, so
`/advisor on` mid-session is picked up without a restart.

`/adversarial config` opens a TUI editor for the live values; the same numbers
can be passed inline (`max`, `repeats`, `severity`) or set durably through
plugin settings:

```bash
omp plugin config --set enabled=true            # ~/.omp/plugins/omp-plugins.lock.json
omp plugin config --set maxRounds=12
omp plugin config --set maxRepeats=4
omp plugin config --set minSeverity=concern
```

While the loop is armed, the status line next to the message box keeps showing
the effective configuration and the live round:

```text
adversarial on · 100 rounds · repeats 3
adversarial 4/100 · 2 open
adversarial paused · 4/100
adversarial converged · 4/100
```

`off` is not `pause`: off writes a `settled: "cancelled"` marker for the active
episode, so a late advisor card cannot restart it. Pause leaves the ledger
untouched; resume continues from the same round.

## Loop

```text
user prompt
    |
    v
agent turn  --->  advisor review (forced synchronous while armed)
    |                    |
    |            findings after the last assistant message?
    |                    |
    |             no ----+---- yes
    |             |             |
    |             v             v
    |        settle       continuation turn with the ledger
    |                          |
    +--------------------------+   (round++ up to maxRounds)
```

Agreement is two-sided:

- **advisor side** — either an explicit stop call, or silence. Silence is why
  the plugin pins `advisor.syncBacklog` to `strict`: without it the final review
  can still be in flight at settle time, and "nothing yet" would be mistaken for
  "nothing to say".
- **agent side** — the reply must not end with `verdict: open`. Agent silence is
  fine; an explicit admission of open work escalates instead of converging.

### Who decides convergence

The advisor. Its `advise(note: "[converged] …")` call is evaluated before the
round budget and overrides even the agent's own `verdict: open`; the plugin only
decides whether to spend another turn. The call itself is not forwarded to the
agent as work — it is recorded in the ledger as `viaStopCall` and stays visible
in the transcript as an advisor card.

That is the default (`requireStopCall: true`): an episode that ends without an
explicit call escalates with the open list instead of being recorded as
agreement. Because the default reviewer prompt asks the advisor to speak only
with evidence, and the host's emission guard drops content-free notes (`stop`,
`done`, `lgtm`), the loop needs the stop-call guidance to know the protocol —
copy [`examples/WATCHDOG.md`](examples/WATCHDOG.md) into your `WATCHDOG.md`.

`/adversarial require-stop off` (or `requireStopCall=false`) brings back
silence-as-agreement: cheaper for a reviewer that only speaks when it has
something to say, at the cost of an implicit decision.

### The advisor's stop call

Advisor tool grants come from the built-in catalog only, so a plugin cannot hand
the advisor a dedicated `stop` tool. The tool it always has is `advise`, so the
stop call is a reserved note:

```text
advise(note: "[converged] every finding is fixed or soundly rebutted")
```

That call closes the episode immediately (even over a `verdict: open` from the
agent) and is never counted as a finding. A note that arrives in the same batch
as a real finding is ignored — nobody stops mid-objection. To teach the advisor
the protocol, copy [`examples/WATCHDOG.md`](examples/WATCHDOG.md) into your
project or user `WATCHDOG.md`. The short version:

```markdown
When nothing is left to raise, call `advise` once with
`[converged] <one-line reason>`. That call ends the adversarial loop; silence
also ends it, but the call is explicit and audited.
```

Every finding enters a ledger keyed by normalized text. A finding the advisor
re-raises `maxRepeats` times escalates to the operator rather than spinning, and
the round budget caps the whole exchange.

### Late notes

A review that finishes *after* the run settled cannot wake the agent: the host
preserves it as a card and stays idle. The plugin catches advisor messages for
ten minutes after `agent_end`, and when one lands unanswered it reopens the
converged episode, spends the next round, and steers the agent itself. A
cancelled or escalated episode never reopens.

## What the agent sees

Each continuation carries a machine-shaped block, not a paraphrase:

```xml
<advisor-consensus round="2" max_rounds="4">
The advisor reviewed your last turn and left findings open. ...
Open findings:
1. [concern] advisor="Architecture" Missing regression test for the new parser branch
2. [blocker] Division by zero is unhandled
...
Close your reply with exactly this block:
<convergence>
1: fixed | rebutted | blocked — one line of evidence
2: ...
verdict: closed | open
</convergence>
</advisor-consensus>
```

The agent keeps the right to disagree — advisor notes are advisory — but a
rebuttal needs evidence the advisor has not already rejected.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Arm the loop. Off until you turn it on. |
| `minSeverity` | `nit` | Lowest finding severity that keeps the loop running. |
| `maxRounds` | `100` | Continuations per user prompt (configurable 1..100). |
| `maxRepeats` | `3` | Re-raises of the same finding before escalation (1..10). |
| `forceSyncBacklog` | `true` | Pin `advisor.syncBacklog: strict` while armed. |
| `useSessionModel` | `true` | Default the advisor to the session's live model. |
| `requireStopCall` | `true` | Strict agreement: only the advisor's `[converged]` call closes; silence escalates. |
| `notify` | `true` | Toast per round, convergence, and escalation. |

Env overrides for one process: `OMP_ADVISOR_CONSENSUS_ENABLED`,
`OMP_ADVISOR_CONSENSUS_MIN_SEVERITY`, `OMP_ADVISOR_CONSENSUS_MAX_ROUNDS`,
`OMP_ADVISOR_CONSENSUS_MAX_REPEATS`, `OMP_ADVISOR_CONSENSUS_FORCE_SYNC_BACKLOG`,
`OMP_ADVISOR_CONSENSUS_USE_SESSION_MODEL`, `OMP_ADVISOR_CONSENSUS_NOTIFY`.

### Advisor model

An adversarial loop is most informative when both sides are comparable, so the
default advisor model is whatever the session is running: the plugin pins
`modelRoles.advisor` to the live `provider/id` and re-pins it after a `/model`
switch. Two things win over that default:

- an explicitly configured `modelRoles.advisor` (the plugin reads
  `isConfigured` before touching it and leaves your choice alone),
- a `WATCHDOG.yml` roster entry with its own `model` — roster models bypass the
  role entirely.

`/adversarial model configured` restores the role-based resolution for the
session.

## When it stays out of the way

- advisor subsystem disabled
- plan mode active (only user-driven turns resolve plan reviews)
- errored or aborted turns
- sessions that are not the main agent (subagents, task children)
- an episode already settled for the current user prompt
- paused, or turned off

## Limits

- Rounds 1-6 ride the host's `session_stop` continuation (capped at 8 per
  prompt, shared with advisor continuations). Later rounds are steered from
  `agent_end` as agent-initiated turns, which is what lets `maxRounds` reach
  100. Verified headless: rounds 1-6 arrive as `session-stop-continuation`, round
  7 onward as an `advisor-consensus` turn. A process that is already disposing
  can drop the final steered turn.
- A 100-round budget is a ceiling, not a target: each round is one agent turn
  plus one advisor review. `maxRepeats` usually ends a deadlock far sooner.
- `syncBacklog: strict` makes every reviewed turn wait for its advisor review.
  That is the price of a trustworthy "silence means agreement"; `/adversarial
  sync off` opts out and accepts that a late note starts a new episode.
- The repeat detector compares normalized text. A determined paraphrase passes;
  the round budget still bounds the exchange.
- The advisor's explicit stop is a reserved `advise` payload, not a real tool:
  advisor grants are validated against the built-in tool catalog, so extension
  tools cannot be handed to an advisor.
- Findings are read from advisor transcript entries (`customType: "advisor"`),
  so anything the host delivers as an advisor note is in scope.
- Headless `-p` drains advisors after the prompt settles and refuses to start
  hidden turns, so the catch-up can only re-open an episode while the process
  is still running its post-settle drain. Interactive sessions get the full
  loop.

## State and audit

Each round appends a `custom` session entry:

```json
{ "v": 1, "anchor": "<last user message id>", "round": 2, "seen": { "missing test": 1 }, "settled": "converged" }
```

`anchor` scopes the episode to one user prompt, so a new prompt starts a fresh
budget and a resumed session continues an interrupted episode.

## Development

```bash
bun install
bun test          # 33 tests: decision core + host wiring
bun run typecheck
```

## License

MIT
