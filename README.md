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
/adversarial max 3        # rounds for this session (1..6)
/adversarial severity concern
/adversarial model session     # default: advisor runs the session's live model
/adversarial model configured  # use modelRoles.advisor / the WATCHDOG entry model
/adversarial sync off     # release the advisor.syncBacklog pin
```

Durable arming goes through normal plugin settings:

```bash
omp plugin config --set enabled=true            # ~/.omp/plugins/omp-plugins.lock.json
omp plugin config --set maxRounds=3
omp plugin config --set minSeverity=concern
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
| `maxRounds` | `4` | Continuations per user prompt (clamped to 1..6). |
| `maxRepeats` | `2` | Re-raises of the same finding before escalation. |
| `forceSyncBacklog` | `true` | Pin `advisor.syncBacklog: strict` while armed. |
| `useSessionModel` | `true` | Default the advisor to the session's live model. |
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

- `session_stop` continuations are capped by the host at 8 per user prompt; the
  advisor's own continuations spend from that budget too, so `maxRounds` is
  clamped to 6.
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
bun test          # 28 tests: decision core + host wiring
bun run typecheck
```

## License

MIT
