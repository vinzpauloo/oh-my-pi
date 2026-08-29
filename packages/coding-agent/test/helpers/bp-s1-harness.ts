import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type {
	AgentLifecycleEntry,
	AgentLifecycleObserver,
	AgentLifecycleSnapshot,
	AgentLifecycleSubscription,
	AgentLifecycleTransition,
	AgentPublicIdentity,
} from "@oh-my-pi/pi-coding-agent/registry/agent-public-contract";
import { AgentRegistry, getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type SingleResult,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./agent-session-setup";

export const BP_S1_ROOT_ID = "Main";
export const BP_S1_OPEN_CHILD_ID = "BP-S1-Open";
export const BP_S1_RESTRICTED_CHILD_ID = "BP-S1-Restricted";
export const BP_S1_MODEL_PROVIDER = "bp-s1-mock";
export const BP_S1_MODEL_ID = "bp-s1-model";
export const BP_S1_MODEL_PATTERN = `${BP_S1_MODEL_PROVIDER}/${BP_S1_MODEL_ID}`;
export const BP_S1_CAPTURE_TOOL = "bp_s1_capture_identity";

const CAPTURE_HOST_SYMBOL = "@oh-my-pi/bp-s1-proof-host";
const DEFAULT_WAIT_MS = 2_000;

export interface CapturedExtensionContext {
	readonly phase: string;
	readonly identity: AgentPublicIdentity;
	readonly observer: AgentLifecycleObserver;
	readonly snapshot: AgentLifecycleSnapshot;
	readonly contextKeys: readonly string[];
	readonly identityFrozen: boolean;
	readonly observerFrozen: boolean;
	readonly snapshotFrozen: boolean;
}

export interface CapturedHookCommandContext {
	readonly contextKeys: readonly string[];
	readonly hasAgent: boolean;
	readonly hasAgentLifecycle: boolean;
}

interface ProofHost {
	capture(phase: string, context: Record<string, unknown>): void;
}

interface ChildDispatchBarrier {
	readonly entered: Set<string>;
	enter(marker: string): Promise<void>;
}

export interface BpS1Harness {
	readonly tempDir: TempDir;
	readonly registry: AgentRegistry;
	readonly lifecycle: AgentLifecycleManager;
	readonly observer: AgentLifecycleObserver;
	readonly rootSession: AgentSession;
	readonly rootIdentity: AgentPublicIdentity;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model<Api>;
	readonly mock: MockModel;
	readonly captures: CapturedExtensionContext[];
	readonly hookCommandContexts: readonly CapturedHookCommandContext[];
	readonly transitions: AgentLifecycleTransition[];
	readonly childResults: ReadonlyMap<string, SingleResult>;
	readonly concurrentChildDispatches: ReadonlySet<string>;
	readonly taskLifecycleSignals: readonly SubagentLifecyclePayload[];
	readonly eventBus: EventBus;
	currentSnapshot(): AgentLifecycleSnapshot;
	identity(agentId: string): AgentPublicIdentity;
	refSession(agentId: string): AgentSession | null | undefined;
	sessionFile(agentId: string): string;
	tombstonePath(agentId: string): string;
	park(agentId: string): Promise<void>;
	revive(agentId: string): Promise<AgentSession>;
	release(agentId: string): Promise<boolean>;
	abort(agentId: string): Promise<boolean>;
	detachObserver(): void;
	createConflictingChild(parentAgentId: string, label: string): Promise<AgentSession>;
	disposeRoot(): Promise<void>;
	close(): Promise<void>;
}

function createDispatchBarrier(): ChildDispatchBarrier {
	const entered = new Set<string>();
	const ready = Promise.withResolvers<void>();
	let resolved = false;
	return {
		entered,
		async enter(marker: string) {
			entered.add(marker);
			if (!resolved && entered.size === 2) {
				resolved = true;
				ready.resolve();
			}
			await settleWithin(ready.promise, DEFAULT_WAIT_MS, "two child model calls did not overlap");
		},
	};
}

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some(tool => tool.name === name) === true;
}

function hasToolResult(context: Context, name: string): boolean {
	return context.messages.some(message => message.role === "toolResult" && JSON.stringify(message).includes(name));
}

