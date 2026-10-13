/* The data categories the consent screen names (FR-09/10).
 *
 * Its own tiny module so a screen that only needs to *say* what would leave — the mobile setup
 * screen, before anything AI-related has been loaded — can import the names without pulling
 * the payload builder and the exercise catalogue behind it. payload.js re-exports it, and
 * builds from it, so the screen cannot drift from the payload. */
export const DATA_CATEGORIES = Object.freeze([
  'plan',        // routines, exercises, sets/reps, schedule, progression settings
  'training',    // logged sets, targets, effort ratings, durations, PRs, session notes; the last few weeks, further back on demand
  'bodyweight',  // weigh-ins in the window and your goal weight
  'nutrition',   // daily totals and targets, meal-level diary entries when a question needs them, food preferences — not photos
  'profile',     // the intake answers you gave the Coach, including any limitations
  'prefs'        // unit, language, effort scale
]);
