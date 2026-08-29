/**
 * API Demo Extension
 *
 * Demonstrates using ExtensionAPI's logger, schema builder, pi module access,
 * public agent identity (ctx.agent), and root lifecycle observation (ctx.agentLifecycle).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Access the logger for debugging
	pi.logger.debug("API demo extension loaded");

	pi.registerTool({
		name: "api_demo",
		label: "API Demo",
		description:
			"Demonstrates ExtensionAPI capabilities: logger, schema validation, pi module access, agent identity, and lifecycle snapshot",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const { message, logLevel } = params;

			// Use logger at specified level
			pi.logger[logLevel]("API demo tool executed", { message, logLevel });

			// Access pi module utilities
			const { logger: piLogger } = pi.pi;
			piLogger.debug("Accessed pi module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

			// Read immutable public agent identity
			const { agent } = ctx;
			const agentSummary = `${agent.label} (${agent.kind}) [id=${agent.agentId}, root=${agent.rootAgentId}, schema=v${agent.schemaVersion}]`;

			// Read root lifecycle snapshot and subscribe with forward-compatible transition handling
			let lastObservedTransition: string | undefined;
			const subscription = ctx.agentLifecycle.subscribe(transition => {
				switch (transition.transition) {
					case "registered":
					case "parked":
					case "revived":
					case "released":
					case "aborted":
						lastObservedTransition = `${transition.transition}:${transition.agent.agentId} (seq=${transition.sequence}, v${transition.version})`;
						break;
					default:
						// Forward compatibility for unknown future transition types
						lastObservedTransition = `unknown-transition:${(transition as { transition: string }).transition}`;
						break;
				}
			});

			const { snapshot } = subscription;
			const lifecycleSummary = `Root ${snapshot.rootAgentId} v${snapshot.version} (${snapshot.agents.length} agent(s) tracked)`;

			// Unsubscribe when done observing
			subscription.unsubscribe();

			// Get session information
			const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
			const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";

			return {
				content: [
					{
						type: "text",
						text: [
							`API Demo Tool executed successfully!`,
							``,
							`Message: ${message}`,
							`Log Level: ${logLevel}`,
							``,
							`Features demonstrated:`,
							`1. ✓ Logger access via pi.logger`,
							`2. ✓ Schema builder access via pi.arktype`,
							`3. ✓ Pi module access via pi.pi`,
							`4. ✓ Public agent identity via ctx.agent`,
							`5. ✓ Root lifecycle snapshot & stream via ctx.agentLifecycle`,
							``,
							`Context:`,
							`- ${sessionInfo}`,
							`- ${modelInfo}`,
							`- Agent: ${agentSummary}`,
							`- Locator: ${agent.inspectLocator}`,
							`- Lifecycle: ${lifecycleSummary}`,
							`- CWD: ${ctx.cwd}`,
						].join("\n"),
					},
				],
				details: {
					message,
					logLevel,
					sessionFile: ctx.sessionManager.getSessionFile(),
					modelId: ctx.model?.id,
					agent: {
						agentId: agent.agentId,
						rootAgentId: agent.rootAgentId,
						parentAgentId: agent.parentAgentId,
						kind: agent.kind,
						label: agent.label,
						inspectLocator: agent.inspectLocator,
						schemaVersion: agent.schemaVersion,
					},
					lifecycle: {
						rootAgentId: snapshot.rootAgentId,
						version: snapshot.version,
						trackedAgents: snapshot.agents.length,
						lastObservedTransition,
					},
				},
			};
		},
	});

	// Demonstrate event handling with logger
	pi.on("session_start", async (_event, ctx) => {
		pi.logger.debug("Session started", { extension: "api-demo", agentId: ctx.agent.agentId });
	});

	pi.on("agent_start", async (_event, ctx) => {
		pi.logger.debug("Agent started", { extension: "api-demo", agentId: ctx.agent.agentId });
	});
}
