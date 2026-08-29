#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const GATES = ["cursor-plugin", "fork-pin-dry-run"] as const;
type Gate = (typeof GATES)[number];
type Verdict = "GO" | "NO-GO";

interface CommandOutcome {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const HELP = `Usage: bun packages/coding-agent/scripts/bp-s1-capability-gates.ts --gate <gate> [--json]

Read-only BP-S1 capability probes.

Gates:
  cursor-plugin           Prove local --plugin-dir mechanism without a provider request
  fork-pin-dry-run        Report current fork and omp-core pin/deploy order; change nothing

Options:
  --json                  Emit machine-readable JSON
  -h, --help              Show this help
`;

function parseArgs(argv: string[]): { gate: Gate; json: boolean } | undefined {
	if (argv.includes("-h") || argv.includes("--help")) {
		if (argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
		console.log(HELP.trimEnd());
		return undefined;
	}
	let gate: Gate | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") {
			if (json) throw new Error("--json may be specified only once");
			json = true;
			continue;
		}
		if (arg === "--gate") {
			if (gate) throw new Error("--gate may be specified only once");
			const value = argv[index + 1];
			if (!value) throw new Error("--gate requires a value");
			if (!GATES.includes(value as Gate)) throw new Error(`unknown gate: ${value}`);
			gate = value as Gate;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	if (!gate) throw new Error("--gate is required");
	return { gate, json };
}

async function runCommand(
	command: string[],
	cwd: string,
	env?: Record<string, string>,
	timeoutMs = 10_000,
): Promise<CommandOutcome> {
	const process = Bun.spawn(command, {
		cwd,
		env: env ? { ...globalThis.process.env, ...env } : globalThis.process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPending = new Response(process.stdout).text();
	const stderrPending = new Response(process.stderr).text();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process.kill();
	}, timeoutMs);
	const exitCode = await process.exited;
	clearTimeout(timer);
	return {
		command,
		exitCode,
		stdout: await stdoutPending,
		stderr: await stderrPending,
		timedOut,
	};
}

async function git(repo: string, args: string[]): Promise<string> {
	const outcome = await runCommand(["git", ...args], repo);
	if (outcome.exitCode !== 0 || outcome.timedOut) {
		throw new Error(`git ${args.join(" ")} exited ${outcome.exitCode}: ${outcome.stderr.trim()}`);
	}
	return outcome.stdout.trim();
}

function compactCommand(outcome: CommandOutcome): Omit<CommandOutcome, "stdout" | "stderr"> & { output: string } {
	return {
		command: outcome.command,
		exitCode: outcome.exitCode,
		timedOut: outcome.timedOut,
		output: `${outcome.stdout}${outcome.stderr}`.trim(),
	};
}

async function cursorPluginGate(repoRoot: string) {
	const executable = Bun.which("cursor-agent");
	if (!executable) {
		return {
			gate: "cursor-plugin",
			verdict: "NO-GO" as Verdict,
			mechanism: "NO-GO" as Verdict,
			liveExecution: "UNPROVEN" as const,
			explanation: "cursor-agent is not on PATH; local plugin loading and path validation are not decidable.",
			providerRequest: false,
			configMutation: false,
			evidence: [],
		};
	}

	const help = await runCommand([executable, "--help"], repoRoot);
	const version = await runCommand([executable, "--version"], repoRoot);
	const missingPath = path.join(repoRoot, ".bp-s1-cursor-plugin-path-must-not-exist");
	let missingPathAbsent = false;
	try {
		await fs.lstat(missingPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") missingPathAbsent = true;
		else throw error;
	}

	let missingPathProbe: CommandOutcome | undefined;
	if (missingPathAbsent) {
		missingPathProbe = await runCommand(
			[
				executable,
				"--api-key",
				"bp-s1-local-capability-probe",
				"--endpoint",
				"http://127.0.0.1:9",
				"--plugin-dir",
				missingPath,
				"--print",
				"--mode",
				"ask",
				"bp-s1 local plugin path validation",
			],
			repoRoot,
			{
				CURSOR_API_KEY: "bp-s1-local-capability-probe",
				CURSOR_API_ENDPOINT: "http://127.0.0.1:9",
			},
		);
	}

	const helpText = `${help.stdout}${help.stderr}`;
	const validationText = missingPathProbe ? `${missingPathProbe.stdout}${missingPathProbe.stderr}` : "";
	const exposesPluginDir = help.exitCode === 0 && /--plugin-dir\s+<path>/.test(helpText);
	const repeatableFlagDocumented = /--plugin-dir\s+<path>[^\n]*can be specified multiple times/i.test(helpText);
	const rejectsMissingPath =
		missingPathProbe !== undefined &&
		!missingPathProbe.timedOut &&
		missingPathProbe.exitCode !== 0 &&
		validationText.includes(missingPath) &&
		/(plugin|directory|path)/i.test(validationText) &&
		/(does not exist|not exist|missing|invalid|ENOENT)/i.test(validationText);
	const mechanism: Verdict = exposesPluginDir && missingPathAbsent && rejectsMissingPath ? "GO" : "NO-GO";
	const failedReasons = [
		!exposesPluginDir ? "--help did not expose --plugin-dir <path>" : undefined,
		!missingPathAbsent ? `reserved missing-path fixture already exists: ${missingPath}` : undefined,
		!rejectsMissingPath ? "the loopback-only probe did not reject the absent plugin path locally" : undefined,
	].filter((reason): reason is string => Boolean(reason));

	return {
		gate: "cursor-plugin",
		verdict: mechanism,
		mechanism,
		repeatableFlagDocumented,
		liveExecution: "UNPROVEN" as const,
		explanation:
			mechanism === "GO"
				? "cursor-agent exposes process-scoped --plugin-dir and rejects an absent path before any provider can be reached; authenticated hook execution was deliberately not attempted."
				: `Cursor plugin mechanism is NO-GO: ${failedReasons.join("; ")}. Authenticated hook execution was deliberately not attempted.`,
		providerRequest: false,
		configMutation: false,
		safety: {
			endpoint: "http://127.0.0.1:9",
			credential: "fixed dummy value",
			missingPathCreated: false,
		},
		evidence: [
			compactCommand(version),
			compactCommand(help),
			...(missingPathProbe ? [compactCommand(missingPathProbe)] : []),
		],
	};
}

async function forkPinDryRunGate(repoRoot: string) {
	const ompCore = process.env.OMP_CORE_REPO ?? path.join(homedir(), "Desktop", "omp-core");
	try {
		const [head, branchValue, origin, lockText, readme, pinnedRule, installer] = await Promise.all([
			git(repoRoot, ["rev-parse", "HEAD"]),
			git(repoRoot, ["branch", "--show-current"]),
			git(repoRoot, ["remote", "get-url", "origin"]),
			fs.readFile(path.join(ompCore, "omp-fork.lock"), "utf8"),
			fs.readFile(path.join(ompCore, "README.md"), "utf8"),
			fs.readFile(path.join(ompCore, "config", "rules", "pinned-runtime.md"), "utf8"),
			fs.readFile(path.join(ompCore, "install.sh"), "utf8"),
		]);
		const lock = JSON.parse(lockText) as {
			repo?: unknown;
			branch?: unknown;
			commit?: unknown;
			version?: unknown;
		};
		if (
			typeof lock.repo !== "string" ||
			typeof lock.branch !== "string" ||
			typeof lock.commit !== "string" ||
			typeof lock.version !== "string"
		) {
			throw new Error("omp-fork.lock is missing repo, branch, commit, or version");
		}
		const sourceChecks = {
			lockIsCanonical: pinnedRule.includes("Advance OMP only by changing `omp-fork.lock`"),
			installerVerifiesBeforeConfig:
				installer.includes('"$REPO_DIR/tools/omp-binary.sh" verify --quiet') &&
				installer.includes('"$REPO_DIR/tools/check.ts"'),
			managedUpdateDocumented: readme.includes("git pull") && readme.includes("./install.sh"),
			restartAfterBinarySwitch: readme.includes("Restart running OMP sessions after any binary switch"),
		};
		const verdict: Verdict = Object.values(sourceChecks).every(Boolean) ? "GO" : "NO-GO";
		return {
			gate: "fork-pin-dry-run",
			verdict,
			explanation:
				verdict === "GO"
					? "Current fork and omp-core pin are readable, and the managed post-review deployment order is source-grounded. This dry-run did not create a future SHA or perform any deployment step."
					: "The current fork/pin facts were readable, but one or more managed deployment-order source anchors were absent.",
			currentFork: {
				repoRoot,
				origin,
				branch: branchValue || "(detached)",
				head,
			},
			ompCorePin: {
				path: path.join(ompCore, "omp-fork.lock"),
				repo: lock.repo,
				branch: lock.branch,
				commit: lock.commit,
				version: lock.version,
				headMatchesCurrentPin: head === lock.commit,
			},
			deployOrder: [
				"review and land the fork change",
				"change omp-core/omp-fork.lock to the reviewed fork commit",
				"run omp-core/install.sh",
				"run omp-core/tools/omp-binary.sh verify",
				"restart into a fresh OMP session",
			],
			sourceChecks,
			notExecuted: ["lock edit", "install", "binary verify", "restart", "commit", "push", "merge"],
		};
	} catch (error) {
		return {
			gate: "fork-pin-dry-run",
			verdict: "NO-GO" as Verdict,
			explanation: error instanceof Error ? error.message : String(error),
			notExecuted: ["lock edit", "install", "binary verify", "restart", "commit", "push", "merge"],
		};
	}
}

function printHuman(result: Record<string, unknown>): void {
	console.log(`${String(result.gate)}: ${String(result.verdict)}`);
	console.log(String(result.explanation));
	console.log(JSON.stringify(result, null, 2));
}

let args: { gate: Gate; json: boolean } | undefined;
try {
	args = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`bp-s1-capability-gates: ${error instanceof Error ? error.message : String(error)}`);
	console.error("Run with --help for usage.");
	process.exit(2);
}
if (!args) process.exit(0);

const repoRoot = path.resolve(import.meta.dir, "../../..");
let result: Record<string, unknown>;
try {
	result = args.gate === "cursor-plugin" ? await cursorPluginGate(repoRoot) : await forkPinDryRunGate(repoRoot);
} catch (error) {
	result = {
		gate: args.gate,
		verdict: "NO-GO",
		explanation: error instanceof Error ? error.message : String(error),
	};
}
if (args.json) console.log(JSON.stringify(result));
else printHuman(result);
process.exitCode = result.verdict === "GO" ? 0 : 1;
