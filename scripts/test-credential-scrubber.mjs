import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const scrubberModule = await jiti.import("../extensions/credential-scrubber.ts");
const { credentialScrubberTestApi } = scrubberModule;

const credential = "super-secret-value";
const signature = JSON.stringify({
	id: "reasoning-item",
	type: "reasoning",
	encrypted_content: `opaque-${credential}-ciphertext`,
});
const header = { type: "session", version: 3, id: "session-id", cwd: "/tmp/project" };
const message = {
	type: "message",
	id: "message-id",
	parentId: null,
	message: {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Provider reasoning summary",
				thinkingSignature: signature,
			},
			{
				type: "thinking",
				thinking: `Connected with ${credential}`,
				thinkingSignature: JSON.stringify({
					id: "secret-reasoning-item",
					type: "reasoning",
					encrypted_content: "opaque-ciphertext",
				}),
			},
			{
				type: "text",
				text: "Signed provider text",
				textSignature: `opaque-${credential}-text-signature`,
			},
			{
				type: "text",
				text: `Signed text containing ${credential}`,
				textSignature: "opaque-text-signature",
			},
			{ type: "text", text: `Credential: ${credential}` },
		],
	},
};
const opaqueEntry = {
	type: "custom",
	id: "opaque-id",
	parentId: "message-id",
	encrypted_content: `another-${credential}-payload`,
};
const input = [JSON.stringify(header), JSON.stringify(message), JSON.stringify(opaqueEntry), ""].join("\n");

const result = credentialScrubberTestApi.scrubSessionJsonl(input, credential);
const outputLines = result.content.trimEnd().split("\n").map((line) => JSON.parse(line));
const outputMessage = outputLines[1];
const outputOpaqueEntry = outputLines[2];

assert.equal(result.occurrences, 3);
assert.equal(outputMessage.message.content.length, 3);
assert.equal(outputMessage.message.content[0].thinking, "Provider reasoning summary");
assert.equal(outputMessage.message.content[0].thinkingSignature, signature);
assert.equal(outputMessage.message.content[1].text, "Signed provider text");
assert.equal(outputMessage.message.content[1].textSignature, `opaque-${credential}-text-signature`);
assert.equal(outputMessage.message.content[2].text, "Credential: [REDACTED]");
assert.equal(outputOpaqueEntry.encrypted_content, opaqueEntry.encrypted_content);
assert.equal(result.content.endsWith("\n"), true);

assert.throws(
	() => credentialScrubberTestApi.scrubSessionJsonl(input, "postgres"),
	/at least 12 characters/,
);
assert.throws(
	() => credentialScrubberTestApi.scrubSessionJsonl(`${JSON.stringify(header)}\nnot-json\n`, credential),
	/line 2 is not valid JSON/,
);

const signedToolCallInput = `${JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tool-call-id",
				name: "example",
				arguments: { token: credential },
				thoughtSignature: "opaque-tool-signature",
			},
		],
	},
})}\n`;
assert.throws(
	() => credentialScrubberTestApi.scrubSessionJsonl(signedToolCallInput, credential),
	/A signed tool call contains the credential/,
);

const repeatedSecret = Array.from({ length: 101 }, () => credential).join(" ");
const repeatedInput = `${JSON.stringify({ type: "message", message: { role: "user", content: repeatedSecret } })}\n`;
assert.throws(
	() => credentialScrubberTestApi.scrubSessionJsonl(repeatedInput, credential),
	/more than 100 plaintext occurrences/,
);

console.log("credential scrubber tests passed");