function childMarker(context: Context): string | undefined {
	const serialized = JSON.stringify(context.messages);
	if (serialized.includes(BP_S1_OPEN_CHILD_ID)) return BP_S1_OPEN_CHILD_ID;
	if (serialized.includes(BP_S1_RESTRICTED_CHILD_ID)) return BP_S1_RESTRICTED_CHILD_ID;
	return undefined;
}

function responseFor(context: Context, barrier: ChildDispatchBarrier): Promise<MockResponse> | MockResponse {
	const yieldEnabled = hasTool(context, "yield");
	const marker = yieldEnabled ? childMarker(context) : undefined;
	const respond = (): MockResponse => {
		if (hasTool(context, BP_S1_CAPTURE_TOOL) && !hasToolResult(context, BP_S1_CAPTURE_TOOL)) {
			return {
				content: [{ type: "toolCall", name: BP_S1_CAPTURE_TOOL, arguments: {} }],
			};
		}
		if (yieldEnabled) {
			return {
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: { result: { data: { agentId: marker ?? "child", complete: true } } },
					},
				],
			};
		}
		return { content: ["root turn complete"] };
	};
	if (!marker || context.messages.some(message => message.role === "assistant")) return respond();
	return barrier.enter(marker).then(respond);
}

function extensionCaptureSource(): string {
	return `
const phases = [
  "session_start",
  "before_agent_start",
  "agent_start",
  "turn_start",
  "tool_call",
  "tool_result",
  "turn_end",
  "agent_end",
  "session_shutdown",
];

export default function (pi) {
  const host = globalThis[Symbol.for(${JSON.stringify(CAPTURE_HOST_SYMBOL)})];
  if (!host) throw new Error("BP-S1 proof host is unavailable");
  for (const phase of phases) {
    pi.on(phase, (_event, ctx) => host.capture(phase, ctx));
  }
  pi.registerTool({
    name: ${JSON.stringify(BP_S1_CAPTURE_TOOL)},
    label: "Capture BP-S1 identity",
    description: "Capture the executing extension context identity for the deterministic BP-S1 proof harness.",
    parameters: pi.zod.object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      host.capture("extension_tool", ctx);
      return { content: [{ type: "text", text: "identity captured" }], details: {} };
    },
  });
}
`;
}

function captureContext(phase: string, context: Record<string, unknown>): CapturedExtensionContext {
	const identity = context.agent as AgentPublicIdentity;
	const observer = context.agentLifecycle as AgentLifecycleObserver;
	const subscription = observer.subscribe(() => undefined);
	const snapshot = subscription.snapshot;
	subscription.unsubscribe();
	return Object.freeze({
		phase,
		identity,
		observer,
		snapshot,
		contextKeys: Object.freeze(Object.keys(context).sort()),
		identityFrozen: Object.isFrozen(identity),
		observerFrozen: Object.isFrozen(observer),
		snapshotFrozen: Object.isFrozen(snapshot) && Object.isFrozen(snapshot.agents),
	});
}

function captureHookCommandContext(context: object): CapturedHookCommandContext {
	return Object.freeze({
		contextKeys: Object.freeze(Object.keys(context).sort()),
		hasAgent: "agent" in context,
		hasAgentLifecycle: "agentLifecycle" in context,
	});
}

function baseSettings(): Settings {
	return Settings.isolated({
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.agentIdleTtlMs": 0,
		"task.maxRuntimeMs": 10_000,
		"task.softRequestBudget": 0,
		"todo.enabled": false,
	});
}

function workspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
}

function childDefinition(name: string, tools: string[]): AgentDefinition {
	return {
		name,
		description: `${name} BP-S1 proof child`,
		systemPrompt: `Complete the assigned BP-S1 proof turn for ${name}.`,
		source: "project",
		tools,
	};
}

export function identityDigest(identity: AgentPublicIdentity): string {
	return JSON.stringify({
		schemaVersion: identity.schemaVersion,
		agentId: identity.agentId,
		rootAgentId: identity.rootAgentId,
		parentAgentId: identity.parentAgentId,
		currentSessionId: identity.currentSessionId,
		kind: identity.kind,
		label: identity.label,
		inspectLocator: identity.inspectLocator,
	});
}

export function stableIdentityDigest(identity: AgentPublicIdentity): string {
	return JSON.stringify({
		schemaVersion: identity.schemaVersion,
		agentId: identity.agentId,
		rootAgentId: identity.rootAgentId,
		parentAgentId: identity.parentAgentId,
		kind: identity.kind,
		label: identity.label,
		inspectLocator: identity.inspectLocator,
	});
}

