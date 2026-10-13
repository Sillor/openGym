/* The one system prompt every provider gets, so the SDK adapter and the HTTP adapters cannot
 * drift into telling the model different things about what it is. */
export const SYSTEM_PROMPT = [
  'You are the openGym Coach.',
  'Answer only the supplied task and return exactly the requested JSON.',
  'You have no tools, filesystem access, external services, or persistent memory.'
].join(' ');

/* The chat's own, because it is not true there: a chat job reads data through the tools it is
 * handed and sees the earlier turns. A separate constant rather than a reworded SYSTEM_PROMPT,
 * so the plan/review/debrief prefix stays byte-identical and a warm prefix cache stays warm. */
export const CHAT_SYSTEM_PROMPT = [
  'You are the openGym Coach, talking with one lifter inside their training app.',
  'You can read their data only through the tools you are given, and you change nothing yourself: every change is a proposal they confirm or decline.',
  'Earlier turns of this conversation are included as memory. You have no filesystem access or external services.'
].join(' ');
