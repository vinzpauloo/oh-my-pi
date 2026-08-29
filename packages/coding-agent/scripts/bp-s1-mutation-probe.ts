#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface Replacement {
	anchor: string;
	before: string;
	after: string;
}

interface TargetedTest {
	file: string;
	name: string;
}

interface Mutation {
	id: string;
	description: string;
	file: string;
	replacements: Replacement[];
	tests: TargetedTest[];
	expectedRed: string;
}

interface CommandOutcome {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface WorktreeBaseline {
	status: string;
	cachedDiff: string;
	dirtyPaths: Set<string>;
	fingerprints: Map<string, string>;
}

interface MutationResult {
	id: string;
	description: string;
	source: string;
	anchors: string[];
	tests: string[];
	expectedRed: string;
	mutatedBuild: { command: string[]; exitCode: number };
	redChecks: Array<{ command: string[]; exitCode: number }>;
	restore: { byteIdentical: boolean; worktreeIdentical: boolean };
	restoredRetest: { command: string[]; exitCode: number };
}

const HELP = `Usage: bun packages/coding-agent/scripts/bp-s1-mutation-probe.ts --all [--json]

Independently applies every BP-S1 production mutation, requires the named test rows to turn red,
restores the exact pre-run bytes, and rechecks the restored baseline. Existing uncommitted work is
preserved in memory; any unrelated dirty-path change fails the run.

Options:
  --all                   Run M1/M2/M3/M4/M5a/M5b/M5c/M6/M7, all M8 variants, and M9/M10/M11/M12
  --json                  Emit the final mutation matrix as JSON
  -h, --help              Show this help
`;

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const LIFECYCLE_SOURCE = "packages/coding-agent/src/registry/agent-lifecycle.ts";
const SDK_SOURCE = "packages/coding-agent/src/sdk.ts";
const VIBE_SOURCE = "packages/coding-agent/src/vibe/runtime.ts";
const EXECUTOR_SOURCE = "packages/coding-agent/src/task/executor.ts";
const LIFECYCLE_TEST = "packages/coding-agent/test/bp-s1-lifecycle.test.ts";
const ADJACENCY_TEST = "packages/coding-agent/test/bp-s1-adjacency.test.ts";
const SCOPE_TEST = "packages/coding-agent/test/bp-s1-scope.test.ts";
const VIBE_TEST = "packages/coding-agent/test/vibe/spawn-model-role.test.ts";
const EXECUTOR_WALL_CLOCK_TEST = "packages/coding-agent/test/task/executor-wall-clock.test.ts";
const PYTHON_CLEANUP_TEST = "packages/coding-agent/test/agent-session-python-cleanup.test.ts";
const BUILD_COMMAND = ["bun", "--cwd", "packages/coding-agent", "run", "check"];
const PROOF_COMMAND = ["bun", "test", LIFECYCLE_TEST, ADJACENCY_TEST, SCOPE_TEST, "--timeout", "60000"];

const MUTATIONS: Mutation[] = [
	{
		id: "M1",
		description: "remove the child root identity",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.createIdentity rootAgentId",
				before: "\t\tconst rootAgentId = parent?.agent.rootAgentId ?? input.parentAgentId ?? input.agentId;",
				after: '\t\tconst rootAgentId = parent ? "" : input.parentAgentId ?? input.agentId;',
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "real root plus two children" },
			{ file: LIFECYCLE_TEST, name: "root observer inheritance and isolation" },
		],
		expectedRed: "root observer loses both children because their emitted rootAgentId is empty",
	},
	{
		id: "M2",
		description: "emit a self-parented child identity",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.createIdentity parentAgentId",
				before: "\t\t\tparentAgentId: input.parentAgentId ?? null,",
				after: "\t\t\tparentAgentId: input.parentAgentId ? input.agentId : null,",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root observer inheritance and isolation" },
			{ file: LIFECYCLE_TEST, name: "lineage authority isolation" },
		],
		expectedRed: "production registration rejects or exposes the wrong parent lineage",
	},
	{
		id: "M3",
		description: "duplicate child current-session identity",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.createIdentity currentSessionId",
				before: "\t\t\tcurrentSessionId: input.currentSessionId,",
				after: "\t\t\tcurrentSessionId: input.parentAgentId ?? input.currentSessionId,",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "real root plus two children" },
			{ file: LIFECYCLE_TEST, name: "root observer inheritance and isolation" },
		],
		expectedRed: "both child identities expose the same parent-derived currentSessionId",
	},
	{
		id: "M4",
		description: "derive agent identity from the display label",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.createIdentity agentId",
				before: "\t\t\tagentId: input.agentId,",
				after: "\t\t\tagentId: input.label,",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "incidental metadata identity negative" },
			{ file: ADJACENCY_TEST, name: "metadata only privacy" },
		],
		expectedRed: "the real registry/lifecycle boundary rejects label-derived agent identity",
	},
	{
		id: "M5a",
		description: "mark park as terminal",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.commitParked terminal argument",
				before:
					'\t\treturn this.#commit(root, current.agent, "parked", current.state, "parked", "idle-timeout", revivable, false);',
				after: '\t\treturn this.#commit(root, current.agent, "parked", current.state, "parked", "idle-timeout", revivable, true);',
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "park dispose cold revive" },
			{ file: LIFECYCLE_TEST, name: "non-authoritative stop signals" },
		],
		expectedRed: "parked transition/state becomes terminal instead of revivable suspension",
	},
	{
		id: "M5b",
		description: "treat agent_end as terminal release authority",
		file: SDK_SOURCE,
		replacements: [
			{
				anchor: "createAgentSession post-registration lifecycle wiring",
				before:
					// biome-ignore lint/suspicious/noTemplateCurlyInString: Exact source anchor must preserve the literal placeholder.
					'\t\tif (!lifecycleCommitted) {\n\t\t\tthrow new Error(`Agent "${resolvedAgentId}" lifecycle registration was rejected.`);\n\t\t}\n\t\t// MCP notification bridge cleanup',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Exact mutated source must preserve the literal placeholder.
				after: '\t\tif (!lifecycleCommitted) {\n\t\t\tthrow new Error(`Agent "${resolvedAgentId}" lifecycle registration was rejected.`);\n\t\t}\n\t\tdisposeCallbacks.add(\n\t\t\tsession.subscribe(event => {\n\t\t\t\tif (event.type === "agent_end") unregisterUnlessParked();\n\t\t\t}),\n\t\t);\n\t\t// MCP notification bridge cleanup',
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root and child lifecycle authority" },
			{ file: LIFECYCLE_TEST, name: "non-authoritative stop signals" },
		],
		expectedRed: "the real session event subscription unregisters and emits released on agent_end",
	},
	{
		id: "M5c",
		description: "treat session_shutdown during park as terminal release authority",
		file: SDK_SOURCE,
		replacements: [
			{
				anchor: "createAgentSession unregisterUnlessParked parked-status guard",
				before: '\t\tif (ref.status === "parked" || (ref.status === "aborted" && !ref.session)) return;',
				after: '\t\tif (ref.status === "aborted" && !ref.session) return;',
			},
			{
				anchor: "createAgentSession unregisterUnlessParked parking guard",
				before: "\t\tif (agentLifecycle.isParking(resolvedAgentId, ref)) return;\n",
				after: "",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root and child lifecycle authority" },
			{ file: LIFECYCLE_TEST, name: "non-authoritative stop signals" },
		],
		expectedRed: "session disposal during park unregisters the ref and emits a terminal release",
	},
	{
		id: "M6",
		description: "remint stable agent identity on revive",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.createIdentity retained revive identity",
				before:
					"\t\t\t\tconst identity = Object.freeze({ ...entry.agent, currentSessionId: input.currentSessionId });",
				after: "\t\t\t\tconst identity = Object.freeze({\n\t\t\t\t\t...entry.agent,\n\t\t\t\t\tagentId: input.currentSessionId,\n\t\t\t\t\tcurrentSessionId: input.currentSessionId,\n\t\t\t\t});",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "park dispose cold revive" },
			{ file: ADJACENCY_TEST, name: "lifecycle edge matrix" },
		],
		expectedRed: "revive remints agentId and the real commitRevived stable-identity guard rejects it",
	},
	{
		id: "M7",
		description: "leave an aborted terminal identity revivable",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.commitAborted revivable argument",
				before:
					'\t\treturn this.#commit(root, current.agent, "aborted", current.state, "aborted", "hard-abort", false, true);',
				after: '\t\treturn this.#commit(root, current.agent, "aborted", current.state, "aborted", "hard-abort", true, true);',
			},
		],
		tests: [{ file: ADJACENCY_TEST, name: "revive terminal abort negatives" }],
		expectedRed: "aborted terminal snapshot/event incorrectly reports revivable=true",
	},
	{
		id: "M8-suppress",
		description: "suppress semantic lifecycle delivery",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.#commit listener iteration",
				before: "\t\tfor (const listener of [...root.listeners]) {",
				after: "\t\tconst mutationListeners: AgentLifecycleListener[] = [];\n\t\tfor (const listener of mutationListeners) {",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root lifecycle snapshot and stream" },
			{ file: ADJACENCY_TEST, name: "real emitter and state waits" },
		],
		expectedRed: "state commits but the production emitter delivers no semantic transition",
	},
	{
		id: "M8-duplicate",
		description: "duplicate semantic lifecycle delivery",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.#commit listener call",
				before: "\t\t\t\tlistener(event);",
				after: "\t\t\t\tlistener(event);\n\t\t\t\tlistener(event);",
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root lifecycle snapshot and stream" },
			{ file: ADJACENCY_TEST, name: "lifecycle ordering races: park-cancel no-op, duplicate revive, revive-abort" },
		],
		expectedRed: "each production lifecycle event is delivered twice",
	},
	{
		id: "M8-reorder",
		description: "deliver revived before its preceding parked transition",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager mutation pending-event slot",
				before: "\t#disposed = false;",
				after: "\t#disposed = false;\n\t#mutationPendingParked: AgentLifecycleTransition | undefined;",
			},
			{
				anchor: "AgentLifecycleManager.#commit ordered listener delivery",
				before:
					'\t\tfor (const listener of [...root.listeners]) {\n\t\t\ttry {\n\t\t\t\tlistener(event);\n\t\t\t} catch (error) {\n\t\t\t\tlogger.warn("Agent lifecycle listener failed", {\n\t\t\t\t\tid: identity.agentId,\n\t\t\t\t\terror: error instanceof Error ? error.message : String(error),\n\t\t\t\t});\n\t\t\t}\n\t\t}',
				after: '\t\tif (transition === "parked") {\n\t\t\tthis.#mutationPendingParked = event;\n\t\t\treturn true;\n\t\t}\n\t\tfor (const listener of [...root.listeners]) {\n\t\t\ttry {\n\t\t\t\tlistener(event);\n\t\t\t\tif (transition === "revived" && this.#mutationPendingParked) {\n\t\t\t\t\tlistener(this.#mutationPendingParked);\n\t\t\t\t}\n\t\t\t} catch (error) {\n\t\t\t\tlogger.warn("Agent lifecycle listener failed", {\n\t\t\t\t\tid: identity.agentId,\n\t\t\t\t\terror: error instanceof Error ? error.message : String(error),\n\t\t\t\t});\n\t\t\t}\n\t\t}\n\t\tif (transition === "revived") this.#mutationPendingParked = undefined;',
			},
		],
		tests: [
			{ file: LIFECYCLE_TEST, name: "root lifecycle snapshot and stream" },
			{ file: ADJACENCY_TEST, name: "lifecycle ordering races: park-cancel no-op, duplicate revive, revive-abort" },
		],
		expectedRed: "parked is withheld and emitted only after revived, reversing semantic order",
	},
	{
		id: "M9",
		description: "remove Vibe private lifecycle authority forwarding",
		file: VIBE_SOURCE,
		replacements: [
			{
				anchor: "Vibe first-turn private lifecycle authority",
				before:
					"\t\t\tparentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,\n\t\t\tagentRegistry: record.agentRegistry,\n\t\t\tagentLifecycle: record.agentLifecycle,",
				after: "\t\t\tparentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,",
			},
			{
				anchor: "Vibe follow-up private lifecycle authority",
				before:
					"\t\t\t\t\t\t\t\tartifactsDir: session.getSessionFile()?.slice(0, -6),\n\t\t\t\t\t\t\t\tagentRegistry: record.agentRegistry,\n\t\t\t\t\t\t\t\tagentLifecycle: record.agentLifecycle,",
				after: "\t\t\t\t\t\t\t\tartifactsDir: session.getSessionFile()?.slice(0, -6),",
			},
		],
		tests: [{ file: VIBE_TEST, name: "vibe private lifecycle authority" }],
		expectedRed: "Vibe first and follow-up turns fall back from their parent's private registry/lifecycle authority",
	},
	{
		id: "M10",
		description: "omit isolated bound refs from lifecycle disposal",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.dispose exact bound refs",
				before: "\t\tfor (const ref of this.#publicBindings.keys()) includeRef(ref);\n",
				after: "",
			},
		],
		tests: [{ file: LIFECYCLE_TEST, name: "isolated parked teardown" }],
		expectedRed: "a bound isolated non-adopted ref survives lifecycle disposal",
	},
	{
		id: "M11",
		description: "remove successful session creation timestamp assignment",
		file: EXECUTOR_SOURCE,
		replacements: [
			{
				anchor: "executeTask successful sessionCreatedAt assignment",
				before: "\t\t\tsessionCreatedAt = performance.now();\n",
				after: "",
			},
		],
		tests: [{ file: EXECUTOR_WALL_CLOCK_TEST, name: "subagent launch timing" }],
		expectedRed: "createSessionMs and readyMs lose their successful-session boundary timestamp",
	},
	{
		id: "M12",
		description: "remove cross-root teardown isolation",
		file: LIFECYCLE_SOURCE,
		replacements: [
			{
				anchor: "AgentLifecycleManager.dispose owner root binding filter",
				before:
					"\t\t\tif (options.ownerRef) {\n\t\t\t\tconst binding = this.#publicBindings.get(ref);\n\t\t\t\tif (!ownerRootInstanceId || binding?.rootInstanceId !== ownerRootInstanceId) return;\n\t\t\t}\n",
				after: "",
			},
		],
		tests: [{ file: PYTHON_CLEANUP_TEST, name: "waits for active SDK session Python work" }],
		expectedRed: "the second root/session is disposed while the first owner tears down",
	},
];

