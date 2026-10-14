import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const extension = await jiti.import("../extensions/opengrep.ts");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-opengrep-test-"));
const previousConfig = process.env.PI_OPENGREP_CONFIG_DIR;
const previousBinary = process.env.PI_OPENGREP_BIN;
const revision = "1".repeat(40);
const configDirectory = path.join(directory, "config");
const rulesDirectory = path.join(configDirectory, "rules");
const target = path.join(directory, "project $(touch marker); quoted");
let assertions = 0;

/** Register the real tool while substituting only the external process boundary. */
function register(exec) {
	let tool;
	extension.default({
		exec,
		registerTool(registered) {
			assert.equal(registered.name, "opengrep_check");
			tool = registered;
		},
	});
	assert.ok(tool);
	return tool;
}

/** Invoke the tool with scanner output and independently controlled Git state. */
async function check(output, options = {}) {
	const calls = [];
	const tool = register(async (command, args, execOptions) => {
		calls.push({ command, args, options: execOptions });
		if (command === "git") {
			let stdout = revision;
			if (args.includes("status")) {
				stdout = options.dirty ?? "";
			} else if (options.revision) {
				stdout = options.revision;
			}
			return { stdout, stderr: "", code: 0, killed: false };
		}
		if (options.controller) {
			options.controller.abort();
		}
		if (options.onScan) {
			await options.onScan(args, execOptions);
		}
		return output;
	});
	const result = await tool.execute(
		"test", { path: target, ...options.params }, options.signal, undefined, { cwd: options.cwd ?? directory },
	);
	assert.equal(Check(tool.outputSchema, result.structuredContent), true);
	assert.deepEqual(result.details, result.structuredContent);
	return { result, report: result.structuredContent, calls, tool };
}

/** Construct valid output without relying on undocumented scanner metadata. */
function scan(overrides = {}, code = 0) {
	const report = {
		version: "1.30.2",
		results: [],
		errors: [],
		paths: { scanned: [path.join(target, "sample.py")], skipped: [] },
		skipped_rules: [],
		...overrides,
	};
	return { stdout: JSON.stringify(report), stderr: "", code, killed: false };
}

const finding = {
	check_id: "useless-assignment",
	path: path.join(target, "sample.js"),
	start: { line: 2, col: 1 },
	extra: { message: "Value overwritten before use", severity: "INFO", lines: "SOURCE_MUST_NOT_LEAK" },
};

