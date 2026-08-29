/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import * as fs from "node:fs/promises";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { trackLateCleanup } from "../utils/late-cleanup";
import type {
	AgentLifecycleEntry,
	AgentLifecycleListener,
	AgentLifecycleObserver,
	AgentLifecycleReason,
	AgentLifecycleSnapshot,
	AgentLifecycleState,
	AgentLifecycleTransition,
	AgentLifecycleTransitionType,
	AgentPublicIdentity,
} from "./agent-public-contract";
import {
	type AgentRef,
	type AgentRefExpectation,
	AgentRegistry,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

export interface CreateAgentPublicIdentityInput {
	agentId: string;
	parentAgentId?: string;
	expectedRef?: AgentRef;
	currentSessionId: string;
	kind: AgentPublicIdentity["kind"];
	label: string;
}

interface PublicLifecycleRoot {
	readonly rootAgentId: string;
	version: number;
	entries: ReadonlyMap<string, AgentLifecycleEntry>;
	readonly listeners: Set<AgentLifecycleListener>;
	observer?: AgentLifecycleObserver;
}

interface PublicLifecycleBinding {
	readonly rootInstanceId: string;
}

export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

const AGENT_RELEASE_GRACE_MS = 5000;

async function persistAgentTombstone(sessionFile: string): Promise<void> {
	try {
		await fs.writeFile(getAgentTombstonePath(sessionFile), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: AgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSession>;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parks.clear();
			current.#releases.clear();
			current.#publicRoots.clear();
			current.#publicBindings.clear();
			current.#pendingPublicRoots.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	readonly #releases = new Map<string, AgentRef>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	readonly #publicRoots = new Map<string, PublicLifecycleRoot>();
	readonly #pendingPublicRoots = new Map<string, PublicLifecycleRoot>();
	readonly #publicBindings = new Map<AgentRef, PublicLifecycleBinding>();
	readonly #identityRootInstances = new WeakMap<AgentPublicIdentity, string>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;
	/** Set once {@link dispose} runs; blocks late revivals from adopting into a torn-down manager. */
	#disposed = false;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	createIdentity(input: CreateAgentPublicIdentityInput): AgentPublicIdentity {
		const expectedBinding = input.expectedRef ? this.#publicBindings.get(input.expectedRef) : undefined;
		const currentRef = this.#registry.get(input.agentId);
		const terminalBinding =
			!input.expectedRef && currentRef?.status === "aborted" ? this.#publicBindings.get(currentRef) : undefined;
		const tracked = expectedBinding ?? terminalBinding;
		if (tracked) {
			const entry = this.#publicRoots.get(tracked.rootInstanceId)?.entries.get(input.agentId);
			if (entry?.terminal) {
				throw new Error(`Agent "${input.agentId}" has a retained terminal lifecycle entry and cannot be reused.`);
			}
			if (entry) {
				if (
					entry.agent.parentAgentId !== (input.parentAgentId ?? null) ||
					entry.agent.kind !== input.kind ||
					entry.agent.label !== input.label
				) {
					throw new Error(`Agent "${input.agentId}" identity changed while its lifecycle entry is retained.`);
				}
				const identity = Object.freeze({ ...entry.agent, currentSessionId: input.currentSessionId });
				this.#identityRootInstances.set(identity, tracked.rootInstanceId);
				return identity;
			}
		}
		const parentRef = input.parentAgentId ? this.#registry.get(input.parentAgentId) : undefined;
		const parentBinding = parentRef ? this.#publicBindings.get(parentRef) : undefined;
		const parent = parentBinding
			? this.#publicRoots.get(parentBinding.rootInstanceId)?.entries.get(input.parentAgentId as string)
			: undefined;
		const rootAgentId = parent?.agent.rootAgentId ?? input.parentAgentId ?? input.agentId;
		const rootInstanceId = parentBinding?.rootInstanceId ?? `root:${input.currentSessionId}`;
		const identity = Object.freeze({
			schemaVersion: 1,
			agentId: input.agentId,
			rootAgentId,
			parentAgentId: input.parentAgentId ?? null,
			currentSessionId: input.currentSessionId,
			kind: input.kind,
			label: input.label,
			inspectLocator: `history://${input.agentId}`,
		});
		let root = this.#publicRoots.get(rootInstanceId);
		if (!root) {
			root = !input.parentAgentId ? this.#pendingPublicRoots.get(rootAgentId) : undefined;
			if (root) this.#pendingPublicRoots.delete(rootAgentId);
			else root = { rootAgentId, version: 0, entries: new Map(), listeners: new Set() };
			this.#publicRoots.set(rootInstanceId, root);
		}
		this.#identityRootInstances.set(identity, rootInstanceId);
		return identity;
	}

	observer(rootIdentity: string | AgentPublicIdentity): AgentLifecycleObserver {
		let root: PublicLifecycleRoot | undefined;
		if (typeof rootIdentity === "string") {
			const currentRef = this.#registry.get(rootIdentity);
			const binding = currentRef ? this.#publicBindings.get(currentRef) : undefined;
			root = binding ? this.#publicRoots.get(binding.rootInstanceId) : undefined;
			if (!root) {
				root = this.#pendingPublicRoots.get(rootIdentity);
				if (!root) {
					root = { rootAgentId: rootIdentity, version: 0, entries: new Map(), listeners: new Set() };
					this.#pendingPublicRoots.set(rootIdentity, root);
				}
			}
		} else {
			const rootInstanceId = this.#identityRootInstances.get(rootIdentity);
			root = rootInstanceId ? this.#publicRoots.get(rootInstanceId) : undefined;
			if (!root) throw new Error(`Agent "${rootIdentity.agentId}" has no lifecycle root instance.`);
		}
		if (!root.observer) {
			root.observer = Object.freeze({
				subscribe: (listener: AgentLifecycleListener) => {
					root.listeners.add(listener);
					const snapshot = this.#snapshot(root);
					let subscribed = true;
					return Object.freeze({
						snapshot,
						unsubscribe: () => {
							if (!subscribed) return;
							subscribed = false;
							root.listeners.delete(listener);
						},
					});
				},
			});
		}
		return root.observer;
	}

	bootstrapParked(identity: AgentPublicIdentity, ref: AgentRef): boolean {
		if (
			this.#registry.get(identity.agentId) !== ref ||
			ref.id !== identity.agentId ||
			ref.status !== "parked" ||
			ref.session ||
			ref.parentId !== (identity.parentAgentId ?? undefined) ||
			ref.kind !== identity.kind ||
			ref.displayName !== identity.label
		) {
			return false;
		}
		const existingBinding = this.#publicBindings.get(ref);
		if (existingBinding) {
			const existing = this.#publicRoots.get(existingBinding.rootInstanceId)?.entries.get(identity.agentId);
			return (
				existing?.state === "parked" &&
				existing.revivable &&
				!existing.terminal &&
				this.#sameStableIdentity(existing.agent, identity)
			);
		}
		const rootInstanceId = this.#identityRootInstances.get(identity);
		if (!rootInstanceId) return false;
		const root = this.#publicRoots.get(rootInstanceId);
		if (!root || root.entries.has(identity.agentId)) return false;
		const agent = Object.freeze({ ...identity });
		const entry: AgentLifecycleEntry = Object.freeze({
			agent,
			state: "parked",
			sequence: 0,
			revivable: true,
			terminal: false,
		});
		const entries = new Map(root.entries);
		entries.set(identity.agentId, entry);
		root.entries = entries;
		this.#publicBindings.set(ref, { rootInstanceId });
		return true;
	}

	commitRegistered(identity: AgentPublicIdentity, ref: AgentRef): boolean {
		if (
			this.#registry.get(identity.agentId) !== ref ||
			ref.session === null ||
			ref.status !== "running" ||
			ref.id !== identity.agentId ||
			ref.parentId !== (identity.parentAgentId ?? undefined) ||
			ref.kind !== identity.kind ||
			ref.displayName !== identity.label ||
			this.#publicBindings.has(ref)
		) {
			return false;
		}
		const rootInstanceId = this.#identityRootInstances.get(identity);
		if (!rootInstanceId) return false;
		const root = this.#publicRoots.get(rootInstanceId);
		if (!root || root.entries.has(identity.agentId)) return false;
		this.#publicBindings.set(ref, { rootInstanceId });
		return this.#commit(root, identity, "registered", null, "active", "session-created", false, false);
	}

	commitParked(ref: AgentRef, revivable: boolean): boolean {
		const binding = this.#publicBindings.get(ref);
		if (!binding || this.#registry.get(ref.id) !== ref || ref.status !== "parked" || ref.session) {
			return false;
		}
		const root = this.#publicRoots.get(binding.rootInstanceId);
		const current = root?.entries.get(ref.id);
		if (!root || !current || current.state !== "active" || current.terminal) return false;
		return this.#commit(root, current.agent, "parked", current.state, "parked", "idle-timeout", revivable, false);
	}

	commitRevived(identity: AgentPublicIdentity, ref: AgentRef): boolean {
		const binding = this.#publicBindings.get(ref);
		if (!binding || this.#registry.get(ref.id) !== ref || ref.status !== "running" || !ref.session) {
			return false;
		}
		const root = this.#publicRoots.get(binding.rootInstanceId);
		const current = root?.entries.get(ref.id);
		if (
			!root ||
			!current ||
			current.state !== "parked" ||
			!current.revivable ||
			!this.#sameStableIdentity(current.agent, identity)
		) {
			return false;
		}
		return this.#commit(root, identity, "revived", "parked", "active", "cold-revive", true, false);
	}

	commitReleased(ref: AgentRef, reason: "release" | "process-shutdown" = "release"): boolean {
		const binding = this.#publicBindings.get(ref);
		if (!binding || this.#registry.get(ref.id) === ref) return false;
		const root = this.#publicRoots.get(binding.rootInstanceId);
		const current = root?.entries.get(ref.id);
		if (!root || !current || current.terminal) return false;
		const committed = this.#commit(root, current.agent, "released", current.state, "released", reason, false, true);
		if (committed && this.#publicBindings.get(ref) === binding) this.#publicBindings.delete(ref);
		return committed;
	}

	commitAborted(ref: AgentRef): boolean {
		const binding = this.#publicBindings.get(ref);
		if (!binding || this.#registry.get(ref.id) !== ref || ref.status !== "aborted") return false;
		const root = this.#publicRoots.get(binding.rootInstanceId);
		const current = root?.entries.get(ref.id);
		if (!root || !current || current.terminal) return false;
		return this.#commit(root, current.agent, "aborted", current.state, "aborted", "hard-abort", false, true);
	}

	#findPublicEntry(agentId: string): AgentLifecycleEntry | undefined {
		const ref = this.#registry.get(agentId);
		const binding = ref ? this.#publicBindings.get(ref) : undefined;
		return binding ? this.#publicRoots.get(binding.rootInstanceId)?.entries.get(agentId) : undefined;
	}

	#snapshot(root: PublicLifecycleRoot): AgentLifecycleSnapshot {
		return Object.freeze({
			schemaVersion: 1,
			rootAgentId: root.rootAgentId,
			version: root.version,
			agents: Object.freeze([...root.entries.values()]),
		});
	}

	#sameStableIdentity(left: AgentPublicIdentity, right: AgentPublicIdentity): boolean {
		return (
			left.schemaVersion === right.schemaVersion &&
			left.agentId === right.agentId &&
			left.rootAgentId === right.rootAgentId &&
			left.parentAgentId === right.parentAgentId &&
			left.kind === right.kind &&
			left.label === right.label &&
			left.inspectLocator === right.inspectLocator
		);
	}

	#commit(
		root: PublicLifecycleRoot,
		identity: AgentPublicIdentity,
		transition: AgentLifecycleTransitionType,
		from: AgentLifecycleState | null,
		to: AgentLifecycleState,
		reason: AgentLifecycleReason,
		revivable: boolean,
		terminal: boolean,
	): boolean {
		const previous = root.entries.get(identity.agentId);
		const sequence = (previous?.sequence ?? 0) + 1;
		const agent = Object.freeze({ ...identity });
		const entry: AgentLifecycleEntry = Object.freeze({ agent, state: to, sequence, revivable, terminal });
		const entries = new Map(root.entries);
		entries.set(identity.agentId, entry);
		root.entries = entries;
		root.version += 1;
		const event: AgentLifecycleTransition = Object.freeze({
			schemaVersion: 1,
			rootAgentId: root.rootAgentId,
			version: root.version,
			sequence,
			transition,
			agent,
			from,
			to,
			reason,
			revivable,
			terminal,
		});
		for (const listener of [...root.listeners]) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Agent lifecycle listener failed", {
					id: identity.agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return true;
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { ref, idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	/**
	 * Reclaim a provably-dead parked corpse so a fresh spawn can reuse its id.
	 * Refuses live, adopted, in-flight, or cold-revivable refs. For a parked ref
	 * restored from disk, the persisted factory is consulted before removal
	 * because cold revivers are created lazily by {@link ensureLive}.
	 *
	 * Only refs in the registry this manager owns are touched; the transcript
	 * stays readable at `history://<id>`. Returns true when the corpse was
	 * unregistered.
	 */
	async reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean> {
		const ref = this.#registry.get(id);
		if (ref !== expected || ref.status !== "parked" || ref.session) return false;
		if (this.#publicBindings.has(ref)) return false;
		if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;

		const persistedFactory = ref.sessionFile ? this.#persistedReviverFactory : undefined;
		if (persistedFactory) {
			try {
				if (await persistedFactory(ref)) return false;
			} catch (error) {
				logger.warn("AgentLifecycleManager.reclaimDeadCorpse: persisted reviver probe failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			// The factory awaited I/O; another lifecycle operation may now own or
			// have replaced this ref. Revalidate every reclaim invariant.
			if (this.#registry.get(id) !== ref || ref.status !== "parked" || ref.session) return false;
			if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;
		}
		return this.#registry.unregister(id, ref);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	isReleasing(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#releases.get(id);
		return Boolean(ref && (expected === undefined || ref === expected || ref.session === expected));
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				const detached = this.#registry.detachSession(id, ref);
				const parked = detached && this.#registry.setStatus(id, "parked", ref);
				if (parked) this.commitParked(ref, Boolean(adopted.revive));

				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		if (this.#releases.has(id)) {
			throw new Error(`Agent "${id}" is being released and cannot accept new work.`);
		}
		const park = this.#parks.get(id);
		if (park) {
			const parked = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id)?.session;
				if (kept) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			// Teardown can complete during the factory await. A late cold revive must
			// not cold-adopt (and later attach a live session + TTL) into a disposed
			// manager — reject deterministically before creating any session.
			if (this.#disposed) {
				throw new Error(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			}
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		if (this.#registry.get(id) !== ref) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}

	/**
	 * Dispose if live and drop timers. When `expected` is given, only a ref
	 * matching it is released; a stale release can never take down a newer
	 * same-id ref. Returns true when a matching ref was released.
	 *
	 * By default the ref is unregistered (teardown / one-shot removal). Pass
	 * `tombstone: true` for an explicit kill: the ref is kept registered as a
	 * terminal `aborted` row (session detached) instead of being removed, so a
	 * later persisted-subagent scan (e.g. Agent Hub reopen) skips it via its
	 * `if (!registry.get(id))` guard rather than re-adopting the surviving
	 * on-disk transcript as a fresh `parked` row. Mirrors
	 * `finalizeSubagentLifecycle`'s genuine-kill path.
	 */
	async release(
		id: string,
		expected?: AgentRefExpectation,
		options?: { tombstone?: boolean; reason?: "release" | "process-shutdown" },
	): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (!ref) return false;
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		if (park && park.ref === ref) {
			// Prefer cancel when the session is still live so release owns dispose.
			if (!park.detached) park.cancel();
			await park.promise;
		}

		const live = this.#registry.get(id) === ref ? ref.session : null;
		if (options?.tombstone) {
			// Persist the terminal decision before detaching the session. The
			// sidecar prevents a later discovery pass from reviving this transcript
			// as a fresh parked ref.
			if (ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
			if (!this.#registry.setStatus(id, "aborted", ref)) return false;
			this.commitAborted(ref);
			this.#registry.detachSession(id, ref);
		} else {
			this.#releases.set(id, ref);
		}
		if (live) {
			try {
				await live.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
			}
		}
		if (!options?.tombstone) {
			if (this.#releases.get(id) === ref) this.#releases.delete(id);
			if (!this.#registry.unregister(id, ref)) return false;
			this.commitReleased(ref, options?.reason);
		}
		return true;
	}
	/** Teardown every bound child; the owner, when supplied, is released by its session callback. */
	async dispose(
		options: { deadlineAt?: number; ownerRef?: AgentRef; beforeUnsubscribe?: () => Promise<void> | void } = {},
	): Promise<void> {
		if (!options.ownerRef) this.#disposed = true;
		const deadlineAt = options.deadlineAt ?? Date.now() + AGENT_RELEASE_GRACE_MS;
		const ownerRootInstanceId = options.ownerRef
			? this.#publicBindings.get(options.ownerRef)?.rootInstanceId
			: undefined;
		const refs = new Set<AgentRef>();
		const includeRef = (ref: AgentRef): void => {
			if (ref === options.ownerRef) return;
			if (options.ownerRef) {
				const binding = this.#publicBindings.get(ref);
				if (!ownerRootInstanceId || binding?.rootInstanceId !== ownerRootInstanceId) return;
			}
			refs.add(ref);
		};
		for (const ref of this.#publicBindings.keys()) includeRef(ref);
		for (const adopted of this.#adopted.values()) includeRef(adopted.ref);
		for (const park of this.#parks.values()) includeRef(park.ref);
		await Promise.all(
			[...refs].map(async ref => {
				const release = this.release(ref.id, ref, { reason: "process-shutdown" }).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						trackLateCleanup(release, { id: ref.id, resource: "adopted-agent" });
					}
					logger.warn("Agent cleanup exceeded its deadline", {
						id: ref.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		try {
			await options.beforeUnsubscribe?.();
		} finally {
			const hasLiveBoundRef = [...this.#publicBindings.keys()].some(ref => this.#registry.get(ref.id) === ref);
			if (!options.ownerRef || !hasLiveBoundRef) {
				this.#disposed = true;
				this.#unsubscribe?.();
				this.#unsubscribe = undefined;
				this.#revivals.clear();
				this.#parks.clear();
				this.#persistedReviverFactory = undefined;
				if (AgentLifecycleManager.#global === this) AgentLifecycleManager.#global = undefined;
			}
		}
	}

	async #revive(id: string, revive: AgentReviver, ref: AgentRef, adopted: AdoptedAgent): Promise<AgentSession> {
		const session = await revive(ref);
		if (this.#disposed) {
			// The owning lifecycle tore down while the reviver was in flight; dispose
			// the freshly built session instead of attaching it, and fail the waiter.
			await session.dispose();
			throw new Error(
				`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`,
			);
		}
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			// A simple reviver returned a session without claiming the parked ref;
			// attach it here while the exact ref is still revivable.
			if (
				!this.#registry.attachSession(id, session, ref.sessionFile, ref) ||
				!this.#registry.setStatus(id, "running", ref)
			) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach and run.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		const publicEntry = this.#findPublicEntry(id);
		if (publicEntry?.state === "parked") {
			const identity = this.createIdentity({
				agentId: id,
				parentAgentId: publicEntry.agent.parentAgentId ?? undefined,
				currentSessionId: session.sessionManager.getSessionId(),
				kind: publicEntry.agent.kind,
				label: publicEntry.agent.label,
			});
			if (!this.commitRevived(identity, liveRef)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its public lifecycle could revive.`);
			}
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
