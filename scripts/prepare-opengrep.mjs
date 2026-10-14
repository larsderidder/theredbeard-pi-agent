import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareSharedRules } from "../extensions/opengrep.ts";

const run = promisify(execFile);

/** Adapt native process results to the shared configuration preparer's process boundary. */
async function exec(command, args, options) {
	try {
		const output = await run(command, args, options);
		return { ...output, code: 0, killed: false };
	} catch (error) {
		if (typeof error.code === "number") {
			return { stdout: error.stdout, stderr: error.stderr, code: error.code, killed: error.killed };
		}
		throw error;
	}
}

if (process.argv.length > 3) {
	console.error("Usage: node scripts/prepare-opengrep.mjs [config-directory]");
	process.exitCode = 2;
} else {
	try {
		const configDirectory = resolve(process.argv[2] || process.env.PI_OPENGREP_CONFIG_DIR || join(homedir(), ".config", "opengrep"));
		const prepared = await prepareSharedRules(configDirectory, exec, { cwd: process.cwd(), timeout: 10_000 });
		if (!prepared.directory) {
			throw new Error("Standalone preparation requires namespace_rule_ids in the shared manifest.");
		}
		console.error(JSON.stringify({ source: prepared.manifest.source, revision: prepared.manifest.revision, ruleFiles: prepared.files.size, rules: prepared.ruleMessages.size }));
		console.log(prepared.directory);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
