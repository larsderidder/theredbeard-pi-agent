/**
 * Timestamp Prompt - Keeps the system prompt date/time fresh on every turn.
 *
 * The system prompt is built once at session start, so `Current date` quickly
 * goes stale in long-running or paused sessions. This extension intercepts
 * every `before_agent_start` event and replaces the `Current date:` line
 * with the actual current date and time, so the agent always has an accurate
 * timestamp regardless of when the session was started.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const now = new Date();

    // Format: "2026-03-26 14:32 UTC" — date + time + timezone, readable at a glance
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);
    const replacement = `Current date: ${date}\nCurrent time: ${time} UTC`;

    // Replace the existing "Current date: ..." line (added by system-prompt.js)
    const updated = event.systemPrompt.replace(/^Current date: .+$/m, replacement);

    // If the line wasn't found (custom prompt or format changed), append it
    if (updated === event.systemPrompt) {
      return { systemPrompt: event.systemPrompt + `\n${replacement}` };
    }

    return { systemPrompt: updated };
  });
}
