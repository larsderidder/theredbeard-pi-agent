/**
 * kubectl extension
 *
 * Scoped Kubernetes access for agents. The context parameter is required on
 * every call and the tool passes --context explicitly so kubectl never uses the
 * local current-context default.
 *
 * Read operations run without confirmation. Mutating, destructive, interactive,
 * or sensitive operations require confirmation. The riskiest operations also
 * require allowUnsafe or allowSensitive to be set by the caller, so accidental
 * tool calls fail closed before they reach the confirmation UI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createApprovalGate } from "../lib/tool-permissions.ts";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function truncateTail(content: string, options: { maxLines?: number; maxBytes?: number } = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, outputLines: totalLines, totalLines };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i -= 1) {
    const line = lines[i];
    const bytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
    if (outputBytes + bytes > maxBytes) break;
    outputLines.unshift(line);
    outputBytes += bytes;
  }

  return {
    content: outputLines.join("\n"),
    truncated: true,
    outputLines: outputLines.length,
    totalLines,
  };
}

const AUDIT_LOG = path.join(os.homedir(), ".pi", "kubectl-audit.log");
const POLICY_PATH = path.join(os.homedir(), ".pi", "agent", "kubectl-policy.json");

const READ_ONLY_VERBS = new Set([
  "api-resources",
  "api-versions",
  "auth",
  "cluster-info",
  "describe",
  "diff",
  "events",
  "explain",
  "get",
  "logs",
  "top",
  "version",
  "wait",
]);

const CONFIRM_VERBS = new Set([
  "annotate",
  "apply",
  "autoscale",
  "certificate",
  "cordon",
  "create",
  "delete",
  "drain",
  "edit",
  "expose",
  "label",
  "patch",
  "replace",
  "rollout",
  "scale",
  "set",
  "taint",
  "uncordon",
]);

const UNSAFE_VERBS = new Set(["attach", "cp", "debug", "exec", "port-forward", "proxy"]);
const ALLOWED_VERBS = new Set([...READ_ONLY_VERBS, ...CONFIRM_VERBS, ...UNSAFE_VERBS]);
const ROLLOUT_READ_ONLY_SUBCOMMANDS = new Set(["history", "status"]);
const ROLLOUT_CONFIRM_SUBCOMMANDS = new Set(["pause", "restart", "resume", "undo"]);
const AUTH_ALLOWED_SUBCOMMANDS = new Set(["can-i", "whoami"]);
const SECRET_RESOURCES = new Set(["secret", "secrets"]);
const RESOURCE_ALIASES = new Map([
  ["cm", "configmaps"],
  ["configmap", "configmaps"],
  ["deploy", "deployments"],
  ["deployment", "deployments"],
  ["ds", "daemonsets"],
  ["ing", "ingresses"],
  ["ingress", "ingresses"],
  ["job", "jobs"],
  ["ns", "namespaces"],
  ["namespace", "namespaces"],
  ["no", "nodes"],
  ["node", "nodes"],
  ["po", "pods"],
  ["pod", "pods"],
  ["pv", "persistentvolumes"],
  ["pvc", "persistentvolumeclaims"],
  ["sa", "serviceaccounts"],
  ["secret", "secrets"],
  ["svc", "services"],
  ["service", "services"],
  ["sts", "statefulsets"],
]);
const UNSAFE_DELETE_RESOURCES = new Set([
  "clusterrole",
  "clusterrolebinding",
  "crd",
  "crds",
  "customresourcedefinition",
  "customresourcedefinitions",
  "namespace",
  "namespaces",
  "node",
  "nodes",
  "persistentvolume",
  "persistentvolumes",
  "pv",
  "storageclass",
  "storageclasses",
]);

const FLAGS_WITH_VALUE = new Set([
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--container",
  "--context",
  "--field-manager",
  "--field-selector",
  "--filename",
  "--force-conflicts",
  "--grace-period",
  "--image",
  "--kubeconfig",
  "--namespace",
  "--output",
  "--patch",
  "--request-timeout",
  "--replicas",
  "--selector",
  "--server",
  "--since",
  "--sort-by",
  "--tail",
  "--timeout",
  "--token",
  "--type",
  "--user",
  "-c",
  "-f",
  "-l",
  "-n",
  "-o",
  "-p",
]);

const BLOCKED_SCOPE_FLAGS = new Set([
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--insecure-skip-tls-verify",
  "--kubeconfig",
  "--server",
  "--token",
  "--user",
]);

const BLOCKED_RAW_API_FLAGS = new Set(["--raw"]);

type Risk = "read" | "confirm" | "unsafe" | "sensitive";

type ResourceRule = {
  resource: string;
  verbs?: string[];
  contexts?: string[];
  message?: string;
  requireUnsafe?: boolean;
  requireSensitive?: boolean;
  deny?: boolean;
};

type ConfirmationRule = {
  verb?: string;
  subcommand?: string;
  resource?: string;
  contexts?: string[];
  namespaces?: string[];
  message?: string;
  requireUnsafe?: boolean;
  requireSensitive?: boolean;
};

type KubectlPolicy = {
  auditLog?: string;
  blockRawKubectlInBash?: boolean;
  maskSensitiveOutput?: boolean;
  deniedResources?: ResourceRule[];
  confirmationRules?: ConfirmationRule[];
};

type Policy = {
  risk: Risk;
  reasons: string[];
  requiresConfirmation: boolean;
  requiresUnsafe: boolean;
  requiresSensitive: boolean;
  denied: boolean;
  denyReason?: string;
};

type LoadedPolicy = {
  config: Required<KubectlPolicy>;
  error?: string;
};


const DEFAULT_POLICY: Required<KubectlPolicy> = {
  auditLog: AUDIT_LOG,
  blockRawKubectlInBash: true,
  maskSensitiveOutput: true,
  deniedResources: [
    {
      resource: "secrets",
      requireSensitive: true,
      message: "secret resources may expose credentials or tokens",
    },
  ],
  confirmationRules: [
    { verb: "delete", message: "delete mutates or removes resources" },
    { verb: "patch", message: "patch mutates resources" },
    { verb: "replace", message: "replace mutates resources" },
    { verb: "exec", requireUnsafe: true, message: "exec runs code inside a container" },
    { verb: "cp", requireUnsafe: true, message: "cp can copy data to or from a container" },
    { verb: "port-forward", requireUnsafe: true, message: "port-forward opens network access to a workload" },
    { verb: "debug", requireUnsafe: true, message: "debug can start privileged diagnostic containers" },
  ],
};

function loadPolicy(): LoadedPolicy {
  try {
    if (!fs.existsSync(POLICY_PATH)) return { config: DEFAULT_POLICY };
    const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")) as KubectlPolicy;

    if (parsed.auditLog !== undefined && typeof parsed.auditLog !== "string") throw new Error("auditLog must be a string");
    if (parsed.blockRawKubectlInBash !== undefined && typeof parsed.blockRawKubectlInBash !== "boolean") {
      throw new Error("blockRawKubectlInBash must be a boolean");
    }
    if (parsed.maskSensitiveOutput !== undefined && typeof parsed.maskSensitiveOutput !== "boolean") {
      throw new Error("maskSensitiveOutput must be a boolean");
    }
    if (parsed.deniedResources !== undefined && !Array.isArray(parsed.deniedResources)) throw new Error("deniedResources must be an array");
    if (parsed.confirmationRules !== undefined && !Array.isArray(parsed.confirmationRules)) throw new Error("confirmationRules must be an array");

    return {
      config: {
        auditLog: parsed.auditLog ?? DEFAULT_POLICY.auditLog,
        blockRawKubectlInBash: parsed.blockRawKubectlInBash ?? DEFAULT_POLICY.blockRawKubectlInBash,
        maskSensitiveOutput: parsed.maskSensitiveOutput ?? DEFAULT_POLICY.maskSensitiveOutput,
        deniedResources: parsed.deniedResources ?? DEFAULT_POLICY.deniedResources,
        confirmationRules: parsed.confirmationRules ?? DEFAULT_POLICY.confirmationRules,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: DEFAULT_POLICY, error: `Failed to load ${POLICY_PATH}: ${message}` };
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function positionalArgs(args: string[]): string[] {
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const flag = arg.split("=", 1)[0];
      if (!arg.includes("=") && FLAGS_WITH_VALUE.has(flag)) i += 1;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      if (FLAGS_WITH_VALUE.has(arg)) i += 1;
      continue;
    }

    positional.push(arg);
  }

  return positional;
}

function getVerb(args: string[]): string | undefined {
  return positionalArgs(args)[0];
}

function getSubcommand(args: string[], verb: string): string | undefined {
  const positional = positionalArgs(args);
  const index = positional.indexOf(verb);
  return index >= 0 ? positional[index + 1] : undefined;
}

function resourceAfterVerb(args: string[], verb: string): string | undefined {
  const positional = positionalArgs(args);
  const index = positional.indexOf(verb);
  return index >= 0 ? positional[index + 1]?.toLowerCase() : undefined;
}

function getFlagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function namespaceFromArgs(args: string[]): string | undefined {
  return getFlagValue(args, ["--namespace", "-n"]);
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function hasAnyFlag(args: string[], names: string[]): boolean {
  return names.some((name) => hasFlag(args, name));
}

function hasBlockedFlag(args: string[], blockedFlags: Set<string>): string | undefined {
  return args.find((arg) => {
    const flag = arg.split("=", 1)[0];
    return blockedFlags.has(flag);
  });
}

function resourceTokens(args: string[]): string[] {
  const verb = getVerb(args);
  if (!verb) return [];

  const positional = positionalArgs(args);
  const index = positional.indexOf(verb);
  if (index < 0) return [];

  return positional.slice(index + 1).flatMap((arg) => arg.toLowerCase().split(","));
}

function normalizeResource(token: string): string {
  const resource = token.split("/", 1)[0].split(".", 1)[0];
  return RESOURCE_ALIASES.get(resource) ?? resource;
}

function touchesSecrets(args: string[]): boolean {
  return resourceTokens(args).some((token) => SECRET_RESOURCES.has(normalizeResource(token)));
}

function validateVerb(args: string[], verb: string): string | undefined {
  if (verb === "auth") {
    const subcommand = getSubcommand(args, verb);
    if (!subcommand || !AUTH_ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return `Blocked: 'auth ${subcommand ?? "(none)"}' is not allowed. Use auth can-i or auth whoami.`;
    }
  }

  if (verb === "rollout") {
    const subcommand = getSubcommand(args, verb);
    if (
      !subcommand ||
      (!ROLLOUT_READ_ONLY_SUBCOMMANDS.has(subcommand) && !ROLLOUT_CONFIRM_SUBCOMMANDS.has(subcommand))
    ) {
      return `Blocked: 'rollout ${subcommand ?? "(none)"}' is not allowed.`;
    }
  }

  return undefined;
}

function ruleAppliesToContext(rule: { contexts?: string[] }, context: string): boolean {
  return !rule.contexts || rule.contexts.length === 0 || rule.contexts.includes(context);
}

function ruleAppliesToVerb(rule: { verbs?: string[]; verb?: string }, verb: string): boolean {
  if (rule.verb && rule.verb !== verb) return false;
  if (rule.verbs && !rule.verbs.includes(verb)) return false;
  return true;
}

function ruleAppliesToResource(ruleResource: string | undefined, resources: string[]): boolean {
  if (!ruleResource) return true;
  const normalizedRuleResource = normalizeResource(ruleResource.toLowerCase());
  return resources.map(normalizeResource).includes(normalizedRuleResource);
}

function applyConfirmationRules(policy: Policy, rules: ConfirmationRule[], args: string[], context: string, verb: string): void {
  const subcommand = getSubcommand(args, verb);
  const namespace = namespaceFromArgs(args);
  const resources = resourceTokens(args);

  for (const rule of rules) {
    if (!ruleAppliesToContext(rule, context)) continue;
    if (!ruleAppliesToVerb(rule, verb)) continue;
    if (rule.subcommand && rule.subcommand !== subcommand) continue;
    if (!ruleAppliesToResource(rule.resource, resources)) continue;
    if (rule.namespaces && (!namespace || !rule.namespaces.includes(namespace))) continue;

    policy.requiresConfirmation = true;
    if (rule.requireUnsafe) policy.requiresUnsafe = true;
    if (rule.requireSensitive) policy.requiresSensitive = true;
    if (rule.requireSensitive) policy.risk = "sensitive";
    else if (rule.requireUnsafe && policy.risk !== "sensitive") policy.risk = "unsafe";
    else if (policy.risk === "read") policy.risk = "confirm";
    policy.reasons.push(rule.message ?? `confirmation rule matched for ${verb}`);
  }
}

function applyResourceRules(policy: Policy, rules: ResourceRule[], args: string[], context: string, verb: string): void {
  const resources = resourceTokens(args);

  for (const rule of rules) {
    if (!ruleAppliesToContext(rule, context)) continue;
    if (!ruleAppliesToVerb(rule, verb)) continue;
    if (!ruleAppliesToResource(rule.resource, resources)) continue;

    if (rule.deny) {
      policy.denied = true;
      policy.denyReason = rule.message ?? `resource ${rule.resource} is denied by policy`;
      continue;
    }

    policy.requiresConfirmation = true;
    if (rule.requireUnsafe) policy.requiresUnsafe = true;
    if (rule.requireSensitive) policy.requiresSensitive = true;
    if (rule.requireSensitive) policy.risk = "sensitive";
    else if (rule.requireUnsafe && policy.risk !== "sensitive") policy.risk = "unsafe";
    else if (policy.risk === "read") policy.risk = "confirm";
    policy.reasons.push(rule.message ?? `resource policy matched for ${rule.resource}`);
  }
}

function classify(args: string[], verb: string, context: string, config: Required<KubectlPolicy>): Policy {
  const policy: Policy = {
    risk: "read",
    reasons: [],
    requiresConfirmation: false,
    requiresUnsafe: false,
    requiresSensitive: false,
    denied: false,
  };

  if (UNSAFE_VERBS.has(verb)) {
    policy.risk = policy.risk === "sensitive" ? policy.risk : "unsafe";
    policy.reasons.push(`${verb} can expose data, start long-running network access, or run code in a container`);
    policy.requiresConfirmation = true;
    policy.requiresUnsafe = true;
  } else if (verb === "rollout") {
    const subcommand = getSubcommand(args, verb);
    if (subcommand && ROLLOUT_CONFIRM_SUBCOMMANDS.has(subcommand)) {
      policy.risk = policy.risk === "sensitive" ? policy.risk : "confirm";
      policy.reasons.push(`rollout ${subcommand} mutates workload state`);
      policy.requiresConfirmation = true;
    }
  } else if (CONFIRM_VERBS.has(verb)) {
    policy.risk = policy.risk === "sensitive" ? policy.risk : "confirm";
    policy.reasons.push(`${verb} mutates cluster state`);
    policy.requiresConfirmation = true;
  }

  if (verb === "create" && getSubcommand(args, verb) === "token") {
    policy.risk = "sensitive";
    policy.reasons.push("create token issues credentials for a service account");
    policy.requiresConfirmation = true;
    policy.requiresSensitive = true;
  }

  if (verb === "delete") {
    const resource = resourceAfterVerb(args, verb);
    if (resource && UNSAFE_DELETE_RESOURCES.has(normalizeResource(resource))) {
      policy.risk = policy.risk === "sensitive" ? policy.risk : "unsafe";
      policy.reasons.push(`deleting ${resource} can have cluster-wide impact`);
      policy.requiresUnsafe = true;
    }
  }

  if (hasAnyFlag(args, ["--watch", "--watch-only", "--follow"]) || (verb === "logs" && hasFlag(args, "-f"))) {
    policy.risk = policy.risk === "sensitive" ? policy.risk : "unsafe";
    policy.reasons.push("streaming or watch flags can run indefinitely");
    policy.requiresConfirmation = true;
    policy.requiresUnsafe = true;
  }

  if (hasFlag(args, "--all") && policy.requiresConfirmation) {
    policy.risk = policy.risk === "sensitive" ? policy.risk : "unsafe";
    policy.reasons.push("--all may affect every matching resource");
    policy.requiresUnsafe = true;
  }

  if ((hasFlag(args, "--all-namespaces") || hasFlag(args, "-A")) && policy.requiresConfirmation) {
    policy.risk = policy.risk === "sensitive" ? policy.risk : "unsafe";
    policy.reasons.push("--all-namespaces broadens the command across namespaces");
    policy.requiresUnsafe = true;
  }

  applyResourceRules(policy, config.deniedResources, args, context, verb);
  applyConfirmationRules(policy, config.confirmationRules, args, context, verb);
  policy.reasons = [...new Set(policy.reasons)];

  return policy;
}

function splitShellStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of script) {
    current += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (char === ";" && !quote) {
      statements.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function formatShellScript(script: string): string {
  return splitShellStatements(script)
    .map((statement) => `    ${statement}`)
    .join("\n");
}

function commandDisplayGroups(parts: string[]): string[] {
  const groups: string[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const flag = part.split("=", 1)[0];
    if (!part.includes("=") && FLAGS_WITH_VALUE.has(flag) && parts[i + 1]) {
      groups.push(`${shellQuote(part)} ${shellQuote(parts[i + 1])}`);
      i += 1;
    } else {
      groups.push(shellQuote(part));
    }
  }

  return groups;
}

function formatCommandLines(parts: string[]): string {
  const groups = commandDisplayGroups(parts);
  if (groups.length === 0) return "";
  if (groups.length === 1) return groups[0];

  return groups
    .map((group, index) => {
      if (index === 0) return `${group} \\`;
      if (index === groups.length - 1) return `  ${group}`;
      return `  ${group} \\`;
    })
    .join("\n");
}

function formattedCommandForPrompt(context: string, args: string[]): string {
  const commandParts = ["kubectl", "--context", context, ...args];
  const separatorIndex = commandParts.indexOf("--");
  const kubectlParts = separatorIndex >= 0 ? [...commandParts.slice(0, separatorIndex), "--"] : commandParts;
  const remoteParts = separatorIndex >= 0 ? commandParts.slice(separatorIndex + 1) : [];
  const kubectlCommand = formatCommandLines(kubectlParts);

  const lines = ["Command:", kubectlCommand];
  if (remoteParts.length > 0) {
    lines.push("", "Container command:", `  ${remoteParts.map(shellQuote).join(" ")}`);
  }

  const shellIndex = remoteParts.findIndex((part) => part === "-c");
  const script = shellIndex >= 0 ? remoteParts[shellIndex + 1] : undefined;
  if (script) {
    lines.push("", "Shell script:", formatShellScript(script));
  }

  return lines.join("\n");
}

function confirmationDetails(command: string, formattedCommand: string, context: string, policy: Policy): string {
  const reasons = policy.reasons.length > 0 ? policy.reasons.map((reason) => `- ${reason}`).join("\n") : "- no extra risk detected";
  return [
    `Risk: ${policy.risk}`,
    `Context: ${context}`,
    "",
    formattedCommand,
    "",
    "Full command:",
    command,
    "",
    "Reasons:",
    reasons,
  ].join("\n");
}

function approvalKey(context: string): string {
  return JSON.stringify({ context });
}

function appendAudit(auditLog: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(auditLog), { recursive: true });
    fs.appendFileSync(auditLog, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // Do not let audit logging failure block an approved operational command.
  }
}

function auditBlocked(auditLog: string, command: string, context: string | undefined, reason: string, details: Record<string, unknown> = {}): void {
  appendAudit(auditLog, { command, context, allowed: false, blocked: true, reason, ...details });
}

/** Python generator variables are not shell aliases; only mask a literal stdin script. */
function maskPythonHeredoc(command: string): string {
  const header = /^[ \t]*(?:\/[A-Za-z0-9_./-]+\/)?python(?:\d+(?:\.\d+)*)?[ \t]+-[ \t]+<<(-?)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")[ \t]*\n/.exec(command);
  if (!header) {
    return command;
  }
  const delimiter = header[2] ?? header[3];
  const lines = command.slice(header[0].length).split("\n");
  const end = lines.findIndex((line) => {
    if (header[1] === "-") {
      return line.replace(/^\t+/, "") === delimiter;
    }
    return line === delimiter;
  });
  if (end < 0) {
    return command;
  }
  return header[0] + "\n".repeat(end + 1) + lines.slice(end + 1).join("\n");
}