export function transitionDigest(transition: AgentLifecycleTransition): string {
	return [
		transition.version,
		transition.agent.agentId,
		transition.sequence,
		transition.transition,
		transition.from ?? "null",
		transition.to,
		transition.reason,
		transition.revivable,
		transition.terminal,
	].join(":");
}

export function snapshotOf(observer: AgentLifecycleObserver): AgentLifecycleSnapshot {
	const subscription = observer.subscribe(() => undefined);
	try {
		return subscription.snapshot;
	} finally {
		subscription.unsubscribe();
	}
}

export async function settleWithin<T>(
	promise: Promise<T>,
	timeoutMs = DEFAULT_WAIT_MS,
	label = "operation",
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function waitForTransition(
	observer: AgentLifecycleObserver,
	predicate: (transition: AgentLifecycleTransition) => boolean,
	timeoutMs = DEFAULT_WAIT_MS,
): Promise<AgentLifecycleTransition> {
	let subscription: AgentLifecycleSubscription | undefined;
	let timer: NodeJS.Timeout | undefined;
	const pending = new Promise<AgentLifecycleTransition>((resolve, reject) => {
		subscription = observer.subscribe(transition => {
			if (!predicate(transition)) return;
			resolve(transition);
		});
		timer = setTimeout(
			() => reject(new Error(`lifecycle transition was not emitted within ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
	});
	return pending.finally(() => {
		clearTimeout(timer);
		subscription?.unsubscribe();
	});
}

export function waitForState(
	observer: AgentLifecycleObserver,
	agentId: string,
	state: AgentLifecycleEntry["state"],
	timeoutMs = DEFAULT_WAIT_MS,
): Promise<AgentLifecycleEntry> {
	let subscription: AgentLifecycleSubscription | undefined;
	let timer: NodeJS.Timeout | undefined;
	const pending = new Promise<AgentLifecycleEntry>((resolve, reject) => {
		subscription = observer.subscribe(transition => {
			if (transition.agent.agentId !== agentId || transition.to !== state) return;
			const entry = snapshotOf(observer).agents.find(candidate => candidate.agent.agentId === agentId);
			if (entry) resolve(entry);
		});
		const initial = subscription.snapshot.agents.find(
			entry => entry.agent.agentId === agentId && entry.state === state,
		);
		if (initial) {
			resolve(initial);
			return;
		}
		timer = setTimeout(() => reject(new Error(`${agentId} did not reach ${state} within ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
	});
	return pending.finally(() => {
		clearTimeout(timer);
		subscription?.unsubscribe();
	});
}

export async function createBpS1Harness(): Promise<BpS1Harness> {
	const tempDir = TempDir.createSync("@bp-s1-real-session-");
	const cwd = tempDir.join("workspace");
	const agentDir = tempDir.join("agent");
	const artifactsDir = tempDir.join("sessions");
	await Promise.all([
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(artifactsDir, { recursive: true }),
	]);

	const captureExtensionPath = tempDir.join("bp-s1-capture.ts");
	await Bun.write(captureExtensionPath, extensionCaptureSource());

	const captures: CapturedExtensionContext[] = [];
	const hookCommandContexts: CapturedHookCommandContext[] = [];
	const transitions: AgentLifecycleTransition[] = [];
	const taskLifecycleSignals: SubagentLifecyclePayload[] = [];
	const barrier = createDispatchBarrier();
	const mock = createMockModel({
		provider: BP_S1_MODEL_PROVIDER,
		id: BP_S1_MODEL_ID,
		handler: context => responseFor(context, barrier),
	});
	const api = `bp-s1-mock-api-${path.basename(tempDir.path())}`;
	const proofHost: ProofHost = {
		capture: (phase, context) => captures.push(captureContext(phase, context)),
	};
	const hostKey = Symbol.for(CAPTURE_HOST_SYMBOL);
	const previousHost = (globalThis as Record<symbol, unknown>)[hostKey];
	(globalThis as Record<symbol, unknown>)[hostKey] = proofHost;

	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const customApiSource = `bp-s1-harness:${api}`;
	registerCustomApi(api, (_model, context, options) => mock.stream(mock, context, options), customApiSource);
	modelRegistry.registerProvider(BP_S1_MODEL_PROVIDER, {
		baseUrl: "mock://bp-s1",
		apiKey: "test-key",
		api,
		models: [
			{
				id: BP_S1_MODEL_ID,
				name: "BP-S1 Mock Model",
				reasoning: false,
				input: ["text"],
				supportsTools: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_768,
			},
		],
	});
	authStorage.setRuntimeApiKey(BP_S1_MODEL_PROVIDER, "test-key");
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const observer = lifecycle.observer(BP_S1_ROOT_ID);
	const recordingSubscription = observer.subscribe(transition => transitions.push(transition));
	let rootSession: AgentSession | undefined;
	let rootDisposed = false;
	let unsubscribeTaskLifecycle: (() => void) | undefined;
	let closed = false;

	try {
		const created = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			getApiKey: () => "test-key",
			modelPattern: BP_S1_MODEL_PATTERN,
			settings: baseSettings(),
			sessionManager: SessionManager.inMemory(cwd),
			agentRegistry: registry,
			agentLifecycle: lifecycle,
			agentId: BP_S1_ROOT_ID,
			agentDisplayName: "BP-S1 Root",
			expectedAgentRef: null,
			additionalExtensionPaths: [captureExtensionPath],
			toolNames: [BP_S1_CAPTURE_TOOL],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: workspaceTree(cwd),
		});
		rootSession = created.session;
		const rootExtensionRunner = rootSession.extensionRunner;
		if (!rootExtensionRunner) throw new Error("BP-S1 root capture extension did not load");
		await settleWithin(rootExtensionRunner.emit({ type: "session_start" }), 2_000, "root session_start");
		rootSession.setMCPPromptCommands([
			{
				path: "mcp:bp-s1-hook-boundary",
				resolvedPath: "mcp:bp-s1-hook-boundary",
				source: "bundled",
				command: {
					name: "bp-s1-hook-boundary",
					description: "Capture the real HookCommandContext boundary.",
					execute: (_args, context) => {
						hookCommandContexts.push(captureHookCommandContext(context));
						return "Hook command boundary captured.";
					},
				},
			},
		]);
		unsubscribeTaskLifecycle = created.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			taskLifecycleSignals.push(data as SubagentLifecyclePayload);
		});
		await settleWithin(rootSession.prompt("Exercise the BP-S1 root identity contract."), 5_000, "root proof turn");
		await settleWithin(rootSession.prompt("/bp-s1-hook-boundary"), 5_000, "hook command boundary turn");

		const model = modelRegistry.find(BP_S1_MODEL_PROVIDER, BP_S1_MODEL_ID);
		if (!model) throw new Error("BP-S1 extension provider did not register its MockModel route");
		const sharedChildOptions: Omit<ExecutorOptions, "agent" | "task" | "index" | "id"> = {
			cwd,
			settings: baseSettings(),
			modelRegistry,
			authStorage,
			getApiKey: () => "test-key",
			modelOverride: BP_S1_MODEL_PATTERN,
			parentAgentId: BP_S1_ROOT_ID,
			agentRegistry: registry,
			agentLifecycle: lifecycle,
			eventBus: created.eventBus,
			artifactsDir,
			persistArtifacts: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			rules: [],
			workspaceTree: workspaceTree(cwd),
			keepAlive: true,
			cleanupGraceMs: 2_000,
		};

		const [openResult, restrictedResult] = await settleWithin(
			Promise.all([
				runSubprocess({
					...sharedChildOptions,
					agent: childDefinition("bp-s1-open", [BP_S1_CAPTURE_TOOL]),
					task: `Complete ${BP_S1_OPEN_CHILD_ID}`,
					assignment: `Exercise ${BP_S1_OPEN_CHILD_ID}`,
					index: 0,
					id: BP_S1_OPEN_CHILD_ID,
					preloadedExtensionPaths: [captureExtensionPath],
				}),
				runSubprocess({
					...sharedChildOptions,
					agent: childDefinition("bp-s1-restricted", ["yield"]),
					task: `Complete ${BP_S1_RESTRICTED_CHILD_ID}`,
					assignment: `Exercise ${BP_S1_RESTRICTED_CHILD_ID}`,
					index: 1,
					id: BP_S1_RESTRICTED_CHILD_ID,
					worktree: cwd,
					restrictToolNames: true,
					preloadedExtensionPaths: [captureExtensionPath],
				}),
			]),
			10_000,
			"concurrent child proof turns",
		);
		const childResults = new Map<string, SingleResult>([
			[BP_S1_OPEN_CHILD_ID, openResult],
			[BP_S1_RESTRICTED_CHILD_ID, restrictedResult],
		]);
		const rootIdentity = snapshotOf(observer).agents.find(entry => entry.agent.agentId === BP_S1_ROOT_ID)?.agent;
		if (!rootIdentity) throw new Error("root public identity was not emitted");

		const harness: BpS1Harness = {
			tempDir,
			registry,
			lifecycle,
			observer,
			rootSession,
			rootIdentity,
			authStorage,
			modelRegistry,
			model,
			mock,
			captures,
			hookCommandContexts,
			transitions,
			childResults,
			concurrentChildDispatches: barrier.entered,
			taskLifecycleSignals,
			eventBus: created.eventBus,
			currentSnapshot: () => snapshotOf(observer),
			identity: agentId => {
				const identity = snapshotOf(observer).agents.find(entry => entry.agent.agentId === agentId)?.agent;
				if (!identity) throw new Error(`missing public identity for ${agentId}`);
				return identity;
			},
			refSession: agentId => registry.get(agentId)?.session,
			sessionFile: agentId => {
				const sessionFile = registry.get(agentId)?.sessionFile;
				if (!sessionFile) throw new Error(`missing session file for ${agentId}`);
				return sessionFile;
			},
			tombstonePath: agentId => getAgentTombstonePath(harness.sessionFile(agentId)),
			park: async agentId => {
				const pending = waitForTransition(
					observer,
					event => event.agent.agentId === agentId && event.transition === "parked",
				);
				await lifecycle.park(agentId);
				await pending;
			},
			revive: async agentId => {
				const pending = waitForTransition(
					observer,
					event => event.agent.agentId === agentId && event.transition === "revived",
				);
				const session = await lifecycle.ensureLive(agentId);
				await pending;
				return session;
			},
			release: agentId => lifecycle.release(agentId),
			abort: agentId => lifecycle.release(agentId, undefined, { tombstone: true }),
			detachObserver: () => {
				recordingSubscription.unsubscribe();
			},
			createConflictingChild: async (parentAgentId, label) => {
				const conflicting = await createAgentSession({
					cwd,
					agentDir,
					authStorage,
					modelRegistry,
					getApiKey: () => "test-key",
					model,
					settings: baseSettings(),
					sessionManager: SessionManager.inMemory(cwd),
					agentRegistry: registry,
					agentLifecycle: lifecycle,
					agentId: BP_S1_OPEN_CHILD_ID,
					agentDisplayName: label,
					parentAgentId,
					parentTaskPrefix: BP_S1_OPEN_CHILD_ID,
					taskDepth: 1,
					expectedAgentRef: null,
					disableExtensionDiscovery: true,
					restrictToolNames: true,
					toolNames: ["yield"],
					requireYieldTool: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					skipPythonPreflight: true,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					workspaceTree: workspaceTree(cwd),
				});
				return conflicting.session;
			},
			disposeRoot: async () => {
				if (rootDisposed) return;
				await rootSession!.dispose();
				rootDisposed = true;
			},
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					if (!rootDisposed) await harness.disposeRoot();
				} finally {
					unsubscribeTaskLifecycle?.();
					recordingSubscription.unsubscribe();
					if (previousHost === undefined) delete (globalThis as Record<symbol, unknown>)[hostKey];
					else (globalThis as Record<symbol, unknown>)[hostKey] = previousHost;
					modelRegistry.unregisterProvider(BP_S1_MODEL_PROVIDER);
					unregisterCustomApis(customApiSource);
					authStorage.close();
					await tempDir.remove();
				}
			},
		};
		return harness;
	} catch (error) {
		recordingSubscription.unsubscribe();
		unsubscribeTaskLifecycle?.();
		try {
			await rootSession?.dispose();
		} finally {
			if (previousHost === undefined) delete (globalThis as Record<symbol, unknown>)[hostKey];
			else (globalThis as Record<symbol, unknown>)[hostKey] = previousHost;
			modelRegistry.unregisterProvider(BP_S1_MODEL_PROVIDER);
			unregisterCustomApis(customApiSource);
			authStorage.close();
			await tempDir.remove();
		}
		throw error;
	}
}
