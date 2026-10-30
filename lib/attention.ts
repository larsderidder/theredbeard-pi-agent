import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const ATTENTION_ENTRY = "pi-attention";
export const AttentionId = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" });
export const AttentionText = Type.String({ minLength: 1, maxLength: 1000 });

const AlertSchema = Type.Object({
	id: AttentionId,
	title: Type.String({ minLength: 1, maxLength: 120 }),
	detail: AttentionText,
	acknowledged: Type.Boolean(),
	notified: Type.Boolean(),
});
const AlertsSchema = Type.Array(AlertSchema);

export type AttentionAlert = Static<typeof AlertSchema>;

/** Attention tracks real issues across the whole session, not alternative branches. */
export function readAttentionAlerts(entries: readonly SessionEntry[]): AttentionAlert[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === ATTENTION_ENTRY && Check(AlertsSchema, entry.data)) {
			return entry.data.map((alert) => ({ ...alert }));
		}
	}
	return [];
}

/** Strip terminal control sequences before displaying model-supplied text. */
export function cleanNotificationText(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