function looksLikeRawKubectl(command: string): boolean {
  const executable = String.raw`(?:kubectl|(?:\./|/|[A-Za-z0-9_./-]*/)kubectl)`;
  const prefix = String.raw`(?:^|[;&|({]\s*|\b(?:sudo|doas|nohup)\s+|\benv\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)`;
  if (new RegExp(`${prefix}${executable}(?:\\s|$)`, "m").test(command)) {
    return true;
  }
  return new RegExp(`${prefix}k(?:\\s|$)`, "m").test(maskPythonHeredoc(command));
}

function maskObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskObject);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "data" || key === "stringData") result[key] = maskLeaves(child);
    else result[key] = maskObject(child);
  }
  return result;
}

function maskLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskLeaves);
  if (!value || typeof value !== "object") return "***";

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = "***";
  return result;
}

function maskSensitiveOutput(raw: string): string {
  try {
    return JSON.stringify(maskObject(JSON.parse(raw)), null, 2);
  } catch {
    return raw.replace(/(^\s*(?:data|stringData):\s*\n)([\s\S]*?)(^\S|\z)/gm, (_match, header: string, body: string, next: string) => {
      const masked = body.replace(/^(\s+[^:\n]+:\s*).+$/gm, "$1***");
      return `${header}${masked}${next}`;
    });
  }
}