function parseArgs(argv: string[]): { json: boolean } | undefined {
	if (argv.includes("-h") || argv.includes("--help")) {
		if (argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
		console.log(HELP.trimEnd());
		return undefined;
	}
	let all = false;
	let json = false;
	for (const arg of argv) {
		if (arg === "--all") {
			if (all) throw new Error("--all may be specified only once");
			all = true;
		} else if (arg === "--json") {
			if (json) throw new Error("--json may be specified only once");
			json = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!all) throw new Error("--all is required");
	return { json };
}

async function runCommand(command: string[], timeoutMs: number): Promise<CommandOutcome> {
	const child = Bun.spawn(command, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	activeChild = child;
	const stdoutPending = new Response(child.stdout).text();
	const stderrPending = new Response(child.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const exitCode = await child.exited;
	clearTimeout(timer);
	if (activeChild === child) activeChild = undefined;
	return {
		command,
		exitCode,
		stdout: await stdoutPending,
		stderr: await stderrPending,
		timedOut,
	};
}

async function git(args: string[]): Promise<string> {
	const outcome = await runCommand(["git", ...args], 30_000);
	if (outcome.exitCode !== 0 || outcome.timedOut) {
		throw new Error(`git ${args.join(" ")} exited ${outcome.exitCode}: ${outcome.stderr.trim()}`);
	}
	return outcome.stdout;
}

function nulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(relativePath: string): string {
	const absolutePath = path.join(REPO_ROOT, relativePath);
	try {
		const stat = fs.lstatSync(absolutePath);
		if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolutePath)}`;
		if (stat.isFile()) return `file:${stat.mode & 0o777}:${sha256(fs.readFileSync(absolutePath))}`;
		if (stat.isDirectory()) return `directory:${stat.mode & 0o777}`;
		return `other:${stat.mode}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}

async function dirtyPaths(): Promise<Set<string>> {
	const [unstaged, staged, untracked] = await Promise.all([
		git(["diff", "--name-only", "-z", "--no-ext-diff"]),
		git(["diff", "--cached", "--name-only", "-z", "--no-ext-diff"]),
		git(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return new Set([...nulPaths(unstaged), ...nulPaths(staged), ...nulPaths(untracked)]);
}

async function captureBaseline(): Promise<WorktreeBaseline> {
	const [status, cachedDiff, paths] = await Promise.all([
		git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		git(["diff", "--cached", "--binary", "--no-ext-diff"]),
		dirtyPaths(),
	]);
	return {
		status,
		cachedDiff,
		dirtyPaths: paths,
		fingerprints: new Map([...paths].map(relativePath => [relativePath, fingerprint(relativePath)])),
	};
}

async function assertNoExtraDirty(baseline: WorktreeBaseline, allowedMutationPaths: Set<string>): Promise<void> {
	const [currentPaths, currentCachedDiff] = await Promise.all([
		dirtyPaths(),
		git(["diff", "--cached", "--binary", "--no-ext-diff"]),
	]);
	if (currentCachedDiff !== baseline.cachedDiff) throw new Error("a command changed the staged diff");
	const extra = [...currentPaths].filter(
		relativePath => !baseline.dirtyPaths.has(relativePath) && !allowedMutationPaths.has(relativePath),
	);
	if (extra.length > 0) throw new Error(`a command dirtied extra path(s): ${extra.join(", ")}`);
	for (const relativePath of baseline.dirtyPaths) {
		if (allowedMutationPaths.has(relativePath)) continue;
		const before = baseline.fingerprints.get(relativePath);
		const after = fingerprint(relativePath);
		if (before !== after) throw new Error(`a command changed pre-existing uncommitted work at ${relativePath}`);
	}
}

async function assertExactBaseline(baseline: WorktreeBaseline): Promise<void> {
	const current = await captureBaseline();
	if (current.status !== baseline.status) {
		throw new Error("worktree status did not return to the pre-run baseline");
	}
	if (current.cachedDiff !== baseline.cachedDiff) {
		throw new Error("staged diff did not return to the pre-run baseline");
	}
	if (current.dirtyPaths.size !== baseline.dirtyPaths.size) {
		throw new Error("dirty path count did not return to baseline");
	}
	for (const relativePath of baseline.dirtyPaths) {
		if (!current.dirtyPaths.has(relativePath)) {
			throw new Error(`baseline dirty path disappeared: ${relativePath}`);
		}
		if (current.fingerprints.get(relativePath) !== baseline.fingerprints.get(relativePath)) {
			throw new Error(`baseline bytes changed at ${relativePath}`);
		}
	}
}

function countOccurrences(source: string, anchor: string): number {
	if (anchor.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (true) {
		const found = source.indexOf(anchor, offset);
		if (found === -1) return count;
		count += 1;
		offset = found + anchor.length;
	}
}

function applyMutation(mutation: Mutation, original: Uint8Array): Uint8Array {
	let source = new TextDecoder().decode(original);
	for (const replacement of mutation.replacements) {
		const matches = countOccurrences(source, replacement.before);
		if (matches !== 1) {
			throw new Error(
				`${mutation.id} anchor ${replacement.anchor} matched ${matches} times; exactly one is required`,
			);
		}
		if (replacement.before === replacement.after) {
			throw new Error(`${mutation.id} anchor ${replacement.anchor} is a no-op`);
		}
		source = source.replace(replacement.before, replacement.after);
	}
	return new TextEncoder().encode(source);
}

function restoredTestCommand(mutation: Mutation): string[] {
	const files = [...new Set(mutation.tests.map(test => test.file))];
	const pattern = mutation.tests.map(test => test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return ["bun", "test", ...files, "--test-name-pattern", pattern, "--timeout", "60000"];
}

function requireGreen(outcome: CommandOutcome, label: string): void {
	if (outcome.timedOut || outcome.exitCode !== 0) {
		const output = `${outcome.stdout}\n${outcome.stderr}`.trim();
		const tail = output.length <= 4_000 ? output : output.slice(-4_000);
		throw new Error(
			`${label} failed with exit ${outcome.exitCode}${outcome.timedOut ? " after timeout" : ""}\n${tail}`,
		);
	}
}

function requireRed(outcome: CommandOutcome, label: string): void {
	if (outcome.timedOut) throw new Error(`${label} timed out instead of producing a bounded red result`);
	if (outcome.exitCode === 0) throw new Error(`${label} unexpectedly stayed green`);
}

let activeChild: Bun.Subprocess | undefined;
let activeRestore: (() => void) | undefined;
let terminating = false;
function terminate(signal: "SIGINT" | "SIGTERM"): void {
	if (terminating) return;
	terminating = true;
	activeChild?.kill();
	try {
		activeRestore?.();
	} finally {
		process.exit(signal === "SIGINT" ? 130 : 143);
	}
}
process.once("exit", () => {
	activeRestore?.();
});
process.once("SIGINT", () => terminate("SIGINT"));
process.once("SIGTERM", () => terminate("SIGTERM"));

let args: { json: boolean } | undefined;
try {
	args = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`bp-s1-mutation-probe: ${error instanceof Error ? error.message : String(error)}`);
	console.error("Run with --help for usage.");
	process.exit(2);
}
if (!args) process.exit(0);

const baseline = await captureBaseline();
const initialBuild = await runCommand(BUILD_COMMAND, 600_000);
requireGreen(initialBuild, "initial build/check baseline");
await assertExactBaseline(baseline);
const initialProof = await runCommand(PROOF_COMMAND, 600_000);
requireGreen(initialProof, "initial BP-S1 proof baseline");
await assertExactBaseline(baseline);

const results: MutationResult[] = [];
try {
	for (const mutation of MUTATIONS) {
		const absolutePath = path.join(REPO_ROOT, mutation.file);
		const original = fs.readFileSync(absolutePath);
		const originalHash = sha256(original);
		const mutated = applyMutation(mutation, original);
		const allowedPaths = new Set([mutation.file]);
		const restore = () => {
			fs.writeFileSync(absolutePath, original);
		};
		activeRestore = restore;
		try {
			fs.writeFileSync(absolutePath, mutated);
			if (sha256(fs.readFileSync(absolutePath)) !== sha256(mutated)) {
				throw new Error(`${mutation.id} mutation write did not match the requested bytes`);
			}
			await assertNoExtraDirty(baseline, allowedPaths);

			const mutatedBuild = await runCommand(BUILD_COMMAND, 600_000);
			requireGreen(mutatedBuild, `${mutation.id} mutated build/check`);
			await assertNoExtraDirty(baseline, allowedPaths);

			const redOutcomes: CommandOutcome[] = [];
			for (const test of mutation.tests) {
				const outcome = await runCommand(
					["bun", "test", test.file, "--test-name-pattern", test.name, "--timeout", "60000"],
					90_000,
				);
				requireRed(outcome, `${mutation.id} targeted test ${test.name}`);
				redOutcomes.push(outcome);
				await assertNoExtraDirty(baseline, allowedPaths);
			}

			restore();
			if (sha256(fs.readFileSync(absolutePath)) !== originalHash) {
				throw new Error(`${mutation.id} restore mismatch for ${mutation.file}`);
			}
			await assertExactBaseline(baseline);
			const retest = await runCommand(restoredTestCommand(mutation), 180_000);
			requireGreen(retest, `${mutation.id} restored targeted baseline`);
			await assertExactBaseline(baseline);

			results.push({
				id: mutation.id,
				description: mutation.description,
				source: mutation.file,
				anchors: mutation.replacements.map(replacement => replacement.anchor),
				tests: mutation.tests.map(test => `${test.file} :: ${test.name}`),
				expectedRed: mutation.expectedRed,
				mutatedBuild: { command: mutatedBuild.command, exitCode: mutatedBuild.exitCode },
				redChecks: redOutcomes.map(outcome => ({ command: outcome.command, exitCode: outcome.exitCode })),
				restore: { byteIdentical: true, worktreeIdentical: true },
				restoredRetest: { command: retest.command, exitCode: retest.exitCode },
			});
		} finally {
			restore();
			activeRestore = undefined;
		}
	}

	const finalBuild = await runCommand(BUILD_COMMAND, 600_000);
	requireGreen(finalBuild, "final restored build/check baseline");
	await assertExactBaseline(baseline);
	const finalProof = await runCommand(PROOF_COMMAND, 600_000);
	requireGreen(finalProof, "final restored BP-S1 proof baseline");
	await assertExactBaseline(baseline);

	const report = {
		verdict: "GO" as const,
		mutations: results,
		initialBaseline: {
			build: { command: initialBuild.command, exitCode: initialBuild.exitCode },
			proof: { command: initialProof.command, exitCode: initialProof.exitCode },
		},
		finalBaseline: {
			build: { command: finalBuild.command, exitCode: finalBuild.exitCode },
			proof: { command: finalProof.command, exitCode: finalProof.exitCode },
		},
		notExercised: [
			"provider requests",
			"live OMP configuration",
			"omp-core lock edits",
			"install or restart",
			"commit, push, or merge",
			"astaroth or DMG operations",
		],
		notExercisedCommands: [
			"cursor-agent <authenticated prompt>",
			"~/Desktop/omp-core/install.sh",
			"~/Desktop/omp-core/tools/omp-binary.sh install",
			"git commit",
			"git push",
			"git merge",
			"astaroth release or DMG commands",
		],
	};
	if (args.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log("BP-S1 mutation matrix: GO");
		for (const result of results) {
			console.log(`${result.id}: RED -> RESTORED GREEN | ${result.source} | ${result.tests.join("; ")}`);
		}
		console.log(JSON.stringify(report, null, 2));
	}
} catch (error) {
	try {
		activeRestore?.();
		activeRestore = undefined;
		await assertExactBaseline(baseline);
	} catch (restoreError) {
		console.error(
			`bp-s1-mutation-probe restore failure: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
		);
	}
	const report = {
		verdict: "NO-GO" as const,
		error: error instanceof Error ? error.message : String(error),
		completedMutations: results,
		notExercised: [
			"provider requests",
			"live OMP configuration",
			"omp-core lock edits",
			"install or restart",
			"commit, push, or merge",
			"astaroth or DMG operations",
		],
		notExercisedCommands: [
			"cursor-agent <authenticated prompt>",
			"~/Desktop/omp-core/install.sh",
			"~/Desktop/omp-core/tools/omp-binary.sh install",
			"git commit",
			"git push",
			"git merge",
			"astaroth release or DMG commands",
		],
	};
	if (args.json) console.log(JSON.stringify(report));
	else console.error(JSON.stringify(report, null, 2));
	process.exitCode = 1;
}
