# Coach chat contract

Notes for whoever picks this up next. The app (`frontend/src/lib/coach-chat.js`, `coach-api.js`)
is coded against this shape; the server (`api/coach/jobs.js`, `routes.js`, `core/agent.js`) is
the other half. See [`CLAUDE.md`](../../CLAUDE.md) for the rest of the Coach.

## One turn

`POST /api/coach/chat` `{ message, lang? }` → `202 { job: { id } }`. The same refusals as
`/api/coach/plan`: `409` busy, `429` cap, `403` consent, plus `401` / `503` when the feature
is off. An empty or whitespace-only `message` is `400 { error: "message is required" }` — the
one extra status, so a blank turn does not spend the cap.

The body is this turn only. Earlier lines are read from the synced `S.coach.chat` (last 20
entries, each text sliced to 1500 characters). Entries older than `S.coach.chatClearedAt` are
dropped. The current message is omitted from that history when the app has already logged it.

## While it runs

`GET /api/coach/status` → `job { id, kind: "chat", state, startedAt, step? }`. `step` is one of
these exact English strings; the app translates them by their literal text:

- `Reading your workout history`
- `Checking your exercise progress`
- `Searching the exercise library`
- `Checking your food diary`
- `Checking your body metrics`
- `Looking at your routine`
- `Checking a proposal`
- `Writing a reply`

`show_exercises` reuses "Searching the exercise library"; `show_nutrition` reuses "Checking
your food diary". There is no other step string.

## When it finishes

`last`: `{ outcome: "chat", jobId, at, reply, cards }` where `cards` are informational
(`exercises`, `nutrition`). A failed chat keeps the existing last shape (`outcome: "failed"`,
`kind: "chat"`, `errorClass`).

`pending`: if the reply produced actionable cards (`changes`, `routines`),
`{ kind: "chat", jobId, createdAt, reply, cards }` and that replaces the open chat card.
A finished chat that only explains keeps the open chat card, so asking for an edit cannot
drop a workout they have not confirmed. A waiting plan, review or debrief is left in place
when the chat only informed.

`POST /api/coach/pending/resolve` accepts `kind: chat` the way it accepts every other pending:
`accepted: [cardId…]` or `dismissed: true`.

### Cards

| `type` | kind | fields |
|---|---|---|
| `exercises` | informational | `{ id, type, ids, note? }` |
| `nutrition` | informational | `{ id, type, summary, days: [{ d, kcal, protein, carbs, fat }] }` (≤14), `targets` or `null` |
| `changes` | actionable | `{ id, type, title, summary?, changes }` — validated review changes, including `nutrition-targets` |
| `routines` | actionable | `{ id, type, title, summary?, bundle }` — a validated plan bundle |

## Tools

The loop in `core/agent.js` is at most 6 rounds, then one call that may not use a tool.
OpenAI-compatible adapters speak native tool calling (`invokeChat`). Anthropic, Gemini, Claude,
Codex and the fixture answer `{"tool","args"}` or `{"reply"}` over plain `invoke`. Validation
errors go back to the model as the tool result. Each tool is gated by its consent category;
a withheld category answers "not available" without reading.

## Caps

`caps.chatDaily` (default 200, 0 = unlimited) is counted separately from `perProfileDaily`.
Chat still counts toward `instanceDaily`, because that cap is the instance-wide spend brake.
`status.cap` also reports `chatUsed` / `chatLimit`.

## Deviations from the frontend-facing contract

These extras are additive; the fields the app reads are present.

- Chat `pending` also carries `id` (same as `jobId`, so `resolvePending` / expiry keep working),
  `expiresAt` (14 days, same as every other proposal) and `planHash` (staleness).
- `last` for a finished chat omits `id` / `kind`; the app keys on `jobId`.
- Empty message is `400` rather than a failed job.
