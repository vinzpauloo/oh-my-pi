#!/usr/bin/env bun
import * as path from "node:path";

type GoNoGo = "GO" | "NO-GO";
type ThreeWayVerdict = GoNoGo | "UNPROVEN";

interface CommandOutcome {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface JsonRecord {
	[key: string]: unknown;
}

const HELP = `Usage: bun packages/coding-agent/scripts/bp-s1-decision.ts [--json]

Runs fresh BP-S1 capability, mutation, terminal-observer, and isolated-authority gates, then emits
an independent progression decision. Required NO-GO fields fail closed; Cursor hook execution may
remain UNPROVEN and does not silently block BP-S2.

Options:
  --json      Emit machine-readable JSON
  -h, --help  Show this help
`;

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CAPABILITY_SCRIPT = "packages/coding-agent/scripts/bp-s1-capability-gates.ts";
const MUTATION_SCRIPT = "packages/coding-agent/scripts/bp-s1-mutation-probe.ts";
const ADJACENCY_TEST = "packages/coding-agent/test/bp-s1-adjacency.test.ts";

function parseArgs(argv: string[]): { json: boolean } | undefined {
	if (argv.includes("-h") || argv.includes("--help")) {
		if (argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
		console.log(HELP.trimEnd());
		return undefined;
	}
	let json = false;
	for (const arg of argv) {
		if (arg !== "--json") throw new Error(`unknown argument: ${arg}`);
		if (json) throw new Error("--json may be specified only once");
		json = true;
	}
	return { json };
}

async function runCommand(command: string[], timeoutMs: number): Promise<CommandOutcome> {
	const child = Bun.spawn(command, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const stdoutPending = new Response(child.stdout).text();
	const stderrPending = new Response(child.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const exitCode = await child.exited;
	clearTimeout(timer);
	return {
		command,
		exitCode,
		stdout: await stdoutPending,
		stderr: await stderrPending,
		timedOut,
	};
}

function parseJson(outcome: CommandOutcome): { value?: JsonRecord; error?: string } {
	try {
		const value: unknown = JSON.parse(outcome.stdout);
		if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "stdout JSON is not an object" };
		return { value: value as JsonRecord };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function commandEvidence(outcome: CommandOutcome, parsed: { value?: JsonRecord; error?: string }) {
	return {
		command: outcome.command,
		exitCode: outcome.exitCode,
		timedOut: outcome.timedOut,
		json: parsed.value,
		parseError: parsed.error,
		stderr: outcome.stderr.trim(),
	};
}

function verdictFromJson(
	outcome: CommandOutcome,
	parsed: { value?: JsonRecord; error?: string },
	field: string,
): GoNoGo {
	const candidate = parsed.value?.[field];
	return !outcome.timedOut && outcome.exitCode === 0 && candidate === "GO" ? "GO" : "NO-GO";
}

function explainCommandVerdict(
	label: string,
	verdict: ThreeWayVerdict,
	outcome: CommandOutcome,
	parsed?: { value?: JsonRecord; error?: string },
): string {
	const sourceExplanation = parsed?.value?.explanation;
	if (typeof sourceExplanation === "string") return sourceExplanation;
	if (verdict === "UNPROVEN") return `${label} was deliberately not exercised.`;
	if (outcome.timedOut) return `${label} timed out and is NO-GO.`;
	if (parsed?.error) return `${label} emitted invalid JSON (${parsed.error}) and is NO-GO.`;
	return `${label} exited ${outcome.exitCode} and is ${verdict}.`;
}

let args: { json: boolean } | undefined;
try {
	args = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`bp-s1-decision: ${error instanceof Error ? error.message : String(error)}`);
	console.error("Run with --help for usage.");
	process.exit(2);
}
if (!args) process.exit(0);

const cursorOutcome = await runCommand(["bun", CAPABILITY_SCRIPT, "--gate", "cursor-plugin", "--json"], 30_000);
const cursorJson = parseJson(cursorOutcome);
const forkPinOutcome = await runCommand(["bun", CAPABILITY_SCRIPT, "--gate", "fork-pin-dry-run", "--json"], 30_000);
const forkPinJson = parseJson(forkPinOutcome);
const mutationOutcome = await runCommand(["bun", MUTATION_SCRIPT, "--all", "--json"], 7_200_000);
const mutationJson = parseJson(mutationOutcome);
const terminalOutcome = await runCommand(
	[
		"bun",
		"test",
		ADJACENCY_TEST,
		"--test-name-pattern",
		"terminal without observer and resubscribe",
		"--timeout",
		"60000",
	],
	90_000,
);
const isolationOutcome = await runCommand(
	[
		"bun",
		"test",
		ADJACENCY_TEST,
		"--test-name-pattern",
		"isolated lifecycle authority and real emitter",
		"--timeout",
		"60000",
	],
	90_000,
);

const lifecycleDecidability = verdictFromJson(mutationOutcome, mutationJson, "verdict");
const cursorPluginMechanism = verdictFromJson(cursorOutcome, cursorJson, "mechanism");
const cursorHookCandidate = cursorJson.value?.liveExecution;
let cursorHookExecution: ThreeWayVerdict = "NO-GO";
if (
	cursorJson.value &&
	(cursorHookCandidate === "GO" || cursorHookCandidate === "NO-GO" || cursorHookCandidate === "UNPROVEN")
) {
	cursorHookExecution = cursorHookCandidate;
}
const terminalWithoutObserver: GoNoGo = !terminalOutcome.timedOut && terminalOutcome.exitCode === 0 ? "GO" : "NO-GO";
const isolatedHarnessAuthority: GoNoGo = !isolationOutcome.timedOut && isolationOutcome.exitCode === 0 ? "GO" : "NO-GO";
const forkPinDryRun = verdictFromJson(forkPinOutcome, forkPinJson, "verdict");
const requiredForBpS2 = {
	lifecycleDecidability,
	terminalWithoutObserver,
	isolatedHarnessAuthority,
};
const bpS2Allowed = Object.values(requiredForBpS2).every(verdict => verdict === "GO");

const decision = {
	lifecycleDecidability,
	cursorPluginMechanism,
	cursorHookExecution,
	terminalWithoutObserver,
	isolatedHarnessAuthority,
	forkPinDryRun,
	bpS2Allowed,
	requiredForBpS2: Object.keys(requiredForBpS2),
	explanations: {
		lifecycleDecidability: explainCommandVerdict(
			"the independent production-emitter mutation battery",
			lifecycleDecidability,
			mutationOutcome,
			mutationJson,
		),
		cursorPluginMechanism: explainCommandVerdict(
			"the Cursor local plugin mechanism",
			cursorPluginMechanism,
			cursorOutcome,
			cursorJson,
		),
		cursorHookExecution:
			cursorHookExecution === "UNPROVEN"
				? "Authenticated Cursor hook execution was deliberately not attempted; mechanism and live execution remain separate."
				: explainCommandVerdict("Cursor hook execution", cursorHookExecution, cursorOutcome, cursorJson),
		terminalWithoutObserver: explainCommandVerdict(
			"terminal reconstruction without an attached observer",
			terminalWithoutObserver,
			terminalOutcome,
		),
		isolatedHarnessAuthority: explainCommandVerdict(
			"isolated real lifecycle authority",
			isolatedHarnessAuthority,
			isolationOutcome,
		),
		forkPinDryRun: explainCommandVerdict("the fork pin dry run", forkPinDryRun, forkPinOutcome, forkPinJson),
		bpS2Allowed: bpS2Allowed
			? "Every required BP-S2 progression field is GO."
			: `BP-S2 is blocked by: ${Object.entries(requiredForBpS2)
					.filter(([, verdict]) => verdict !== "GO")
					.map(([field]) => field)
					.join(", ")}.`,
	},
	evidence: {
		cursorPlugin: commandEvidence(cursorOutcome, cursorJson),
		forkPinDryRun: {
			verdict: forkPinDryRun,
			...commandEvidence(forkPinOutcome, forkPinJson),
		},
		mutationProbe: commandEvidence(mutationOutcome, mutationJson),
		terminalWithoutObserver: {
			command: terminalOutcome.command,
			exitCode: terminalOutcome.exitCode,
			timedOut: terminalOutcome.timedOut,
		},
		isolatedHarnessAuthority: {
			command: isolationOutcome.command,
			exitCode: isolationOutcome.exitCode,
			timedOut: isolationOutcome.timedOut,
		},
	},
	notExercised: [
		"provider requests",
		"authenticated Cursor hook execution",
		"live OMP configuration",
		"omp-core lock edits",
		"install or restart",
		"commit, push, or merge",
		"astaroth or DMG operations",
	],
};

if (args.json) {
	console.log(JSON.stringify(decision));
} else {
	console.log(`BP-S2 allowed: ${bpS2Allowed ? "YES" : "NO"}`);
	for (const [field, verdict] of Object.entries({
		lifecycleDecidability,
		cursorPluginMechanism,
		cursorHookExecution,
		terminalWithoutObserver,
		isolatedHarnessAuthority,
		forkPinDryRun,
	})) {
		console.log(`${field}: ${verdict}`);
	}
	console.log(JSON.stringify(decision, null, 2));
}
process.exitCode = bpS2Allowed ? 0 : 1;
