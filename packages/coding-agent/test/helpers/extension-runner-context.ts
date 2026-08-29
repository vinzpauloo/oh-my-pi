import {
	type AgentLifecycleObserver,
	type AgentPublicIdentity,
	createStandaloneAgentContract,
} from "../../src/registry/agent-public-contract";
import type { SessionManager } from "../../src/session/session-manager";

/**
 * Derives an explicit standalone AgentPublicIdentity and AgentLifecycleObserver
 * from a test SessionManager (or session ID) and test label.
 */
export function createTestExtensionRunnerContext(
	sessionManagerOrId: SessionManager | string,
	label = "test",
): Readonly<{
	agentIdentity: AgentPublicIdentity;
	agentLifecycleObserver: AgentLifecycleObserver;
}> {
	const sessionId = typeof sessionManagerOrId === "string" ? sessionManagerOrId : sessionManagerOrId.getSessionId();
	return createStandaloneAgentContract(sessionId, label);
}
