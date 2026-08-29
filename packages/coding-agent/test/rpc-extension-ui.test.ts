import { describe, expect, it, vi } from "bun:test";
import { type PendingExtensionRequest, requestRpcDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ExtensionActions } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession } from "../src/session/agent-session";

describe("RPC extension UI", () => {
	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("forwards extension model roles and exposes the active role", async () => {
		const model = { provider: "test", id: "model" } as never;
		const setModel = vi.fn(async (_model: unknown, _role?: string) => {});
		const getActiveModelRole = vi.fn(() => "vision");
		let extensionActions: ExtensionActions | undefined;
		const session = {
			extensionRunner: {
				initialize(actions: ExtensionActions) {
					extensionActions = actions;
				},
				onError: vi.fn(),
				emit: vi.fn(async () => {}),
			},
			modelRegistry: { getApiKey: vi.fn(async () => "test-key") },
			setModel,
			getActiveModelRole,
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			mode: "rpc",
			reportSendError: vi.fn(),
			reportRuntimeError: vi.fn(),
		});

		if (!extensionActions) throw new Error("Expected RPC extension actions");
		await extensionActions.setModel(model, "vision");
		await extensionActions.setModel(model);
		expect(setModel).toHaveBeenNthCalledWith(1, model, "vision");
		expect(setModel).toHaveBeenNthCalledWith(2, model, undefined);
		expect(extensionActions.getActiveModelRole).toBeTypeOf("function");
		if (!extensionActions.getActiveModelRole) throw new Error("Expected active model role handler");
		expect(extensionActions.getActiveModelRole()).toBe("vision");
		expect(getActiveModelRole).toHaveBeenCalledTimes(1);
	});
});