try {
	await fs.mkdir(rulesDirectory, { recursive: true });
	await fs.mkdir(target);
	await fs.writeFile(path.join(rulesDirectory, "quality.yaml"), JSON.stringify({
		rules: [{ id: "useless-assignment", languages: ["javascript"], pattern: "shared($X)", message: "Shared rule", severity: "WARNING" }],
	}));
	const manifest = {
		source: "https://example.test/rules",
		revision,
		opengrep_version: "1.30.2",
		rule_files: ["quality.yaml"],
	};
	await fs.writeFile(path.join(configDirectory, "quality.json"), JSON.stringify(manifest));
	process.env.PI_OPENGREP_CONFIG_DIR = configDirectory;
	process.env.PI_OPENGREP_BIN = process.execPath;

	{
		const { result, report, calls, tool } = await check(scan());
		assert.equal(report.status, "clean");
		assert.equal(result.isError, false);
		assert.equal(tool.annotations.readOnlyHint, true);
		assert.equal(tool.annotations.openWorldHint, false);
		const invocation = calls.find((call) => call.command !== "git");
		assert.equal(invocation.command, "env");
		assert.ok(invocation.args.includes(process.execPath));
		assert.equal(invocation.args.at(-1), target);
		assert.ok(invocation.args.includes("--disable-version-check"));
		assert.ok(invocation.args.includes("--no-autofix"));
		assert.ok(invocation.args.includes(path.join(rulesDirectory, "quality.yaml")));
		assert.equal(invocation.options.timeout, 120_000);
		assert.equal(report.ruleset.revision, revision);
		assert.equal(report.engineVersion, "1.30.2");
		assertions++;
	}

	for (const scenario of ["clean", "invalid-output", "timeout", "cancelled", "spawn-error"]) {
		const controller = new AbortController();
		const inherited = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
		const sentinel = path.join(directory, "keep-outside-scan-tmp");
		await fs.writeFile(sentinel, "Keep this file\n");
		let temporaryDirectory;
		let output = scan();
		if (scenario === "invalid-output") {
			output = { ...output, stdout: "not JSON" };
		} else if (scenario === "timeout" || scenario === "cancelled") {
			output = { ...output, killed: true };
		}
		const { report } = await check(output, {
			signal: controller.signal,
			onScan: async (args) => {
				const assignment = args.find((arg) => arg.startsWith("TMPDIR="));
				assert.ok(assignment, "Scanner must have its own TMPDIR");
				temporaryDirectory = assignment.slice("TMPDIR=".length);
				assert.ok(args.includes(`TMP=${temporaryDirectory}`));
				assert.ok(args.includes(`TEMP=${temporaryDirectory}`));
				assert.equal((await fs.stat(temporaryDirectory)).mode & 0o777, 0o700);
				await fs.writeFile(path.join(temporaryDirectory, "semgrep-leftover.rules"), "rules: []\n");
				await fs.mkdir(path.join(temporaryDirectory, "nested"));
				await fs.writeFile(path.join(temporaryDirectory, "nested", "leftover.json"), "{}");
				await fs.symlink(sentinel, path.join(temporaryDirectory, "outside-link"));
				if (scenario === "cancelled") {
					controller.abort();
				} else if (scenario === "spawn-error") {
					throw new Error("Scanner spawn failed");
				}
			},
		});
		assert.ok(temporaryDirectory);
		assert.equal(await fs.stat(temporaryDirectory).catch(() => null), null, scenario);
		assert.equal(await fs.readFile(sentinel, "utf8"), "Keep this file\n");
		assert.deepEqual({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }, inherited);
		if (scenario === "clean") {
			assert.equal(report.status, "clean");
		} else {
			assert.equal(report.status, "failed");
			if (scenario === "invalid-output") {
				assert.match(report.errors.join(" "), /invalid JSON/);
			} else if (scenario === "timeout") {
				assert.match(report.errors.join(" "), /timed out/);
			} else if (scenario === "cancelled") {
				assert.match(report.errors.join(" "), /cancelled/);
			} else {
				assert.match(report.errors.join(" "), /Scanner spawn failed/);
			}
		}
		await fs.rm(sentinel);
		assertions++;
	}

	{
		const directories = [];
		let release;
		const bothStarted = new Promise((resolve) => {
			release = resolve;
		});
		const onScan = async (args) => {
			const temporaryDirectory = args.find((arg) => arg.startsWith("TMPDIR=")).slice("TMPDIR=".length);
			directories.push(temporaryDirectory);
			await fs.writeFile(path.join(temporaryDirectory, "semgrep-leftover.rules"), "rules: []\n");
			if (directories.length === 2) {
				release();
			}
			await bothStarted;
		};
		const results = await Promise.all([check(scan(), { onScan }), check(scan(), { onScan })]);
		assert.equal(new Set(directories).size, 2);
		for (const temporaryDirectory of directories) {
			assert.equal(await fs.stat(temporaryDirectory).catch(() => null), null);
		}
		assert.ok(results.every(({ report }) => report.status === "clean"));
		assertions++;
	}

	{
		const secondFile = path.join(rulesDirectory, "second.yaml");
		const fixtureFile = path.join(rulesDirectory, "quality.test.yaml");
		const djangoDirectory = path.join(rulesDirectory, "python", "django");
		const original = await fs.readFile(path.join(rulesDirectory, "quality.yaml"), "utf8");
		await fs.writeFile(secondFile, "# Copyright fixture author\n" + original);
		await fs.writeFile(fixtureFile, "rules: [not a valid rule fixture\n");
		await fs.mkdir(djangoDirectory, { recursive: true });
		await fs.writeFile(path.join(djangoDirectory, "unused.yaml"), "rules: [excluded\n");
		await fs.writeFile(path.join(configDirectory, "quality.json"), JSON.stringify({
			...manifest, rule_directories: ["."], namespace_rule_ids: true,
			exclude_rule_paths: ["**/*.test.yaml", "python/django/**"],
		}));
		let generatedDirectory;
		const capturedRules = [];
		const { report } = await check(scan(), {
			onScan: async (args) => {
				generatedDirectory = args[args.indexOf("--config") + 1];
				const stat = await fs.stat(generatedDirectory);
				if (stat.isDirectory()) {
					assert.equal(stat.mode & 0o777, 0o700);
					const files = await fs.readdir(generatedDirectory, { recursive: true });
					for (const file of files.filter((entry) => entry.endsWith(".yaml"))) {
						const contents = await fs.readFile(path.join(generatedDirectory, file), "utf8");
						capturedRules.push(...parseDocument(contents).toJS().rules);
						assert.match(contents, /Modified copy/);
						assert.equal((await fs.stat(path.join(generatedDirectory, file))).mode & 0o777, 0o600);
						if (file === "second.yaml") {
							assert.match(contents, /Copyright fixture author/);
						}
					}
				} else {
					capturedRules.push(...parseDocument(await fs.readFile(generatedDirectory, "utf8")).toJS().rules);
				}
			},
		});
		assert.equal(report.status, "clean", report.errors.join("\n"));
		assert.deepEqual(capturedRules.map((rule) => rule.id).sort(), ["quality.useless-assignment", "second.useless-assignment"]);
		assert.ok(capturedRules.every((rule) => rule.pattern === "shared($X)"));
		assert.equal(await fs.readFile(secondFile, "utf8"), "# Copyright fixture author\n" + original);
		assert.equal(await fs.stat(generatedDirectory).catch(() => null), null);
		await fs.rm(secondFile);
		await fs.rm(fixtureFile);
		await fs.rm(path.join(rulesDirectory, "python"), { recursive: true });
		await fs.writeFile(path.join(configDirectory, "quality.json"), JSON.stringify(manifest));
		assertions++;
	}

	{
		const { report, result } = await check(scan({ results: [finding] }, 1));
		assert.equal(report.status, "findings");
		assert.equal(result.isError, false);
		assert.deepEqual(report.findings[0], {
			rule: finding.check_id, path: finding.path, line: 2, column: 1,
			severity: "INFO", message: "Shared rule",
		});
		assert.doesNotMatch(JSON.stringify(result), /SOURCE_MUST_NOT_LEAK/);
		assertions++;
	}

	{
		const ruleFile = path.join(rulesDirectory, "quality.yaml");
		const original = await fs.readFile(ruleFile, "utf8");
		const rule = JSON.parse(original);
		rule.rules[0].message = "Unsafe value $SECRET";
		try {
			await fs.writeFile(ruleFile, JSON.stringify(rule));
			const interpolated = { ...finding, extra: { ...finding.extra, message: "Unsafe value TEST_ONLY_SENSITIVE_MATCH" } };
			const { report, result } = await check(scan({ results: [interpolated] }, 1));
			assert.equal(report.status, "findings");
			assert.equal(report.findings[0].message, "Unsafe value $SECRET");
			assert.doesNotMatch(JSON.stringify(result), /TEST_ONLY_SENSITIVE_MATCH/);
			const unknown = { ...interpolated, check_id: "unknown-rule" };
			const fallback = await check(scan({ results: [unknown] }, 1));
			assert.equal(fallback.report.findings[0].message, "Rule matched. Inspect the source locally.");
			assert.doesNotMatch(JSON.stringify(fallback.result), /TEST_ONLY_SENSITIVE_MATCH/);
			const diagnostics = await check(scan({ errors: [
				{ code: 3, type: "ParseError", message: "Could not parse TEST_ONLY_SENSITIVE_MATCH" },
				"Raw diagnostic TEST_ONLY_SENSITIVE_MATCH",
			] }));
			assert.equal(diagnostics.report.status, "partial");
			assert.deepEqual(diagnostics.report.errors, [
				"Scanner reported error code 3. Inspect detailed diagnostics locally.",
				"Scanner reported an error. Inspect detailed diagnostics locally.",
			]);
			assert.doesNotMatch(JSON.stringify(diagnostics.result), /TEST_ONLY_SENSITIVE_MATCH/);
			assertions++;
		} finally {
			await fs.writeFile(ruleFile, original);
		}
	}

	for (const stdout of ["", "not JSON", "{}", '{"results":[]}']) {
		const { report, result } = await check({ stdout, stderr: "", code: 0, killed: false });
		assert.equal(report.status, "failed");
		assert.equal(result.isError, true);
		assertions++;
	}

	for (const overrides of [
		{ errors: [{ type: "ParseError", message: "Could not parse sample.py" }] },
		{ paths: { scanned: ["sample.py"], skipped: [{ path: "large.py", reason: "too_big" }] } },
		{ skipped_rules: [{ rule_id: "unavailable-rule" }] },
		{ version: "9.9.9" },
	]) {
		const { report, result } = await check(scan(overrides));
		assert.equal(report.status, "partial");
		assert.equal(result.isError, true);
		assertions++;
	}

	{
		const { report } = await check(scan({ paths: { scanned: [], skipped: [] } }));
		assert.equal(report.status, "not_applicable");
		assertions++;
	}

	{
		const { report, calls } = await check(scan(), { params: { path: undefined } });
		assert.equal(report.target, directory);
		assert.equal(calls.find((call) => call.command !== "git").args.at(-1), directory);
		assertions++;
	}

	{
		process.env.PI_OPENGREP_BIN = path.join(directory, "missing-binary");
		const { report, calls } = await check(scan());
		assert.equal(report.status, "failed");
		assert.equal(calls.length, 0);
		process.env.PI_OPENGREP_BIN = process.execPath;
		assertions++;
	}

	for (const code of [2, -1]) {
		const { report } = await check(scan({}, code));
		assert.equal(report.status, "failed");
		assertions++;
	}

	for (const overrides of [
		{ paths: { scanned: ["sample.py"] } },
		{ skipped_rules: undefined },
		{ results: [finding], paths: { scanned: [], skipped: [] } },
	]) {
		const { report } = await check(scan(overrides));
		assert.equal(report.status, "failed");
		assertions++;
	}

	{
		const { report } = await check({ ...scan(), killed: true });
		assert.equal(report.status, "failed");
		assert.match(report.errors.join(" "), /timed out/i);
		assertions++;
	}

	{
		const controller = new AbortController();
		controller.abort();
		const { report, calls } = await check(scan(), { signal: controller.signal });
		assert.equal(report.status, "failed");
		assert.equal(calls.length, 0);
		assert.match(report.errors.join(" "), /cancel/i);
		assertions++;
	}

	{
		const controller = new AbortController();
		const { report, calls } = await check({ ...scan(), killed: true }, {
			controller, signal: controller.signal, params: { timeout: 3 },
		});
		assert.equal(report.status, "failed");
		assert.match(report.errors.join(" "), /cancel/i);
		const invocation = calls.find((call) => call.command !== "git");
		assert.equal(invocation.options.signal, controller.signal);
		assert.equal(invocation.options.timeout, 3_000);
		assertions++;
	}

	for (const options of [{ dirty: " M quality.yaml" }, { revision: "2".repeat(40) }]) {
		const { report, calls } = await check(scan(), options);
		assert.equal(report.status, "failed");
		assert.equal(calls.filter((call) => call.command !== "git").length, 0);
		assertions++;
	}

	{
		const results = Array.from({ length: 500 }, () => ({
			...finding, extra: { ...finding.extra, message: "Large finding ".repeat(30) },
		}));
		const { report, result } = await check(scan({ results }, 1));
		assert.equal(report.status, "findings");
		assert.equal(report.truncated, true);
		assert.ok(report.fullOutputPath);
		const saved = JSON.parse(await fs.readFile(report.fullOutputPath, "utf8"));
		assert.equal(saved.findings.length, results.length);
		assert.match(result.content[0].text, /truncated/i);
		assert.ok(Buffer.byteLength(result.content[0].text) < 55_000);
		await fs.rm(path.dirname(report.fullOutputPath), { recursive: true, force: true });
		assertions++;
	}

	const projectRule = {
		rules: [{ id: "project.no-debug", languages: ["javascript"], pattern: "console.log($X)", message: "Remove debugging output", severity: "WARNING" }],
	};
	const localDirectory = path.join(target, ".opengrep");
	const localFile = path.join(localDirectory, "checks", "quality.yml");
	const localContent = JSON.stringify(projectRule);
	await fs.mkdir(path.dirname(localFile), { recursive: true });
	await fs.writeFile(localFile, localContent);
	await fs.writeFile(path.join(localDirectory, "README.md"), "Not a rule file\n");

	{
		const { report, calls } = await check(scan());
		assert.equal(report.status, "clean");
		assert.equal(report.projectRoot, target);
		assert.deepEqual(report.projectRules, [{
			path: localFile, sha256: createHash("sha256").update(localContent).digest("hex"),
		}]);
		const invocation = calls.find((call) => call.command !== "git");
		assert.ok(invocation.args.includes(localFile));
		assert.ok(invocation.args.includes(path.join(rulesDirectory, "quality.yaml")));
		assertions++;
	}

	{
		await fs.writeFile(path.join(target, ".git"), "gitdir: /not-used-by-unit-tests\n");
		const file = path.join(target, "src", "app.js");
		await fs.mkdir(path.dirname(file));
		await fs.writeFile(file, "shared(value);\n");
		const { report } = await check(scan(), { params: { path: file } });
		assert.equal(report.projectRoot, target);
		assert.equal(report.projectRules[0].path, localFile);
		const nested = path.join(target, "nested-project");
		await fs.mkdir(nested);
		await fs.mkdir(path.join(nested, ".git"));
		const nestedScan = await check(scan(), { params: { path: nested } });
		assert.equal(nestedScan.report.status, "clean");
		assert.equal(nestedScan.report.projectRoot, nested);
		assert.deepEqual(nestedScan.report.projectRules, []);
		await fs.rm(path.join(target, ".git"));
		await fs.rm(path.join(target, "src"), { recursive: true });
		await fs.rm(nested, { recursive: true });
		assertions++;
	}

	{
		const customFile = path.join(directory, "custom rules.yaml");
		await fs.writeFile(customFile, JSON.stringify({
			rules: [{ ...projectRule.rules[0], id: "project.custom" }],
		}));
		const { report, calls } = await check(scan(), {
			params: { projectRules: [path.basename(customFile), localDirectory, localFile] },
		});
		assert.equal(report.status, "clean");
		assert.deepEqual(report.projectRules.map((file) => file.path).sort(), [localFile, customFile].sort());
		const invocation = calls.find((call) => call.command !== "git");
		assert.equal(invocation.args.filter((arg) => arg === localFile).length, 1);
		assert.ok(invocation.args.includes(customFile));
		await fs.rm(customFile);
		assertions++;
	}

	for (const input of ["https://example.test/rules.yaml", "git+https://example.test/rules", "p/python", "missing.yaml"]) {
		const { report, calls } = await check(scan(), { params: { projectRules: [input] } });
		assert.equal(report.status, "failed");
		assert.equal(calls.filter((call) => call.command !== "git").length, 0);
		assertions++;
	}

	for (const content of [
		"rules: [broken YAML",
		JSON.stringify({ rules: [{ ...projectRule.rules[0], id: "useless-assignment" }] }),
		JSON.stringify({ rules: [projectRule.rules[0], projectRule.rules[0]] }),
	]) {
		await fs.writeFile(localFile, content);
		const { report, calls } = await check(scan());
		assert.equal(report.status, "failed");
		assert.equal(calls.filter((call) => call.command !== "git").length, 0);
		assertions++;
	}
	await fs.writeFile(localFile, localContent);

	{
		const link = path.join(localDirectory, "linked.yaml");
		await fs.symlink(path.join(rulesDirectory, "quality.yaml"), link);
		const { report } = await check(scan());
		assert.equal(report.status, "failed");
		await fs.rm(link);
		assertions++;
	}

	{
		const { report } = await check(scan(), {
			onScan: () => fs.writeFile(localFile, localContent + "\n"),
		});
		assert.equal(report.status, "failed");
		assert.match(report.errors.join(" "), /changed during the scan/i);
		await fs.writeFile(localFile, localContent);
		assertions++;
	}

	{
		const empty = path.join(directory, "empty-rules");
		await fs.mkdir(empty);
		const { report } = await check(scan(), { params: { projectRules: [empty] } });
		assert.equal(report.status, "failed");
		assert.match(report.errors.join(" "), /no YAML rule files/i);
		assertions++;
	}

	{
		const { report } = await check(scan(), {
			params: { projectRules: [path.join(localDirectory, "README.md")] },
		});
		assert.equal(report.status, "failed");
		assertions++;
	}

	{
		await fs.writeFile(localFile, "#".repeat(5 * 1024 * 1024 + 1));
		const { report } = await check(scan());
		assert.equal(report.status, "failed");
		assert.match(report.errors.join(" "), /limit/i);
		await fs.writeFile(localFile, localContent);
		assertions++;
	}

	await fs.rm(localDirectory, { recursive: true });

	if (process.argv.includes("--live")) {
		delete process.env.PI_OPENGREP_CONFIG_DIR;
		delete process.env.PI_OPENGREP_BIN;
		const { discoverAndLoadExtensions } = await import(
			process.env.PI_OPENGREP_TEST_SDK ?? "@earendil-works/pi-coding-agent"
		);
		const loaded = await discoverAndLoadExtensions(
			[path.resolve(import.meta.dirname, "../extensions/opengrep.ts")],
			directory, path.join(directory, "agent"),
		);
		assert.deepEqual(loaded.errors, []);
		const tool = loaded.extensions[0].tools.get("opengrep_check").definition;
		assert.ok(tool.outputSchema);

		const sdkPath = process.env.PI_OPENGREP_TEST_SDK ?? "@earendil-works/pi-coding-agent";
		const { execCommand } = await import(new URL("./core/exec.js", import.meta.resolve(sdkPath)));
		const cleanupTarget = path.join(directory, "cleanup.js");
		await fs.writeFile(cleanupTarget, "const value = 1;\nconsole.log(value);\n");
		for (const scenario of ["clean", "timeout", "cancelled"]) {
			const controller = new AbortController();
			let temporaryDirectory;
			let cancellation;
			let leftoverRules = [];
			const observed = register(async (command, args, options) => {
				if (command === "env") {
					temporaryDirectory = args.find((arg) => arg.startsWith("TMPDIR=")).slice("TMPDIR=".length);
					if (scenario === "cancelled") {
						cancellation = setTimeout(() => controller.abort(), 2_000);
					}
				}
				try {
					const execution = await execCommand(command, args, options.cwd, options);
					if (command === "env") {
						leftoverRules = (await fs.readdir(temporaryDirectory)).filter((name) => /^semgrep-.*\.rules$/.test(name));
					}
					return execution;
				} finally {
					clearTimeout(cancellation);
				}
			});
			const params = { path: cleanupTarget };
			if (scenario === "timeout") {
				params.timeout = 2;
			}
			const result = await observed.execute(scenario, params, controller.signal, undefined, { cwd: directory });
			assert.ok(temporaryDirectory);
			assert.equal(await fs.stat(temporaryDirectory).catch(() => null), null, scenario);
			if (scenario === "clean") {
				assert.equal(result.details.status, "clean", result.content[0].text);
				assert.ok(leftoverRules.length > 0, "Exercise cleanup of actual engine-generated rule copies");
			} else {
				assert.equal(result.details.status, "failed", result.content[0].text);
				if (scenario === "timeout") {
					assert.match(result.details.errors.join(" "), /timed out/);
				} else {
					assert.match(result.details.errors.join(" "), /cancelled/);
				}
			}
			assertions++;
		}
		for (const name of ["first", "second"]) {
			const folder = path.join(target, name);
			await fs.mkdir(folder);
			await fs.writeFile(path.join(folder, "same.js"), "let value = 1;\nvalue = 2;\nconsole.log(value);\n");
		}
		const result = await tool.execute("live", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(result.details.status, "findings", result.content[0].text);
		assert.equal(result.details.scannedFiles.length, 2);
		assert.equal(result.details.findings.length, 2);
		const sharedAssignmentId = result.details.findings.find((issue) => issue.rule.endsWith("useless-assignment"))?.rule;
		assert.ok(sharedAssignmentId);
		assert.equal(new Set(result.details.findings.map((issue) => issue.path)).size, 2);
		assert.equal(await fs.stat(path.join(directory, "marker")).catch(() => null), null);
		assertions++;

		await fs.writeFile(path.join(target, "broken.py"), "def unfinished(\n");
		const partial = await tool.execute("partial", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(partial.details.status, "partial", partial.content[0].text);
		assert.ok(partial.details.errors.length);
		assertions++;
		await fs.rm(path.join(target, "broken.py"));

		for (const name of ["first", "second"]) {
			await fs.writeFile(path.join(target, name, "same.js"), "const value = 1;\nconsole.log(value);\n");
		}
		const clean = await tool.execute("clean", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(clean.details.status, "clean", clean.content[0].text);
		assert.equal(clean.details.findings.length, 0);
		assertions++;

		const emptyDirectory = path.join(directory, "empty");
		await fs.mkdir(emptyDirectory);
		const noFiles = await tool.execute("no-files", { path: emptyDirectory }, undefined, undefined, { cwd: directory });
		assert.equal(noFiles.details.status, "not_applicable", noFiles.content[0].text);
		assertions++;

		await fs.mkdir(localDirectory);
		const liveRuleFile = path.join(localDirectory, "quality.yaml");
		await fs.writeFile(liveRuleFile, localContent);
		await fs.writeFile(path.join(target, "first", "same.js"), "let value = 1;\nvalue = 2;\nconsole.log(value);\n");
		const combined = await tool.execute("combined", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(combined.details.status, "findings", combined.content[0].text);
		assert.ok(combined.details.findings.some((issue) => issue.rule === sharedAssignmentId));
		assert.ok(combined.details.findings.some((issue) => issue.rule === "project.no-debug"));
		assert.deepEqual(combined.details.projectRules, [{
			path: liveRuleFile, sha256: createHash("sha256").update(localContent).digest("hex"),
		}]);
		assert.equal(await fs.readFile(liveRuleFile, "utf8"), localContent);
		assertions++;

		await fs.writeFile(liveRuleFile, "rules: [invalid YAML\n");
		const invalid = await tool.execute("invalid", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(invalid.details.status, "failed", invalid.content[0].text);
		assertions++;

		await fs.writeFile(liveRuleFile, JSON.stringify({
			rules: [{ ...projectRule.rules[0], pattern: "const = ;" }],
		}));
		const invalidPattern = await tool.execute("invalid-pattern", { path: target }, undefined, undefined, { cwd: directory });
		assert.notEqual(invalidPattern.details.status, "clean", invalidPattern.content[0].text);
		assert.ok(invalidPattern.details.errors.length);
		assertions++;

		await fs.writeFile(liveRuleFile, JSON.stringify({
			rules: [{ ...projectRule.rules[0], id: sharedAssignmentId }],
		}));
		const collision = await tool.execute("collision", { path: target }, undefined, undefined, { cwd: directory });
		assert.equal(collision.details.status, "failed", collision.content[0].text);
		assert.match(collision.details.errors.join(" "), /duplicate.*rule/i);

		await fs.rm(localDirectory, { recursive: true });
		const securityTarget = path.join(directory, "security");
		await fs.mkdir(securityTarget);
		const pythonFile = path.join(securityTarget, "request.py");
		const javascriptFile = path.join(securityTarget, "browser.js");
		await fs.writeFile(pythonFile, 'import requests\n\nrequests.get("https://example.invalid", timeout=10, verify=False)\n');
		await fs.writeFile(javascriptFile, "document.write(window.location.hash);\n");
		const unsafe = await tool.execute("security", { path: securityTarget }, undefined, undefined, { cwd: directory });
		assert.equal(unsafe.details.status, "findings", unsafe.content[0].text);
		assert.ok(unsafe.details.findings.some((issue) => issue.rule === "python.requests.security.disabled-cert-validation.disabled-cert-validation"));
		assert.ok(unsafe.details.findings.some((issue) => issue.rule === "javascript.browser.security.insecure-document-method.insecure-document-method"));
		assert.match(await fs.readFile(pythonFile, "utf8"), /verify=False/);
		assertions++;

		const run = promisify(execFile);
		const nativeTemporaryDirectory = path.join(directory, "native-tmp");
		await fs.mkdir(nativeTemporaryDirectory);
		const nativeOptions = {
			cwd: directory,
			env: { ...process.env, TMPDIR: nativeTemporaryDirectory, TMP: nativeTemporaryDirectory, TEMP: nativeTemporaryDirectory },
		};
		const prepared = await run(process.execPath, [path.resolve(import.meta.dirname, "prepare-opengrep.mjs")], nativeOptions);
		const preparedDirectory = prepared.stdout.trim();
		const selection = JSON.parse(prepared.stderr.trim());
		assert.ok(selection.ruleFiles > 10);
		assert.ok(selection.rules > selection.ruleFiles);
		try {
			const args = ["scan", "--json", "--strict", "--error", "--disable-version-check", "--no-rewrite-rule-ids", "--no-autofix", "--config", preparedDirectory, "--", securityTarget];
			const upstream = path.join(os.homedir(), ".config", "opengrep", "rules");
			assert.equal(await fs.readFile(path.join(preparedDirectory, "LICENSE"), "utf8"), await fs.readFile(path.join(upstream, "LICENSE"), "utf8"));
			const files = (await fs.readdir(preparedDirectory, { recursive: true })).filter((file) => /\.ya?ml$/.test(file));
			assert.equal(files.length, selection.ruleFiles);
			assert.ok(files.every((file) => !file.split(path.sep).includes("django") && !file.includes(".test.")));
			let rulesChecked = 0;
			for (const file of files) {
				const original = parseDocument(await fs.readFile(path.join(upstream, file), "utf8")).toJS().rules;
				const copied = parseDocument(await fs.readFile(path.join(preparedDirectory, file), "utf8")).toJS().rules;
				assert.equal(copied.length, original.length);
				for (const [index, rule] of copied.entries()) {
					const { id, ...body } = rule;
					const { id: originalId, ...originalBody } = original[index];
					assert.ok(id.endsWith(`.${originalId}`));
					assert.deepEqual(body, originalBody, file);
					rulesChecked++;
				}
			}
			assert.equal(rulesChecked, selection.rules);
			assertions++;
			const native = await run(path.join(os.homedir(), ".local", "bin", "opengrep"), args, nativeOptions).catch((error) => {
				assert.equal(error.code, 1);
				return error;
			});
			const output = JSON.parse(native.stdout);
			assert.equal(output.errors.length, 0);
			assert.equal(output.skipped_rules.length, 0);
			assert.ok(output.results.some((issue) => issue.check_id === "python.requests.security.disabled-cert-validation.disabled-cert-validation"));
			assert.ok(output.results.some((issue) => issue.check_id === "javascript.browser.security.insecure-document-method.insecure-document-method"));
			assertions++;
		} finally {
			await fs.rm(preparedDirectory, { recursive: true, force: true });
			await fs.rm(nativeTemporaryDirectory, { recursive: true, force: true });
		}
		await fs.writeFile(pythonFile, 'import requests\n\nresponse = requests.get("https://example.invalid", timeout=10, verify=True)\nresponse.raise_for_status()\n');
		await fs.writeFile(javascriptFile, "document.body.textContent = window.location.hash;\n");
		const safe = await tool.execute("security-clean", { path: securityTarget }, undefined, undefined, { cwd: directory });
		assert.equal(safe.details.status, "clean", safe.content[0].text);
		assert.equal(safe.details.findings.length, 0);
		assertions++;
		assertions++;
	}

	console.log(JSON.stringify({ suite: "opengrep", passed: assertions, live: process.argv.includes("--live") }));
} finally {
	if (previousConfig === undefined) {
		delete process.env.PI_OPENGREP_CONFIG_DIR;
	} else {
		process.env.PI_OPENGREP_CONFIG_DIR = previousConfig;
	}
	if (previousBinary === undefined) {
		delete process.env.PI_OPENGREP_BIN;
	} else {
		process.env.PI_OPENGREP_BIN = previousBinary;
	}
	await fs.rm(directory, { recursive: true, force: true });
}
