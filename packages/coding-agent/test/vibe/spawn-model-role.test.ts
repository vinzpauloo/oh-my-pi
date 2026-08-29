/**
 * Contract: a vibe worker's spawn options carry the pre-expansion model role.
 *
 * `#resolveWorker` expands the bundled worker's role alias (`good` -> `task` ->
 * `@good_worker`, `fast` -> `sonic` -> `@fast_worker`) into concrete patterns,
 * so the role survives only as a separate field forwarded across `ResolvedVibeWorker` ->
 * `VibeRecord` -> `#buildSpawnOptions` -> `runSubprocess`. The executor keys the
 * child's inherited `retry.fallbackChains` entry off it; drop any link in that
 * chain and vibe children silently retry on the `default` role's chain.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExecutorOptions, FollowUpTurnOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type VibeCli, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function makeParentSession(
	settings: Settings,
	authority?: { registry: AgentRegistry; lifecycle: AgentLifecycleManager },
): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		getAgentId: () => "Main",
		agentRegistry: authority?.registry,
		agentLifecycle: authority ? () => authority.lifecycle : undefined,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(cli: VibeCli, settings: Settings): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings), { cli, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn model role", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the `good_worker` role behind the `good` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", good_worker: "xai/grok" },
			}),
		);

		expect(options.modelOverride).toEqual(["xai/grok"]);
		expect(options.modelRole).toBe("good_worker");
	});

	it("forwards the `fast_worker` role behind the `fast` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", fast_worker: "google/gemini" },
			}),
		);

		expect(options.modelOverride).toEqual(["google/gemini"]);
		expect(options.modelRole).toBe("fast_worker");
	});

	it("keeps the role identity when a per-agent model override replaces the alias", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", good_worker: "xai/grok" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["openai-codex/sol"]);
		expect(options.modelRole).toBeUndefined();
	});

	it("vibe private lifecycle authority", async () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/opus", good_worker: "xai/grok" },
		});
		const privateRegistry = new AgentRegistry();
		const privateLifecycle = new AgentLifecycleManager(privateRegistry);
		const globalRegistry = AgentRegistry.global();
		expect(globalRegistry.list()).toEqual([]);
		const parent = makeParentSession(settings, {
			registry: privateRegistry,
			lifecycle: privateLifecycle,
		});
		const manager = parent.asyncJobManager;
		if (!manager) throw new Error("Vibe parent did not retain its async job manager");
		const firstOptions = Promise.withResolvers<ExecutorOptions>();
		const followUpOptions = Promise.withResolvers<FollowUpTurnOptions>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			firstOptions.resolve(options);
			const workerRegistry = options.agentRegistry;
			if (!workerRegistry) throw new Error("Vibe first turn did not receive an agent registry");
			const ref = workerRegistry.register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "running",
			});
			expect(workerRegistry.setStatus(options.id, "idle", ref)).toBe(true);
			return {
				index: 0,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: options.task,
				exitCode: 0,
				output: "first done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUpOptions.resolve(options);
			return {
				index: 0,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: options.message,
				exitCode: 0,
				output: "follow-up done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});

		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(parent, { cli: "good", name: "Authority", prompt: "first" });
		const firstJob = manager.getJob(spawned.jobId);
		if (!firstJob) throw new Error("Vibe first turn did not register a job");
		await firstJob.promise;
		const first = await firstOptions.promise;
		expect(first.agentRegistry).toBe(privateRegistry);
		expect(first.agentLifecycle).toBe(privateLifecycle);
		const privateRef = privateRegistry.get(spawned.id);
		expect(privateRef?.status).toBe("idle");
		expect(globalRegistry.list()).toEqual([]);

		const sent = await registry.send(parent, { session: spawned.id, message: "follow up" });
		if (sent.mode !== "turn") throw new Error(`expected a follow-up turn, received ${sent.mode}`);
		if (!sent.jobId) throw new Error("Vibe follow-up did not return a job id");
		const followUpJob = manager.getJob(sent.jobId);
		if (!followUpJob) throw new Error("Vibe follow-up did not register a job");
		await followUpJob.promise;
		const followUp = await followUpOptions.promise;
		expect(followUp.agentRegistry).toBe(privateRegistry);
		expect(followUp.agentLifecycle).toBe(privateLifecycle);
		expect(registry.screens(parent, [spawned.id])).toEqual([
			expect.objectContaining({ id: spawned.id, state: "idle", turns: 2 }),
		]);

		const killed = await registry.kill(parent, spawned.id);
		expect(killed).toEqual({ id: spawned.id, cancelledTurn: false });
		expect(privateRegistry.get(spawned.id)).toBeUndefined();
		expect(globalRegistry.list()).toEqual([]);
	});
});
