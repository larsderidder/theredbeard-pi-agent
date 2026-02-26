/**
 * DateTime Tool - Returns the current date and time with timezone info.
 * Useful for avoiding date/time confusion in long sessions.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_current_datetime",
		label: "Get Current DateTime",
		description:
			"Returns the current date, time, and timezone. Call this whenever you are unsure about the current date or time.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const now = new Date();

			const iso = now.toISOString();
			const local = now.toLocaleString("en-US", {
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				timeZoneName: "long",
			});

			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
			const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, "0");
			const offsetStr = `UTC${offsetSign}${offsetHours}:${offsetMinutes}`;

			const text = `Current date and time:\n- ISO 8601: ${iso}\n- Local: ${local}\n- UTC offset: ${offsetStr}`;

			return {
				content: [{ type: "text", text }],
				details: {
					iso,
					local,
					utcOffset: offsetStr,
					timestamp: now.getTime(),
				},
			};
		},
	});
}
