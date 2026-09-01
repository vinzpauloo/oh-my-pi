import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const PROVIDER_KEY = "anthropic:oauth";
// One usage-cache window plus a tick: blocks younger than this are never healed.
const STALE_BLOCK_GUARD_MS = 5 * 60_000 + 1;

function ageCredentialBlockRows(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE auth_credential_blocks SET updated_at = ?").run(
			Math.floor((Date.now() - STALE_BLOCK_GUARD_MS) / 1000),
		);
	} finally {
		db.close();
	}
}

function sharedLimit(windowId: "5h" | "7d", usedFraction: number): UsageLimit {
	return {
		id: `anthropic:${windowId}`,
		label: windowId === "5h" ? "Claude 5 Hour" : "Claude 7 Day",
		scope: { provider: "anthropic", windowId, shared: true },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + (windowId === "5h" ? HOUR_MS : WEEK_MS) },
		amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function tierLimit(tier: "fable" | "mythos", usedFraction: number): UsageLimit {
	return {
		id: `anthropic:7d:${tier}`,
		label: `Claude 7 Day (${tier})`,
		scope: { provider: "anthropic", windowId: "7d", tier },
		window: { id: "7d", label: "7 Day", resetsAt: Date.now() + WEEK_MS },
		amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function createReport(accountId: string, email: string, limits: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId, email },
	};
}

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

describe("AuthStorage Anthropic usage-block healing", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	async function seedBlockedPair(): Promise<{ blockedId: number; healthyId: number }> {
		if (!authStorage || !store?.upsertCredentialBlock) throw new Error("test setup failed");
		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-blocked", "blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);
		const rows = store.listAuthCredentials("anthropic");
		const byAccount = (accountId: string): number => {
			const row = rows.find(entry => entry.credential.type === "oauth" && entry.credential.accountId === accountId);
			if (!row) throw new Error(`missing credential ${accountId}`);
			return row.id;
		};
		return { blockedId: byAccount("acct-blocked"), healthyId: byAccount("acct-healthy") };
	}

	function persistStaleBlock(credentialId: number, blockScope: string): void {
		if (!store?.upsertCredentialBlock) throw new Error("test setup failed");
		store.upsertCredentialBlock({
			credentialId,
			providerKey: PROVIDER_KEY,
			blockScope,
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);
	}

	function block(credentialId: number, blockScope: string): number | undefined {
		if (!store?.getCredentialBlock) throw new Error("test setup failed");
		return store.getCredentialBlock(credentialId, PROVIDER_KEY, blockScope);
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-claude-healing-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("a healthy live report clears a stale persisted tier:fable block and the account is selectable again", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "tier:fable");
		expect(block(blockedId, "tier:fable")).toBeDefined();

		// The Fable weekly row reset to zero while the persisted block still ran to the old reset.
		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [
				sharedLimit("5h", 0.13),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 0),
			]),
		);
		usageByAccount.set(
			"acct-healthy",
			createReport("acct-healthy", "healthy@example.com", [
				sharedLimit("5h", 0.13),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 0.05),
			]),
		);
		const generationBefore = authStorage.getGeneration();

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "tier:fable")).toBeUndefined();
		expect(authStorage.getGeneration()).toBeGreaterThan(generationBefore);

		const selected = new Set<string>();
		for (let index = 0; index < 40; index += 1) {
			const apiKey = await authStorage.getApiKey("anthropic", `healed-${index}`, { modelId: "claude-fable-5-1" });
			if (apiKey) selected.add(apiKey);
		}
		expect(selected.has("api-acct-blocked")).toBe(true);
	});

	test("keeps a stale tier:fable block while the live Fable row is still confirmed exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "tier:fable");

		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [
				sharedLimit("5h", 0.13),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 1),
			]),
		);

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "tier:fable")).toBeDefined();
	});

	test("keeps a tier:fable block while a shared window that also gates Fable is exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "tier:fable");

		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [
				sharedLimit("5h", 1),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 0),
			]),
		);

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "tier:fable")).toBeDefined();
	});

	test("heals each tier scope against its own row", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "tier:fable");
		persistStaleBlock(blockedId, "tier:mythos");

		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [
				sharedLimit("5h", 0.13),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 0),
				tierLimit("mythos", 1),
			]),
		);

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "tier:fable")).toBeUndefined();
		expect(block(blockedId, "tier:mythos")).toBeDefined();
	});

	test("does not heal a block younger than one usage-cache window", async () => {
		if (!authStorage || !store?.upsertCredentialBlock) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		store.upsertCredentialBlock({
			credentialId: blockedId,
			providerKey: PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});

		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [
				sharedLimit("5h", 0.13),
				sharedLimit("7d", 0.03),
				tierLimit("fable", 0),
			]),
		);

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "tier:fable")).toBeDefined();
	});

	test("leaves an unscoped Anthropic block to expire on its own", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "");

		usageByAccount.set(
			"acct-blocked",
			createReport("acct-blocked", "blocked@example.com", [sharedLimit("5h", 0.13), sharedLimit("7d", 0.03)]),
		);

		await authStorage.fetchUsageReports();

		expect(block(blockedId, "")).toBeDefined();
	});

	test("does not cross-heal a sibling credential that shares an email under another org", async () => {
		if (!authStorage || !store?.upsertCredentialBlock) throw new Error("test setup failed");
		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-team", "shared@example.com"), orgId: "org-team" },
			{ type: "oauth", ...createCredential("acct-personal", "shared@example.com"), orgId: "org-personal" },
		]);
		const rows = store.listAuthCredentials("anthropic");
		const teamId = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "acct-team")?.id;
		if (teamId === undefined) throw new Error("missing team credential");
		persistStaleBlock(teamId, "tier:fable");

		usageByAccount.set("acct-personal", {
			...createReport("acct-personal", "shared@example.com", [
				sharedLimit("5h", 0.1),
				sharedLimit("7d", 0.1),
				tierLimit("fable", 0),
			]),
			metadata: { email: "shared@example.com", orgId: "org-personal" },
		});
		usageByAccount.set("acct-team", {
			...createReport("acct-team", "shared@example.com", [
				sharedLimit("5h", 0.1),
				sharedLimit("7d", 0.1),
				tierLimit("fable", 1),
			]),
			metadata: { email: "shared@example.com", orgId: "org-team" },
		});

		await authStorage.fetchUsageReports();

		expect(block(teamId, "tier:fable")).toBeDefined();
	});

	test("usage-health preflight re-polls a blocked account and reports it healthy once healed", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const { blockedId, healthyId } = await seedBlockedPair();
		persistStaleBlock(blockedId, "tier:fable");
		persistStaleBlock(healthyId, "tier:fable");

		const recovered = [sharedLimit("5h", 0.13), sharedLimit("7d", 0.03), tierLimit("fable", 0)];
		usageByAccount.set("acct-blocked", createReport("acct-blocked", "blocked@example.com", recovered));
		usageByAccount.set("acct-healthy", createReport("acct-healthy", "healthy@example.com", recovered));

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("healthy");
		expect(health.accounts.map(account => account.state)).toEqual(["healthy", "healthy"]);
		expect(block(blockedId, "tier:fable")).toBeUndefined();
		expect(block(healthyId, "tier:fable")).toBeUndefined();
	});
});