export default function (pi: ExtensionAPI) {
  const approvals = createApprovalGate(pi, {
    concurrency: "reject",
    onEvent(event) {
      const metadata = event.metadata;
      let auditLog = AUDIT_LOG;
      if (typeof metadata?.auditLog === "string") {
        auditLog = metadata.auditLog;
      }
      let context: string | undefined;
      if (typeof metadata?.context === "string") {
        context = metadata.context;
      }
      const risk = metadata?.risk;
      const reasons = metadata?.reasons;

      if (event.type === "blocked" || event.type === "denied") {
        auditBlocked(auditLog, event.operation, context, event.reason ?? event.type, { risk, reasons });
        return;
      }

      let confirmation: string = event.type;
      if (event.type === "grant-used") {
        confirmation = "approval-grant";
      } else if (event.type === "approved") {
        confirmation = "approved-with-grant";
        if (event.approvalScope === "once") {
          confirmation = "approved-once";
        }
      }
      appendAudit(auditLog, {
        command: event.operation,
        context,
        risk,
        reasons,
        confirmation,
        approvalScope: event.approvalScope,
        approvalLabel: event.approvalLabel,
      });
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const { config, error } = loadPolicy();
    if (!config.blockRawKubectlInBash) return undefined;

    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!looksLikeRawKubectl(command)) return undefined;

    auditBlocked(config.auditLog, command, undefined, "raw kubectl in bash", { policyError: error });
    return {
      block: true,
      reason: "Raw kubectl is blocked. Use kubectl_exec so context, confirmations, and audit logging are applied.",
    };
  });

  pi.registerTool({
    name: "kubectl_exec",
    label: "kubectl",
    description: [
      "Run a scoped kubectl command against a specific kubecontext.",
      "Read commands run without confirmation.",
      "Mutating commands require confirmation.",
      "Unsafe commands require allowUnsafe=true and confirmation.",
      "Secret access requires allowSensitive=true and confirmation.",
      "Sensitive output is masked by default unless revealSensitiveOutput=true.",
      `Optional policy file: ${POLICY_PATH}.`,
      "Context and credential override flags are blocked.",
      "Do NOT pass 'kubectl' itself as the first argument.",
      "You MUST always specify the context parameter. Never omit it.",
    ].join(" "),
    parameters: Type.Object({
      context: Type.String({
        description: "Kubeconfig context name to use, for example \"production\". Always required.",
      }),
      args: Type.Array(Type.String(), {
        description: "kubectl arguments, for example [\"get\", \"pods\", \"-n\", \"default\"]",
      }),
      allowUnsafe: Type.Optional(
        Type.Boolean({
          description: "Permit unsafe commands such as exec, cp, port-forward, debug, broad deletes, or cluster-wide operations after confirmation.",
        }),
      ),
      allowSensitive: Type.Optional(
        Type.Boolean({
          description: "Permit secret resource access after confirmation. Use only when sensitive data access is explicitly needed.",
        }),
      ),
      revealSensitiveOutput: Type.Optional(
        Type.Boolean({
          description: "Return sensitive command output without masking. Requires allowSensitive=true and confirmation.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Command timeout in milliseconds. Defaults to 60000. Maximum is 600000.",
          minimum: 1000,
          maximum: 600000,
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const {
        context,
        args,
        allowUnsafe = false,
        allowSensitive = false,
        revealSensitiveOutput = false,
        timeoutMs = 60_000,
      } = params;
      const { config, error: policyLoadError } = loadPolicy();
      const timeout = Math.min(Math.max(timeoutMs, 1000), 600_000);
      const requestTimeout = `${Math.max(1, Math.floor(timeout / 1000))}s`;
      const scopedArgs = hasFlag(args, "--request-timeout") ? args : [`--request-timeout=${requestTimeout}`, ...args];
      const fullArgs = ["--context", context, ...scopedArgs];
      const displayCmd = ["kubectl", "--context", context, ...args].map(shellQuote).join(" ");
      const formattedDisplayCmd = formattedCommandForPrompt(context, args);
      const verb = getVerb(args);
      const blockedFlag = hasBlockedFlag(args, BLOCKED_SCOPE_FLAGS);
      const rawApiFlag = hasBlockedFlag(args, BLOCKED_RAW_API_FLAGS);

      if (blockedFlag) {
        const reason = `'${blockedFlag}' is not permitted because context and credentials are controlled by the tool.`;
        auditBlocked(config.auditLog, displayCmd, context, reason);
        return {
          content: [{ type: "text", text: `Blocked: ${reason}` }],
          details: { blocked: true },
          isError: true,
        };
      }

      if (rawApiFlag) {
        const reason = `'${rawApiFlag}' is not permitted because raw API calls bypass resource-level safety checks.`;
        auditBlocked(config.auditLog, displayCmd, context, reason);
        return {
          content: [{ type: "text", text: `Blocked: ${reason}` }],
          details: { blocked: true },
          isError: true,
        };
      }

      if (!verb || !ALLOWED_VERBS.has(verb)) {
        const reason = `'${verb ?? "(none)"}' is not an allowed verb.`;
        auditBlocked(config.auditLog, displayCmd, context, reason);
        return {
          content: [{ type: "text", text: `Blocked: ${reason}` }],
          details: { blocked: true },
          isError: true,
        };
      }

      const validationError = validateVerb(args, verb);
      if (validationError) {
        auditBlocked(config.auditLog, displayCmd, context, validationError);
        return {
          content: [{ type: "text", text: validationError }],
          details: { blocked: true },
          isError: true,
        };
      }

      const policy = classify(args, verb, context, config);
      if (policyLoadError && policy.requiresConfirmation) {
        auditBlocked(config.auditLog, displayCmd, context, policyLoadError, { risk: policy.risk });
        return {
          content: [{ type: "text", text: `Blocked: kubectl policy could not be loaded. ${policyLoadError}` }],
          details: { blocked: true, risk: policy.risk, policyLoadError },
          isError: true,
        };
      }

      if (policy.denied) {
        const reason = `kubectl policy: ${policy.denyReason}`;
        auditBlocked(config.auditLog, displayCmd, context, reason, { risk: policy.risk, reasons: policy.reasons });
        return {
          content: [{ type: "text", text: `Blocked by ${reason}` }],
          details: { blocked: true, risk: policy.risk, reasons: policy.reasons },
          isError: true,
        };
      }

      if (policy.requiresUnsafe && !allowUnsafe) {
        const reason = `unsafe kubectl command requires allowUnsafe=true. Reasons: ${policy.reasons.join("; ")}`;
        auditBlocked(config.auditLog, displayCmd, context, reason, { risk: policy.risk, reasons: policy.reasons });
        return {
          content: [{ type: "text", text: `Blocked: ${reason}` }],
          details: { blocked: true, risk: policy.risk, reasons: policy.reasons },
          isError: true,
        };
      }

      if (policy.requiresSensitive && !allowSensitive) {
        const reason = `sensitive kubectl command requires allowSensitive=true. Reasons: ${policy.reasons.join("; ")}`;
        auditBlocked(config.auditLog, displayCmd, context, reason, { risk: policy.risk, reasons: policy.reasons });
        return {
          content: [{ type: "text", text: `Blocked: ${reason}` }],
          details: { blocked: true, risk: policy.risk, reasons: policy.reasons },
          isError: true,
        };
      }

      let approval;
      if (policy.requiresConfirmation) {
        approval = await approvals.authorize(ctx, {
          key: approvalKey(context),
          operation: displayCmd,
          scopeLabel: "this context",
          prompt: confirmationDetails(displayCmd, formattedDisplayCmd, context, policy),
          question: "Allow this kubectl command?",
          metadata: {
            auditLog: config.auditLog,
            context,
            risk: policy.risk,
            reasons: policy.reasons,
          },
          onStatus(status) {
            let text = `Waiting for confirmation: ${displayCmd}`;
            if (status.type === "grant-used") {
              text = `Using kubectl approval grant (${status.grant?.label}): ${displayCmd}`;
            }
            onUpdate?.({ content: [{ type: "text", text }], details: {} });
          },
        });

        if (!approval.allowed) {
          let text = `Blocked: ${approval.reason}.`;
          if (approval.kind === "user-denied") {
            text = "Blocked by user.";
          } else if (approval.kind === "busy") {
            text += " Run confirmed Kubernetes operations one at a time.";
          }
          return {
            content: [{ type: "text", text }],
            details: { blocked: true, risk: policy.risk, reasons: policy.reasons },
            isError: approval.kind !== "user-denied",
          };
        }
      }

      let result;
      try {
        onUpdate?.({ content: [{ type: "text", text: `Running: ${displayCmd}` }], details: {} });
        result = await pi.exec("kubectl", fullArgs, { signal, timeout });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendAudit(config.auditLog, {
          command: displayCmd,
          context,
          risk: policy.risk,
          reasons: policy.reasons,
          allowed: true,
          execError: message,
        });
        return {
          content: [{ type: "text", text: `kubectl execution failed: ${message}` }],
          details: { command: displayCmd, risk: policy.risk, reasons: policy.reasons, execError: message },
          isError: true,
        };
      } finally {
        approval?.release();
      }

      if (policy.requiresConfirmation) {
        appendAudit(config.auditLog, {
          command: displayCmd,
          context,
          risk: policy.risk,
          reasons: policy.reasons,
          allowed: true,
          exitCode: result.code,
        });
      }

      const stdout = policy.requiresSensitive && config.maskSensitiveOutput && !revealSensitiveOutput ? maskSensitiveOutput(result.stdout) : result.stdout;
      const raw = stdout + (result.stderr ? `\nSTDERR:\n${result.stderr}` : "");
      const truncation = truncateTail(raw, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
      }

      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: {
          exitCode: result.code,
          command: displayCmd,
          risk: policy.risk,
          reasons: policy.reasons,
          sensitiveOutputMasked: policy.requiresSensitive && config.maskSensitiveOutput && !revealSensitiveOutput,
          truncated: truncation.truncated,
        },
        isError: result.code !== 0,
      };
    },
  });
}
