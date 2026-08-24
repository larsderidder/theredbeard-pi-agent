#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runLive = process.argv.includes("--live");

function firstExisting(paths) {
  const found = paths.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Search extension not found. Set PI_SEARCH_EXTENSION to the extension path.`);
  }
  return found;
}

const SEARCH_EXTENSION = process.env.PI_SEARCH_EXTENSION
  ? resolve(process.env.PI_SEARCH_EXTENSION)
  : firstExisting([
      resolve(repoRoot, "extensions/search.ts"),
      resolve(homedir(), ".pi/agent/extensions/search.ts"),
    ]);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

async function loadTools() {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-security-"));
  const nodeModules = join(dir, "node_modules");
  await mkdir(join(nodeModules, "@sinclair"), { recursive: true });
  await mkdir(join(nodeModules, "@earendil-works"), { recursive: true });
  await symlink(join(repoRoot, "node_modules", "typebox"), join(nodeModules, "@sinclair", "typebox"), "dir");
  await symlink(
    join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    join(nodeModules, "@earendil-works", "pi-coding-agent"),
    "dir",
  );
  const outFile = join(dir, "search-extension.mjs");
  run("bun", [
    "build",
    SEARCH_EXTENSION,
    "--outfile",
    outFile,
    "--target=node",
    "--external",
    "@sinclair/typebox",
    "--external",
    "@earendil-works/pi-coding-agent",
  ]);

  const tools = new Map();
  const mod = await import(pathToFileURL(outFile).href);
  mod.default({ registerTool(definition) { tools.set(definition.name, definition); } });

  return { tools, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function expectReject(tool, params, expected) {
  try {
    await tool.execute("test", params);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes(expected)) {
      throw new Error(`Expected rejection containing ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
    }
    console.log(`ok reject: ${params.url} -> ${message}`);
    return;
  }
  throw new Error(`Expected rejection for ${params.url}`);
}

async function main() {
  const { tools, cleanup } = await loadTools();
  try {
    const extract = tools.get("argus_extract");
    const recover = tools.get("argus_recover_url");
    if (!extract || !recover) {
      throw new Error("Expected argus_extract and argus_recover_url tools to be registered");
    }

    await expectReject(extract, { url: "http://example.com", max_chars: 1000 }, "HTTPS URLs only");
    await expectReject(extract, { url: "file:///etc/passwd", max_chars: 1000 }, "HTTPS URLs only");
    await expectReject(extract, { url: "https://localhost/", max_chars: 1000 }, "internal hostname");
    await expectReject(extract, { url: "https://metadata.google.internal/", max_chars: 1000 }, "internal hostname");
    await expectReject(extract, { url: "https://127.0.0.1/", max_chars: 1000 }, "non-public IP address");
    await expectReject(extract, { url: "https://[::1]/", max_chars: 1000 }, "non-public IP address");
    await expectReject(extract, { url: "https://10.0.0.1/", max_chars: 1000 }, "non-public IP address");
    await expectReject(extract, { url: "https://172.16.0.1/", max_chars: 1000 }, "non-public IP address");
    await expectReject(extract, { url: "https://192.168.1.1/", max_chars: 1000 }, "non-public IP address");
    await expectReject(extract, { url: "https://169.254.169.254/latest/meta-data/", max_chars: 1000 }, "internal hostname");
    await expectReject(recover, { url: "http://example.com", count: 3 }, "HTTPS URLs only");

    if (runLive) {
      const result = await extract.execute("test", { url: "https://example.com", max_chars: 1000 });
      const text = result.content?.[0]?.text ?? "";
      if (!text.includes("untrusted external data")) {
        throw new Error("Live extraction did not include the untrusted-content marker");
      }
      console.log("ok live: https://example.com includes untrusted-content marker");
    }
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
