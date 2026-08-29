import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("inherits the default chain only for roles without an explicit chain", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains({ default: defaultChain, slow: ["google/gemini-2.5-flash"] }, [
			"default",
			"task",
			"slow",
		]);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
	});
});

function requireRoleOwnershipModels(): {
	fable: Model;
	opus: Model;
	gemini: Model;
	grok: Model;
	sol: Model;
} {
	const fable = getBundledModel("anthropic", "claude-fable-5");
	const opus = getBundledModel("anthropic", "claude-opus-5");
	const gemini = getBundledModel("google-antigravity", "gemini-3.7-flash");
	const grok = getBundledModel("xai-oauth", "grok-4.6");
	const sol = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!fable || !opus || !gemini || !grok || !sol) {
		throw new Error("Expected bundled OMP role models");
	}
	return { fable, opus, gemini, grok, sol };
}

function modelSelector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

describe("session-owned retry fallback roles", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@role-owned-retry-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		for (const provider of ["anthropic", "google-antigravity", "xai-oauth", "openai-codex"]) {
			authStorage.setRuntimeApiKey(provider, `${provider}-test-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("routes a shared Fable primary through the bound VISION chain only", async () => {
		const { fable, opus, gemini, grok, sol } = requireRoleOwnershipModels();
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fable, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				const selector = modelSelector(model);
				requestedModels.push(selector);
				if (selector === modelSelector(gemini)) {
					mock.push({ content: ["vision recovered"] });
				} else if (selector === modelSelector(fable) || selector === modelSelector(opus)) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					throw new Error(`Unexpected VISION retry model: ${selector}`);
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 2,
			"retry.fallbackChains": {
				default: [`${modelSelector(opus)}:xhigh`, `${modelSelector(grok)}:xhigh`, `${modelSelector(sol)}:xhigh`],
				designer: [`${modelSelector(opus)}:xhigh`, `${modelSelector(grok)}:xhigh`, `${modelSelector(sol)}:xhigh`],
				vision: [`${modelSelector(opus)}:xhigh`, `${modelSelector(gemini)}:high`],
			},
		});
		for (const role of ["default", "designer", "vision"]) {
			settings.setModelRole(role, `${modelSelector(fable)}:xhigh`);
		}
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const applied: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const succeededRoles: string[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") applied.push(event);
			if (event.type === "retry_fallback_succeeded") succeededRoles.push(event.role);
		});

		try {
			await session.setModel(fable, "vision");
			expect(session.getActiveModelRole()).toBe("vision");
			await session.prompt("Use the vision-owned retry chain");
			await session.waitForIdle();

			expect(requestedModels).toEqual([modelSelector(fable), modelSelector(opus), modelSelector(gemini)]);
			expect(requestedModels).not.toContain(modelSelector(grok));
			expect(requestedModels).not.toContain(modelSelector(sol));
			expect(applied.map(event => event.role)).toEqual(["vision", "vision"]);
			expect(applied.map(event => event.to)).toEqual([
				`${modelSelector(opus)}:xhigh`,
				`${modelSelector(gemini)}:high`,
			]);
			expect(succeededRoles).toEqual(["vision"]);
			expect(session.getActiveModelRole()).toBe("vision");
		} finally {
			await session.dispose();
		}
	});

	it("keeps DEFAULT and DESIGNER on their unchanged shared-primary chains", async () => {
		const { fable, opus, grok, sol } = requireRoleOwnershipModels();
		const expectedModels = [fable, opus, grok, sol].map(modelSelector);

		for (const role of ["default", "designer"] as const) {
			modelRegistry.clearSuppressedSelectors();
			const requestedModels: string[] = [];
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: fable, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					const selector = modelSelector(model);
					requestedModels.push(selector);
					if (selector === modelSelector(sol)) {
						mock.push({ content: [`${role} recovered`] });
					} else if (
						selector === modelSelector(fable) ||
						selector === modelSelector(opus) ||
						selector === modelSelector(grok)
					) {
						mock.push({ throw: "overloaded_error: provider returned error 503" });
					} else {
						throw new Error(`Unexpected ${role} retry model: ${selector}`);
					}
					return mock.stream(model, context, options);
				},
			});
			const chain = [`${modelSelector(opus)}:xhigh`, `${modelSelector(grok)}:xhigh`, `${modelSelector(sol)}:xhigh`];
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 3,
				"retry.fallbackChains": {
					default: chain,
					designer: chain,
					vision: [`${modelSelector(opus)}:xhigh`],
				},
			});
			for (const configuredRole of ["default", "designer", "vision"]) {
				settings.setModelRole(configuredRole, `${modelSelector(fable)}:xhigh`);
			}
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			const appliedRoles: string[] = [];
			const succeededRoles: string[] = [];
			session.subscribe(event => {
				if (event.type === "retry_fallback_applied") appliedRoles.push(event.role);
				if (event.type === "retry_fallback_succeeded") succeededRoles.push(event.role);
			});

			try {
				await session.setModel(fable, role);
				await session.prompt(`Use the ${role}-owned retry chain`);
				await session.waitForIdle();

				expect(requestedModels).toEqual(expectedModels);
				expect(appliedRoles).toEqual([role, role, role]);
				expect(succeededRoles).toEqual([role]);
				expect(session.getActiveModelRole()).toBe(role);
			} finally {
				await session.dispose();
			}
		}
	});

	it("keeps VISION ownership through fallback and cooldown reversion", async () => {
		const { fable, opus } = requireRoleOwnershipModels();
		const requestedModels: string[] = [];
		const mock = createMockModel();
		let fableAttempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fable, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				const selector = modelSelector(model);
				requestedModels.push(selector);
				if (selector === modelSelector(fable) && fableAttempts++ === 0) {
					mock.push({ throw: "rate limit exceeded retry-after-ms=200" });
				} else {
					mock.push({ content: [`ok:${selector}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { vision: [`${modelSelector(opus)}:xhigh`] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("vision", `${modelSelector(fable)}:xhigh`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		try {
			await session.setModel(fable, "vision");
			await session.prompt("Trigger the vision fallback");
			await session.waitForIdle();
			expect(session.getActiveModelRole()).toBe("vision");

			now += 240;
			await session.prompt("Revert to the vision primary");
			await session.waitForIdle();
			expect(requestedModels).toEqual([modelSelector(fable), modelSelector(opus), modelSelector(fable)]);
			expect(session.model?.id).toBe(fable.id);
			expect(session.getActiveModelRole()).toBe("vision");
		} finally {
			await session.dispose();
		}
	});
});
