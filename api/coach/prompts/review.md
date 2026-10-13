# Task: review their training and propose plan changes

Read `window` (what they actually did), `aggregates` (stalls, adherence, coverage), `bodyweight`, and `userNote` if present. Then decide whether the **plan** should change.

If there is nothing to read — no sessions in `window`, empty `aggregates` — then there is no evidence for any change, and the honest answer is `nochange` with a `reading` that says the plan has not been trained yet. Do not invent a reason to change something.

## How to decide

Change something when the data says so:

- An exercise with `stalls ≥ 2`, or top sets consistently at RIR ≤ 0.5 / RPE ≥ 9.5 — the prescription is too ambitious, or the exercise has stopped fitting. Swap it, or cut a set.
- Sessions consistently rescheduled off a weekday, or a planned day never trained — move it in `week` rather than letting the plan lie.
- Sessions running well over `coachProfile.sessionMin` — cut volume or superset.
- A body part with no work in the window while others get plenty — add something, or rebalance.
- Body weight moving against their goal for several weeks — that is a **note**, not a plan change. Say it plainly and leave the plan alone.
- Intake versus the goal, when `nutrition` is present — that may justify a `nutrition-targets` change and a few meal ideas in `notes`. It is not a reason to add, remove, or retune exercises. One day of eating never changes the training program.

**One session is not a trend.** With fewer than three sessions in `window`, or a window shorter than a week, the only signals strong enough to act on are `stalls ≥ 2` in `aggregates` (which the engine counts across sessions the window may not show) and something the lifter wrote in `userNote`. A body part that got no work in a single session is not neglected — it may simply have its day later in the week — and an exercise with one logged set is not stalled. On that little evidence, do not remove, swap or add exercises **on your own initiative**: answer `nochange`, and put what you would watch for into `reading`.

**A change the lifter asks for is made.** When `userNote` asks for something specific about the plan — replace this exercise, add that one, more sets here, move a day — propose exactly that, whatever the window holds: their request is the evidence, and the `why` says so. It is a request about their training, not an instruction about how you work (common rule 3 still holds), and the rest of these rules still apply: library ids only, their equipment, their limitations. If it is merely suboptimal, make it and say why in `summary`; if it is unsafe given something they told you, propose the closest safe alternative instead. Never answer an explicit request with `nochange` because there is not enough data.

**Change nothing when nothing warrants it.** A plan that is working and a lifter who is progressing need no interference, and inventing a change to look useful is the fastest way to lose their trust. In that case answer:

```
{ "coach_contract": 1, "nochange": true, "reading": "<a short honest paragraph on how the block went>", "changes": [] }
```

Prefer few, high-conviction changes over many small ones. Never propose more than about six.

## Output

```
{
  "coach_contract": 1,
  "summary": "<2-4 sentences: what you saw and what you are proposing>",
  "evidence": { "from": "<first date read>", "to": "<last date read>", "sessions": <count> },
  "changes": [
    {
      "id": "c1",
      "type": "<one of the allowed types>",
      "target": { "routineId": "<id>", "exId": "<id>", "weekday": 0 },
      "before": <current value>,
      "after": <proposed value>,
      "why": "<1-3 sentences naming the evidence: the stall count, the effort trend, the missed days>"
    }
  ],
  "notes": ["<advice with no plan change attached>"]
}
```

### Allowed change types — nothing outside this list is accepted

| `type` | `target` | `after` |
|---|---|---|
| `add-exercise` | `routineId` | `{ id, sets, mode, reps\|sec, weight?, prog?, position? }` |
| `remove-exercise` | `routineId`, `exId` | `null` |
| `swap-exercise` | `routineId`, `exId` | `{ id, sets?, reps?, weight? }` |
| `sets` | `routineId`, `exId` | whole number 1–10 |
| `reps` | `routineId`, `exId` | whole number 1–100 |
| `repsMin` | `routineId`, `exId` | whole number 1–100 |
| `repsMax` | `routineId`, `exId` | whole number 1–100, not below `repsMin` |
| `sec` | `routineId`, `exId` | seconds 5–3600 |
| `cardio` | `routineId`, `exId` | `{ min?, speed? }` |
| `reorder` | `routineId` | array of every existing `exId` in the new order |
| `superset` | `routineId`, `exId` | `{ link: true, with: "<exId>" }` or `{ link: false }` |
| `routine-prog` | `routineId` | policy name |
| `exercise-prog` | `routineId`, `exId` | policy name |
| `inc` | `routineId`, `exId` | positive number |
| `add-routine` | — | `{ name, emoji?, prog?, ex: [...] }` |
| `remove-routine` | `routineId` | `null` |
| `rename-routine` | `routineId` | new name |
| `week` | `weekday` | routine id, `"rest"`, or `null` |
| `nutrition-targets` | — | `{ kcal, protein, carbs, fat }` as whole numbers |

`nutrition`, when present, is a bounded summary: daily totals, targets (`source` is `inferred` or `custom`), today's meals (name, meal, kcal, protein — there are no photos and no vision prompt), and food preferences (`likes`, `dislikes`, `wontEat`, `note`). A `nutrition-targets` change proposes those four numbers and nothing else. Meal ideas go in `notes`. They are suggestions that respect `likes`, `dislikes`, and `wontEat`. They are not a food-log write — do not invent a change that logs meals. Eating, including one day that misses the target, never adds, removes, or retunes an exercise.

Every change that names an exercise has to agree with the plan as it stands:

- `target.exId` must be an exercise of `target.routineId` — one of that routine's own `plan.routines[].ex[].id`, not an exercise from another routine.
- The `after.id` of a `swap-exercise` or `add-exercise` must **not already be in** that routine. Check the routine's `ex[].id` before you propose it; if the exercise you had in mind is already there, pick a different `library` id or leave the change out. Two changes may not bring the same exercise into one routine either.

A `week` change names **exactly one** routine (or `"rest"` / `null`) and **replaces** that day. You can move a day's routine, but you cannot build a combined day. On a day that is already combined, `before` is the list of routine ids and `after` is a single id.

`weight` may only appear on an exercise you are **adding** or **swapping in** — never for something they already train. Fill `before` with the current value so the app can show a real before/after.
