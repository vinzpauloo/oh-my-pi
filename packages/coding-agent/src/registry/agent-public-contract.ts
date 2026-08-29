export interface AgentPublicIdentity {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly rootAgentId: string;
	readonly parentAgentId: string | null;
	readonly currentSessionId: string;
	readonly kind: "main" | "sub";
	readonly label: string;
	readonly inspectLocator: string;
}

export type AgentLifecycleState = "active" | "parked" | "released" | "aborted";

export type AgentLifecycleTransitionType = "registered" | "parked" | "revived" | "released" | "aborted";

export type AgentLifecycleReason =
	| "session-created"
	| "idle-timeout"
	| "cold-revive"
	| "release"
	| "process-shutdown"
	| "hard-abort";

export interface AgentLifecycleEntry {
	readonly agent: AgentPublicIdentity;
	readonly state: AgentLifecycleState;
	readonly sequence: number;
	readonly revivable: boolean;
	readonly terminal: boolean;
}

export interface AgentLifecycleTransition {
	readonly schemaVersion: 1;
	readonly rootAgentId: string;
	readonly version: number;
	readonly sequence: number;
	readonly transition: AgentLifecycleTransitionType;
	readonly agent: AgentPublicIdentity;
	readonly from: AgentLifecycleState | null;
	readonly to: AgentLifecycleState;
	readonly reason: AgentLifecycleReason;
	readonly revivable: boolean;
	readonly terminal: boolean;
}

export interface AgentLifecycleSnapshot {
	readonly schemaVersion: 1;
	readonly rootAgentId: string;
	readonly version: number;
	readonly agents: readonly AgentLifecycleEntry[];
}

export type AgentLifecycleListener = (transition: AgentLifecycleTransition) => void;

export interface AgentLifecycleSubscription {
	readonly snapshot: AgentLifecycleSnapshot;
	unsubscribe(): void;
}

export interface AgentLifecycleObserver {
	subscribe(listener: AgentLifecycleListener): AgentLifecycleSubscription;
}

export function createStandaloneAgentContract(
	currentSessionId: string,
	label: string,
): Readonly<{
	agentIdentity: AgentPublicIdentity;
	agentLifecycleObserver: AgentLifecycleObserver;
}> {
	const agentId = `standalone:${currentSessionId}`;
	const agentIdentity = Object.freeze({
		schemaVersion: 1,
		agentId,
		rootAgentId: agentId,
		parentAgentId: null,
		currentSessionId,
		kind: "main",
		label,
		inspectLocator: `history://${agentId}`,
	} satisfies AgentPublicIdentity);
	const snapshot = Object.freeze({
		schemaVersion: 1,
		rootAgentId: agentId,
		version: 0,
		agents: Object.freeze([]),
	} satisfies AgentLifecycleSnapshot);
	const agentLifecycleObserver = Object.freeze({
		subscribe: (_listener: AgentLifecycleListener) =>
			Object.freeze({
				snapshot,
				unsubscribe: () => undefined,
			}),
	} satisfies AgentLifecycleObserver);

	return Object.freeze({ agentIdentity, agentLifecycleObserver });
}
