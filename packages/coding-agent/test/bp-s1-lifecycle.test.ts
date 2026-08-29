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
	snapshotOf,
	stableIdentityDigest,
	transitionDigest,
	waitForTransition,
} from "./helpers/bp-s1-harness";

const AGENT_LIFECYCLE_SOURCE = path.resolve(import.meta.dir, "../src/registry/agent-lifecycle.ts");

const PUBLIC_IDENTITY_KEYS = [
	"agentId",
	"currentSessionId",
	"inspectLocator",
	"kind",
	"label",
	"parentAgentId",
	"rootAgentId",
	"schemaVersion",
] as const;

async function withHarness(run: (harness: BpS1Harness) => Promise<void>): Promise<void> {
	const harness = await createBpS1Harness();
	try {
		await run(harness);
	} finally {
		await harness.close();
	}
}

function identitiesById(harness: BpS1Harness): Record<string, AgentPublicIdentity> {
	return Object.fromEntries(harness.currentSnapshot().agents.map(entry => [entry.agent.agentId, entry.agent]));
}

function transitionsFor(harness: BpS1Harness, agentId: string): AgentLifecycleTransition[] {
	return harness.transitions.filter(transition => transition.agent.agentId === agentId);
}

describe("BP-S1 real SDK lifecycle and identity proof", () => {
	it("real root plus two children", async () => {
		await withHarness(async harness => {
			const identities = identitiesById(harness);
			expect(Object.keys(identities).sort()).toEqual(
				[BP_S1_OPEN_CHILD_ID, BP_S1_RESTRICTED_CHILD_ID, BP_S1_ROOT_ID].sort(),
			);
			expect(harness.concurrentChildDispatches).toEqual(new Set([BP_S1_OPEN_CHILD_ID, BP_S1_RESTRICTED_CHILD_ID]));
			expect([...harness.childResults.values()].map(result => result.exitCode)).toEqual([0, 0]);
			expect(new Set(Object.values(identities).map(identity => identity.currentSessionId)).size).toBe(3);
			expect([...new Set(Object.values(identities).map(identity => identity.kind))].toSorted()).toEqual([
				"main",
				"sub",
			]);
			expect(identities[BP_S1_ROOT_ID]).toMatchObject({
				agentId: BP_S1_ROOT_ID,
				rootAgentId: BP_S1_ROOT_ID,
				parentAgentId: null,
				kind: "main",
			});
			for (const childId of [BP_S1_OPEN_CHILD_ID, BP_S1_RESTRICTED_CHILD_ID]) {
				expect(identities[childId]).toMatchObject({
					agentId: childId,
					rootAgentId: BP_S1_ROOT_ID,
					parentAgentId: BP_S1_ROOT_ID,
					kind: "sub",
					inspectLocator: `history://${childId}`,
				});
			}
			expect(harness.mock.calls.length).toBeGreaterThanOrEqual(5);
		});
	});

	it("public immutable identity contract", async () => {
		await withHarness(async harness => {
			for (const identity of Object.values(identitiesById(harness))) {
				expect(Object.keys(identity).sort()).toEqual([...PUBLIC_IDENTITY_KEYS]);
				expect(Object.isFrozen(identity)).toBe(true);
				expect(Reflect.set(identity, "label", "mutated")).toBe(false);
				expect(identity.schemaVersion).toBe(1);
				expect(identity.inspectLocator).toBe(`history://${identity.agentId}`);
				expect(identity).not.toHaveProperty("session");
				expect(identity).not.toHaveProperty("registry");
				expect(identity).not.toHaveProperty("transcript");
				expect(identity).not.toHaveProperty("cwd");
				expect(identity).not.toHaveProperty("pid");
				expect(identity).not.toHaveProperty("pane");
				expect(identity).not.toHaveProperty("nonce");
			}
		});
	});

	it("root lifecycle snapshot and stream", async () => {
		await withHarness(async harness => {
			const observed: AgentLifecycleTransition[] = [];
			const subscription = harness.observer.subscribe(event => observed.push(event));
			try {
				expect(subscription.snapshot.rootAgentId).toBe(BP_S1_ROOT_ID);
				expect(subscription.snapshot.agents.map(entry => entry.agent.agentId).sort()).toEqual(
					[BP_S1_OPEN_CHILD_ID, BP_S1_RESTRICTED_CHILD_ID, BP_S1_ROOT_ID].sort(),
				);
				expect(Object.isFrozen(subscription.snapshot)).toBe(true);
				expect(Object.isFrozen(subscription.snapshot.agents)).toBe(true);

				await harness.park(BP_S1_OPEN_CHILD_ID);
				expect(harness.refSession(BP_S1_OPEN_CHILD_ID)).toBeNull();
				await harness.revive(BP_S1_OPEN_CHILD_ID);
				expect(observed.map(transitionDigest)).toEqual([
					expect.stringContaining(`${BP_S1_OPEN_CHILD_ID}:2:parked`),
					expect.stringContaining(`${BP_S1_OPEN_CHILD_ID}:3:revived`),
				]);
				expect(observed[0].version).toBe(subscription.snapshot.version + 1);
				expect(observed[1].version).toBe(observed[0].version + 1);
			} finally {
				subscription.unsubscribe();
			}
		});
	});

	it("root observer inheritance and isolation", async () => {
		await withHarness(async harness => {
			const snapshot = snapshotOf(harness.observer);
			const entries = Object.fromEntries(snapshot.agents.map(entry => [entry.agent.agentId, entry]));
			expect(entries[BP_S1_ROOT_ID].agent.rootAgentId).toBe(BP_S1_ROOT_ID);
			expect(entries[BP_S1_OPEN_CHILD_ID].agent.rootAgentId).toBe(BP_S1_ROOT_ID);
			expect(entries[BP_S1_RESTRICTED_CHILD_ID].agent.rootAgentId).toBe(BP_S1_ROOT_ID);
			expect(entries[BP_S1_OPEN_CHILD_ID].agent.parentAgentId).toBe(BP_S1_ROOT_ID);
			expect(entries[BP_S1_RESTRICTED_CHILD_ID].agent.parentAgentId).toBe(BP_S1_ROOT_ID);
			expect(entries[BP_S1_OPEN_CHILD_ID]).not.toBe(entries[BP_S1_RESTRICTED_CHILD_ID]);
			expect(entries[BP_S1_OPEN_CHILD_ID].agent.currentSessionId).not.toBe(
				entries[BP_S1_RESTRICTED_CHILD_ID].agent.currentSessionId,
			);

			const openCapture = harness.captures.find(capture => capture.identity.agentId === BP_S1_OPEN_CHILD_ID);
			expect(openCapture?.observer).toBe(harness.observer);
			expect(harness.captures.some(capture => capture.identity.agentId === BP_S1_RESTRICTED_CHILD_ID)).toBe(false);
			expect(harness.transitions.filter(event => event.transition === "registered")).toHaveLength(3);
		});
	});

	it("park dispose cold revive", async () => {
		await withHarness(async harness => {
			const beforeIdentity = harness.identity(BP_S1_OPEN_CHILD_ID);
			const beforeSession = harness.refSession(BP_S1_OPEN_CHILD_ID);
			await harness.park(BP_S1_OPEN_CHILD_ID);
			const parked = harness.currentSnapshot().agents.find(entry => entry.agent.agentId === BP_S1_OPEN_CHILD_ID);
			expect(parked).toMatchObject({ state: "parked", sequence: 2, revivable: true, terminal: false });
			expect(harness.refSession(BP_S1_OPEN_CHILD_ID)).toBeNull();

			const revivedSession = await harness.revive(BP_S1_OPEN_CHILD_ID);
			expect(revivedSession).not.toBe(beforeSession);
			expect(identityDigest(harness.identity(BP_S1_OPEN_CHILD_ID))).toBe(identityDigest(beforeIdentity));
			const childTransitions = transitionsFor(harness, BP_S1_OPEN_CHILD_ID);
			expect(childTransitions.filter(event => event.transition === "parked")).toHaveLength(1);
			expect(childTransitions.filter(event => event.transition === "revived")).toHaveLength(1);
		});
	});

	it("isolated parked teardown", async () => {
		await withHarness(async harness => {
			const isolatedBefore = harness
				.currentSnapshot()
				.agents.find(entry => entry.agent.agentId === BP_S1_RESTRICTED_CHILD_ID);
			expect(isolatedBefore).toMatchObject({
				state: "parked",
				revivable: false,
				terminal: false,
			});
			expect(harness.refSession(BP_S1_RESTRICTED_CHILD_ID)).toBeNull();

			await harness.disposeRoot();
			expect(harness.registry.get(BP_S1_OPEN_CHILD_ID)).toBeUndefined();
			expect(harness.registry.get(BP_S1_RESTRICTED_CHILD_ID)).toBeUndefined();

			expect(harness.registry.get(BP_S1_ROOT_ID)).toBeUndefined();
			const after = Object.fromEntries(harness.currentSnapshot().agents.map(entry => [entry.agent.agentId, entry]));
			expect(after[BP_S1_RESTRICTED_CHILD_ID]).toMatchObject({
				state: "released",
				revivable: false,
				terminal: true,
			});
			const releaseOrder = harness.transitions
				.filter(transition => transition.transition === "released")
				.map(transition => transition.agent.agentId);
			expect(releaseOrder.at(-1)).toBe(BP_S1_ROOT_ID);
			expect(releaseOrder.slice(0, -1).toSorted()).toEqual(
				[BP_S1_OPEN_CHILD_ID, BP_S1_RESTRICTED_CHILD_ID].toSorted(),
			);
		});
	});

	it("root and child lifecycle authority", async () => {
		await withHarness(async harness => {
			await harness.park(BP_S1_OPEN_CHILD_ID);
			await harness.revive(BP_S1_OPEN_CHILD_ID);
			await harness.release(BP_S1_OPEN_CHILD_ID);
			await harness.abort(BP_S1_RESTRICTED_CHILD_ID);
			await harness.disposeRoot();

			const snapshot = harness.currentSnapshot();
			const entries = Object.fromEntries(snapshot.agents.map(entry => [entry.agent.agentId, entry]));
			expect(entries[BP_S1_OPEN_CHILD_ID]).toMatchObject({ state: "released", revivable: false, terminal: true });
			expect(entries[BP_S1_RESTRICTED_CHILD_ID]).toMatchObject({
				state: "aborted",
				revivable: false,
				terminal: true,
			});
			expect(entries[BP_S1_ROOT_ID]).toMatchObject({ state: "released", revivable: false, terminal: true });
			expect(transitionsFor(harness, BP_S1_OPEN_CHILD_ID).map(event => event.transition)).toEqual([
				"registered",
				"parked",
				"revived",
				"released",
			]);
			expect(transitionsFor(harness, BP_S1_RESTRICTED_CHILD_ID).at(-1)).toMatchObject({
				transition: "aborted",
				reason: "hard-abort",
			});
			expect(transitionsFor(harness, BP_S1_ROOT_ID).at(-1)).toMatchObject({
				transition: "released",
				reason: "process-shutdown",
			});
		});
	});

	it("incidental metadata identity negative", async () => {
		await withHarness(async harness => {
			const child = harness.identity(BP_S1_OPEN_CHILD_ID);
			const publicBytes = identityDigest(child);
			expect(publicBytes).not.toContain(harness.tempDir.path());
			expect(publicBytes).not.toContain(String(process.pid));
			expect(publicBytes).not.toContain("pane");
			expect(publicBytes).not.toContain("nonce");
			await expect(
				harness.createConflictingChild(`pid-${process.pid}`, `${harness.tempDir.path()}-derived-label`),
			).rejects.toThrow(/identity changed|already owned/);
			expect(identityDigest(harness.identity(BP_S1_OPEN_CHILD_ID))).toBe(identityDigest(child));
		});
	});

	it("lineage authority isolation", async () => {
		await withHarness(async harness => {
			const before = identitiesById(harness);
			await expect(
				harness.createConflictingChild(BP_S1_RESTRICTED_CHILD_ID, "impersonated sibling"),
			).rejects.toThrow(/identity changed|already owned/);
			expect(Reflect.set(before[BP_S1_OPEN_CHILD_ID], "parentAgentId", BP_S1_RESTRICTED_CHILD_ID)).toBe(false);
			const after = identitiesById(harness);
			expect(stableIdentityDigest(after[BP_S1_ROOT_ID])).toBe(stableIdentityDigest(before[BP_S1_ROOT_ID]));
			expect(stableIdentityDigest(after[BP_S1_OPEN_CHILD_ID])).toBe(
				stableIdentityDigest(before[BP_S1_OPEN_CHILD_ID]),
			);
			expect(stableIdentityDigest(after[BP_S1_RESTRICTED_CHILD_ID])).toBe(
				stableIdentityDigest(before[BP_S1_RESTRICTED_CHILD_ID]),
			);
		});
	});

	it("non-authoritative stop signals", async () => {
		await withHarness(async harness => {
			expect(
				harness.captures.some(
					capture => capture.identity.agentId === BP_S1_ROOT_ID && capture.phase === "agent_end",
				),
			).toBe(true);
			expect(
				harness.captures.some(
					capture => capture.identity.agentId === BP_S1_OPEN_CHILD_ID && capture.phase === "agent_end",
				),
			).toBe(true);
			expect(harness.taskLifecycleSignals.some(signal => signal.status === "completed")).toBe(true);
			expect(harness.currentSnapshot().agents.every(entry => !entry.terminal)).toBe(true);

			const parkedPending = waitForTransition(
				harness.observer,
				event => event.agent.agentId === BP_S1_OPEN_CHILD_ID && event.transition === "parked",
			);
			await harness.lifecycle.park(BP_S1_OPEN_CHILD_ID);
			const parked = await parkedPending;
			expect(parked).toMatchObject({ terminal: false, revivable: true, reason: "idle-timeout" });
			expect(
				harness.captures.some(
					capture => capture.identity.agentId === BP_S1_OPEN_CHILD_ID && capture.phase === "session_shutdown",
				),
			).toBe(true);
			expect(transitionsFor(harness, BP_S1_OPEN_CHILD_ID).some(event => event.terminal)).toBe(false);
		});

		const lifecycleSource = await fs.readFile(AGENT_LIFECYCLE_SOURCE, "utf8");
		expect(lifecycleSource).not.toMatch(/\bprocess\s*\./);
		expect(lifecycleSource).not.toMatch(/\bpid\b/i);
	});
});
