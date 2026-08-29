import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

registerMockApi();

describe("model switch from vision to text-only", () => {
	it("omits historical images from the text-only provider request", async () => {
		const dir = TempDir.createSync("@nonvision-history-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("mock", "test-key");
			const vision = createMockModel({ id: "vision", handler: () => ({ content: ["first"] }) });
			vision.input.push("image");
			const text = createMockModel({ id: "text", handler: () => ({ content: ["second"] }) });
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"images.blockImages": false,
				"todo.enabled": false,
				"retry.enabled": false,
			});
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: vision,
				settings,
				sessionManager: SessionManager.inMemory(dir.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			const notices: string[] = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "notice") notices.push(`${event.source}:${event.message}`);
			});
			try {
				await session.prompt("see image", { images: [{ type: "image", data: "aaaa", mimeType: "image/png" }] });
				await session.setModel(text);
				await session.prompt("now text only");

				const messages = text.calls.at(-1)?.context.messages ?? [];
				expect(
					messages.flatMap<unknown>(message => (Array.isArray(message.content) ? message.content : [])),
				).not.toContainEqual(expect.objectContaining({ type: "image" }));

				await session.setModel(vision);
				expect(notices.at(-1)).toContain("vision:inspect_image is now hidden:");
				expect(notices.at(-1)).toContain("supports image input natively. Override with /vision on.");
			} finally {
				unsubscribe();
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});

	it("updates same-model role ownership and clears it for temporary and raw cycling", async () => {
		const dir = TempDir.createSync("@model-role-ownership-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("anthropic", "anthropic-test-key");
			const fable = getBundledModel("anthropic", "claude-fable-5");
			const opus = getBundledModel("anthropic", "claude-opus-5");
			if (!fable || !opus) throw new Error("Expected bundled Anthropic role models");
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"retry.enabled": false,
			});
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: fable,
				scopedModels: [{ model: fable }, { model: opus }],
				settings,
				sessionManager: SessionManager.inMemory(dir.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			try {
				const initialSelector = `${session.model?.provider}/${session.model?.id}`;
				await session.setModel(fable, "vision");
				expect(`${session.model?.provider}/${session.model?.id}`).toBe(initialSelector);
				expect(session.getActiveModelRole()).toBe("vision");

				await session.setModelTemporary(opus);
				expect(session.model?.id).toBe(opus.id);
				expect(session.getActiveModelRole()).toBeUndefined();

				await session.setModel(fable, "vision");
				expect(session.getActiveModelRole()).toBe("vision");
				const cycled = await session.cycleModel();
				expect(cycled?.model.id).toBe(opus.id);
				expect(session.getActiveModelRole()).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});

	it("anchors active model roles to session ids and restores prior ownership by id", async () => {
		const dir = TempDir.createSync("@model-role-session-id-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			auth.setRuntimeApiKey("anthropic", "anthropic-test-key");
			const fable = getBundledModel("anthropic", "claude-fable-5");
			if (!fable) throw new Error("Expected bundled Fable model");
			const sessionManager = SessionManager.inMemory(dir.path());
			const { session } = await createAgentSession({
				cwd: dir.path(),
				agentDir: dir.path(),
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
				model: fable,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.enabled": false,
					"retry.enabled": false,
				}),
				sessionManager,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			try {
				session.setActiveModelRole("vision");
				const firstSessionId = sessionManager.getSessionId();
				const firstState = sessionManager.captureState();
				expect(session.getActiveModelRole()).toBe("vision");

				expect(await session.newSession()).toBe(true);
				const secondSessionId = sessionManager.getSessionId();
				expect(secondSessionId).not.toBe(firstSessionId);
				expect(session.getActiveModelRole()).toBeUndefined();
				session.setActiveModelRole("designer");
				const secondState = sessionManager.captureState();
				expect(session.getActiveModelRole()).toBe("designer");

				sessionManager.restoreState(firstState);
				expect(sessionManager.getSessionId()).toBe(firstSessionId);
				expect(session.getActiveModelRole()).toBe("vision");

				sessionManager.restoreState(secondState);
				expect(sessionManager.getSessionId()).toBe(secondSessionId);
				expect(session.getActiveModelRole()).toBe("designer");
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});
});
