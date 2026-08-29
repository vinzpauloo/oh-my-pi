import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentLifecycleTransition,
	AgentPublicIdentity,
} from "@oh-my-pi/pi-coding-agent/registry/agent-public-contract";
import {
	BP_S1_OPEN_CHILD_ID,
	BP_S1_RESTRICTED_CHILD_ID,
	BP_S1_ROOT_ID,
	type BpS1Harness,
	createBpS1Harness,
	identityDigest,
	settleWithin,
	snapshotOf,
	stableIdentityDigest,
	transitionDigest,
	waitForState,
	waitForTransition,
} from "./helpers/bp-s1-harness";

const TEST_ROOT = import.meta.dir;
const PACKAGE_ROOT = path.resolve(TEST_ROOT, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

const HOOK_COMMAND_CONTEXT_KEYS = [
	"abort",
	"branch",
	"cwd",
	"hasQueuedMessages",
	"hasUI",
	"isIdle",
	"model",
	"modelRegistry",
	"navigateTree",
	"newSession",
	"sessionManager",
	"ui",
	"waitForIdle",
] as const;

async function withHarness(run: (harness: BpS1Harness) => Promise<void>): Promise<void> {
	const harness = await createBpS1Harness();
	try {
		await run(harness);
	} finally {
		await harness.close();
	}
}

function transitionsFor(harness: BpS1Harness, agentId: string): AgentLifecycleTransition[] {
	return harness.transitions.filter(transition => transition.agent.agentId === agentId);
}

function expectStableIdentity(before: AgentPublicIdentity, after: AgentPublicIdentity): void {
	expect(stableIdentityDigest(after)).toBe(stableIdentityDigest(before));
}

describe("BP-S1 lifecycle adjacency proofs", () => {
	it("terminal without observer and resubscribe", async () => {
		await withHarness(async harness => {
			const recordedBeforeDetach = harness.transitions.length;
			harness.detachObserver();
			await harness.abort(BP_S1_OPEN_CHILD_ID);
			await harness.release(BP_S1_RESTRICTED_CHILD_ID);
			expect(harness.transitions).toHaveLength(recordedBeforeDetach);

			const resumedStream: AgentLifecycleTransition[] = [];
			const resumed = harness.observer.subscribe(event => resumedStream.push(event));
			try {
				const byId = Object.fromEntries(resumed.snapshot.agents.map(entry => [entry.agent.agentId, entry]));
				expect(byId[BP_S1_OPEN_CHILD_ID]).toMatchObject({ state: "aborted", terminal: true, revivable: false });
				expect(byId[BP_S1_RESTRICTED_CHILD_ID]).toMatchObject({
					state: "released",
					terminal: true,
					revivable: false,
				});
				expect(resumed.snapshot.agents.filter(entry => entry.agent.agentId === BP_S1_OPEN_CHILD_ID)).toHaveLength(
					1,
				);
				expect(
					resumed.snapshot.agents.filter(entry => entry.agent.agentId === BP_S1_RESTRICTED_CHILD_ID),
				).toHaveLength(1);
				expect(resumedStream).toEqual([]);
			} finally {
				resumed.unsubscribe();
			}
		});
	});

	it("lifecycle ordering races: park-cancel no-op, duplicate revive, revive-abort", async () => {
		await withHarness(async harness => {
			const raceStream: AgentLifecycleTransition[] = [];
			const subscription = harness.observer.subscribe(event => raceStream.push(event));
			try {
				const park = harness.lifecycle.park(BP_S1_OPEN_CHILD_ID);
				const wake = harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID);
				const [, kept] = await settleWithin(Promise.all([park, wake]), 2_000, "same-tick park/wake");
				const attached = harness.refSession(BP_S1_OPEN_CHILD_ID);
				if (!attached) throw new Error(`${BP_S1_OPEN_CHILD_ID} lost its live session during park cancellation`);
				expect(kept).toBe(attached);
				expect(raceStream.filter(event => event.agent.agentId === BP_S1_OPEN_CHILD_ID)).toEqual([]);

				await harness.park(BP_S1_OPEN_CHILD_ID);
				const revivedPending = waitForTransition(
					harness.observer,
					event => event.agent.agentId === BP_S1_OPEN_CHILD_ID && event.transition === "revived",
				);
				const [first, second] = await settleWithin(
					Promise.all([
						harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID),
						harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID),
					]),
					2_000,
					"duplicate revive",
				);
				await revivedPending;
				expect(first).toBe(second);
				expect(
					tracesFor(raceStream, BP_S1_OPEN_CHILD_ID).filter(event => event.transition === "revived"),
				).toHaveLength(1);

				await harness.park(BP_S1_OPEN_CHILD_ID);
				const abortedPending = waitForTransition(
					harness.observer,
					event => event.agent.agentId === BP_S1_OPEN_CHILD_ID && event.transition === "aborted",
				);
				const revival = harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID);
				const abort = harness.lifecycle.release(BP_S1_OPEN_CHILD_ID, undefined, { tombstone: true });
				const [revivalResult, abortResult] = await settleWithin(
					Promise.allSettled([revival, abort]),
					2_000,
					"revive/abort race",
				);
				await abortedPending;
				expect(revivalResult.status).toBe("rejected");
				expect(abortResult).toMatchObject({ status: "fulfilled", value: true });
				expect(
					tracesFor(raceStream, BP_S1_OPEN_CHILD_ID).filter(event => event.transition === "revived"),
				).toHaveLength(1);

				const digests = raceStream.map(transitionDigest);
				expect(new Set(digests).size).toBe(digests.length);
				for (let index = 1; index < raceStream.length; index++) {
					expect(raceStream[index].version).toBe(raceStream[index - 1].version + 1);
				}
			} finally {
				subscription.unsubscribe();
			}
		});
	});

	it("revive terminal abort negatives", async () => {
		await withHarness(async harness => {
			const beforeAbort = harness.identity(BP_S1_OPEN_CHILD_ID);
			await harness.park(BP_S1_OPEN_CHILD_ID);
			await harness.abort(BP_S1_OPEN_CHILD_ID);
			const aborted = harness.currentSnapshot().agents.find(entry => entry.agent.agentId === BP_S1_OPEN_CHILD_ID);
			expect(aborted).toMatchObject({ state: "aborted", terminal: true, revivable: false });
			expectStableIdentity(beforeAbort, aborted!.agent);
			await expect(harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID)).rejects.toThrow(
				/cannot be revived|terminal|aborted/,
			);

			await harness.release(BP_S1_RESTRICTED_CHILD_ID);
			await expect(harness.lifecycle.ensureLive(BP_S1_RESTRICTED_CHILD_ID)).rejects.toThrow(
				/Unknown agent|released/,
			);
			expect(transitionsFor(harness, BP_S1_OPEN_CHILD_ID).at(-1)).toMatchObject({
				transition: "aborted",
				reason: "hard-abort",
				terminal: true,
			});
		});
	});

	it("metadata only privacy", async () => {
		await withHarness(async harness => {
			const publicSnapshot = harness.currentSnapshot();
			const serialized = JSON.stringify(publicSnapshot);
			expect(serialized).not.toContain(harness.tempDir.path());
			expect(serialized).not.toContain("test-key");
			expect(serialized).not.toContain("sessionFile");
			expect(serialized).not.toContain("transcript");
			expect(serialized).not.toContain("registry");
			for (const entry of publicSnapshot.agents) {
				expect(Object.keys(entry).sort()).toEqual(["agent", "revivable", "sequence", "state", "terminal"]);
				expect(entry.agent.inspectLocator).toBe(`history://${entry.agent.agentId}`);
				expect(path.isAbsolute(entry.agent.inspectLocator)).toBe(false);
			}

			const tombstonePath = harness.tombstonePath(BP_S1_OPEN_CHILD_ID);
			await harness.abort(BP_S1_OPEN_CHILD_ID);
			const mode = (await fs.stat(tombstonePath)).mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	it("isolated lifecycle authority and real emitter", async () => {
		const source = await Bun.file(path.join(TEST_ROOT, "helpers", "bp-s1-harness.ts")).text();
		expect(source).toContain("new AgentRegistry()");
		expect(source).toContain("new AgentLifecycleManager(registry)");
		expect(source).toContain("createMockModel(");
		expect(source).toContain("createAgentSession(");
		expect(source).toContain("runSubprocess(");
		expect(source).toContain("waitForTransition(");
		expect(source).not.toContain("AgentRegistry.global(");
		expect(source).not.toContain("AgentLifecycleManager.global(");
		expect(source).not.toContain("Bun.sleep(");
		expect(source).not.toContain("fetch(");
		expect(source).not.toMatch(/\.commit(?:Registered|Parked|Revived|Released|Aborted)\(/);

		await withHarness(async harness => {
			expect(harness.lifecycle.manages(harness.registry)).toBe(true);
			expect(harness.transitions.map(event => event.transition)).toEqual([
				"registered",
				"registered",
				"registered",
				"parked",
			]);
		});
	});

	it("hook command lineage boundary", async () => {
		await withHarness(async harness => {
			expect(harness.hookCommandContexts).toHaveLength(1);
			const context = harness.hookCommandContexts[0];
			if (!context) throw new Error("real hook command did not expose a context");
			expect(context.contextKeys).toEqual(HOOK_COMMAND_CONTEXT_KEYS);
			expect(context.hasAgent).toBe(false);
			expect(context.hasAgentLifecycle).toBe(false);
		});
	});

	it("all extension contexts carry identity", async () => {
		await withHarness(async harness => {
			await harness.park(BP_S1_OPEN_CHILD_ID);
			const rootCaptures = harness.captures.filter(capture => capture.identity.agentId === BP_S1_ROOT_ID);
			const childCaptures = harness.captures.filter(capture => capture.identity.agentId === BP_S1_OPEN_CHILD_ID);
			for (const captures of [rootCaptures, childCaptures]) {
				const phases = new Set(captures.map(capture => capture.phase));
				for (const phase of [
					"session_start",
					"before_agent_start",
					"agent_start",
					"turn_start",
					"tool_call",
					"tool_result",
					"turn_end",
					"agent_end",
				]) {
					expect(phases.has(phase)).toBe(true);
				}
				const expected = identityDigest(captures[0].identity);
				for (const capture of captures) {
					expect(identityDigest(capture.identity)).toBe(expected);
					expect(capture.identityFrozen).toBe(true);
					expect(capture.observerFrozen).toBe(true);
					expect(capture.snapshotFrozen).toBe(true);
				}
			}
			expect(new Set(childCaptures.map(capture => capture.phase)).has("session_shutdown")).toBe(true);
		});
	});

	it("hook and custom tool identity parity", async () => {
		await withHarness(async harness => {
			for (const agentId of [BP_S1_ROOT_ID, BP_S1_OPEN_CHILD_ID]) {
				const hook = harness.captures.find(
					capture => capture.identity.agentId === agentId && capture.phase === "before_agent_start",
				);
				const tool = harness.captures.find(
					capture => capture.identity.agentId === agentId && capture.phase === "extension_tool",
				);
				if (!hook) throw new Error(`${agentId} did not expose identity through before_agent_start`);
				if (!tool) throw new Error(`${agentId} did not expose identity through the extension tool`);
				expect(hook).toBeDefined();
				expect(tool).toBeDefined();
				expect(identityDigest(tool.identity)).toBe(identityDigest(hook.identity));
				expect(tool.observer).toBe(hook.observer);
			}
		});

		const [hookDocs, customToolDocs] = await Promise.all([
			Bun.file(path.join(REPO_ROOT, "docs", "hooks.md")).text(),
			Bun.file(path.join(REPO_ROOT, "docs", "custom-tools.md")).text(),
		]);
		expect(hookDocs).toContain("HookContext");
		expect(hookDocs).toContain("explicitly lineage-blind");
		expect(hookDocs).toContain("does not expose `ctx.agent` or `ctx.agentLifecycle`");
		expect(customToolDocs).toContain("CustomToolContext");
		expect(customToolDocs).toContain("explicitly lineage-blind");
		expect(customToolDocs).toContain("does not expose `ctx.agent` or `ctx.agentLifecycle`");
	});

	it("spawn revive release abort producer paths", async () => {
		await withHarness(async harness => {
			await harness.park(BP_S1_OPEN_CHILD_ID);
			await harness.revive(BP_S1_OPEN_CHILD_ID);
			await harness.release(BP_S1_OPEN_CHILD_ID);
			await harness.abort(BP_S1_RESTRICTED_CHILD_ID);

			expect(transitionsFor(harness, BP_S1_OPEN_CHILD_ID).map(event => event.transition)).toEqual([
				"registered",
				"parked",
				"revived",
				"released",
			]);
			expect(transitionsFor(harness, BP_S1_RESTRICTED_CHILD_ID).map(event => event.transition)).toEqual([
				"registered",
				"parked",
				"aborted",
			]);
			for (const events of [
				transitionsFor(harness, BP_S1_OPEN_CHILD_ID),
				transitionsFor(harness, BP_S1_RESTRICTED_CHILD_ID),
			]) {
				expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
			}
		});
	});

	it("lifecycle edge matrix", async () => {
		await withHarness(async harness => {
			const before = harness.identity(BP_S1_OPEN_CHILD_ID);
			await harness.park(BP_S1_OPEN_CHILD_ID);
			await Bun.write(harness.sessionFile(BP_S1_OPEN_CHILD_ID), "");
			await harness.revive(BP_S1_OPEN_CHILD_ID);
			const reminted = harness.identity(BP_S1_OPEN_CHILD_ID);
			expectStableIdentity(before, reminted);
			expect(reminted.currentSessionId).not.toBe(before.currentSessionId);

			await harness.release(BP_S1_RESTRICTED_CHILD_ID);
			await harness.abort(BP_S1_OPEN_CHILD_ID);
			await harness.disposeRoot();
			const entries = Object.fromEntries(
				harness.currentSnapshot().agents.map(entry => [entry.agent.agentId, entry]),
			);
			expect(entries[BP_S1_RESTRICTED_CHILD_ID]).toMatchObject({ state: "released", terminal: true });
			expect(entries[BP_S1_OPEN_CHILD_ID]).toMatchObject({ state: "aborted", terminal: true });
			expect(entries[BP_S1_ROOT_ID]).toMatchObject({ state: "released", terminal: true });
			expect(transitionsFor(harness, BP_S1_ROOT_ID).at(-1)?.reason).toBe("process-shutdown");
		});
	});

	it("versioned additive contract", async () => {
		await withHarness(async harness => {
			const snapshot = harness.currentSnapshot();
			expect(snapshot.schemaVersion).toBe(1);
			expect(snapshot.version).toBe(4);
			for (const entry of snapshot.agents) expect(entry.agent.schemaVersion).toBe(1);
			const pending = waitForTransition(
				harness.observer,
				event => event.agent.agentId === BP_S1_OPEN_CHILD_ID && event.transition === "parked",
			);
			await harness.lifecycle.park(BP_S1_OPEN_CHILD_ID);
			const transition = await pending;
			expect(transition.schemaVersion).toBe(1);
			expect(transition.version).toBe(snapshot.version + 1);
			expect(transition.sequence).toBe(2);
		});
	});

	it("real emitter and state waits", async () => {
		await withHarness(async harness => {
			const parked = waitForState(harness.observer, BP_S1_OPEN_CHILD_ID, "parked");
			await harness.lifecycle.park(BP_S1_OPEN_CHILD_ID);
			expect(await parked).toMatchObject({ state: "parked", sequence: 2, terminal: false });

			const revived = waitForState(harness.observer, BP_S1_OPEN_CHILD_ID, "active");
			await harness.lifecycle.ensureLive(BP_S1_OPEN_CHILD_ID);
			expect(await revived).toMatchObject({ state: "active", sequence: 3, terminal: false });
			expect(transitionsFor(harness, BP_S1_OPEN_CHILD_ID).map(transitionDigest)).toHaveLength(3);
		});
	});

	it("root teardown and terminal budget", async () => {
		await withHarness(async harness => {
			const terminal = waitForTransition(
				harness.observer,
				event => event.agent.agentId === BP_S1_ROOT_ID && event.transition === "released",
			);
			await settleWithin(harness.disposeRoot(), 2_000, "root teardown");
			expect(await terminal).toMatchObject({
				from: "active",
				to: "released",
				reason: "process-shutdown",
				terminal: true,
				revivable: false,
			});
			const snapshot = snapshotOf(harness.observer);
			expect(snapshot.agents.every(entry => entry.terminal)).toBe(true);
		});
	});

	it("public contract docs and examples: public docs examples", async () => {
		const [docs, example, contract] = await Promise.all([
			Bun.file(path.join(REPO_ROOT, "docs", "extensions.md")).text(),
			Bun.file(path.join(PACKAGE_ROOT, "examples", "extensions", "api-demo.ts")).text(),
			Bun.file(path.join(PACKAGE_ROOT, "src", "registry", "agent-public-contract.ts")).text(),
		]);
		expect(docs).toContain("AgentPublicIdentity");
		expect(docs).toContain("AgentLifecycleObserver");
		expect(docs).toContain("schemaVersion: 1");
		expect(docs).toContain("opaque locator URI");
		expect(docs).toContain("unknown future transition");
		expect(example).toContain("ctx.agentLifecycle.subscribe");
		expect(example).toContain("unknown-transition:");
		expect(example).toMatch(/default:[\s\S]*unknown-transition/);
		expect(contract).toContain("readonly schemaVersion: 1");
		expect(contract).toContain("readonly currentSessionId: string");
	});
});

function tracesFor(events: readonly AgentLifecycleTransition[], agentId: string): AgentLifecycleTransition[] {
	return events.filter(event => event.agent.agentId === agentId);
}
