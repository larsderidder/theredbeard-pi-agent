import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const memoryModule = await jiti.import("../extensions/memory.ts");
const { memoryTestApi } = memoryModule;

const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-queue-test-"));
const memoryPath = path.join(temporaryDir, "MEMORY.md");

try {
	await Promise.all([
		memoryTestApi.appendFact(memoryPath, "First concurrent fact"),
		memoryTestApi.appendFact(memoryPath, "Second concurrent fact"),
	]);
	const content = await fs.readFile(memoryPath, "utf8");
	assert.match(content, /First concurrent fact/);
	assert.match(content, /Second concurrent fact/);
} finally {
	await fs.rm(temporaryDir, { recursive: true, force: true });
}

console.log("file mutation queue tests passed");
