import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import baseline from "./fixtures/bp-s1-scope-baseline.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

async function gitOutput(args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	return stdout;
}

async function changedPaths(): Promise<string[]> {
	const [baselineDiff, status] = await Promise.all([
		gitOutput(["diff", "--name-only", baseline.baselineCommit, "--"]),
		gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]),
	]);
	const paths = new Set(
		baselineDiff
			.split("\n")
			.map(value => value.trim())
			.filter(Boolean),
	);
	for (const line of status.split("\n")) {
		if (line.length < 4) continue;
		const statusPath = line.slice(3).trim();
		const renameTarget = statusPath.includes(" -> ") ? statusPath.slice(statusPath.indexOf(" -> ") + 4) : statusPath;
		paths.add(renameTarget);
	}
	return [...paths].sort();
}

describe("BP-S1 fork scope", () => {
	it("BP-S1 fork-only scope baseline and no live deployment", async () => {
		expect(baseline.schemaVersion).toBe(1);
		expect(baseline.deploymentPolicy).toBe("fork-proof-only-no-install-restart-commit-push-merge");
		expect(await gitOutput(["rev-parse", "--show-toplevel"])).toBe(`${REPO_ROOT}\n`);
		await gitOutput(["merge-base", "--is-ancestor", baseline.baselineCommit, "HEAD"]);

		const changed = await changedPaths();
		expect(changed.length).toBeGreaterThan(0);
		const allowlist = new Set<string>(baseline.allowedChanges);
		expect(changed.filter(file => !allowlist.has(file))).toEqual([]);
		for (const file of changed) {
			expect(baseline.forbiddenRepositoryPrefixes.some(prefix => file.startsWith(prefix))).toBe(false);
			expect(file).not.toMatch(/(?:^|\/)\.omp(?:\/|$)/);
			expect(file).not.toMatch(/(?:^|\/)(?:install|release|deploy)(?:\.|\/)/i);
		}
	});

	it("legacy binding unchanged", async () => {
		expect(baseline.legacyBindingPolicy).toBe("external-unmanaged-and-unchanged");
		const changed = await changedPaths();
		expect(changed.filter(file => file.includes("astaroth-pane-binding"))).toEqual([]);
		expect(changed.filter(file => file.includes("legacy-pane"))).toEqual([]);
		expect(baseline.allowedChanges.some(file => file.includes("astaroth-pane-binding"))).toBe(false);
	});

	it("no astaroth or dmg", async () => {
		expect(baseline.productPolicy).toBe("no-astaroth-source-or-dmg");
		const changed = await changedPaths();
		for (const file of changed) {
			for (const fragment of baseline.forbiddenPathFragments) {
				expect(file.toLowerCase()).not.toContain(fragment.toLowerCase());
			}
		}
		expect(changed.some(file => /(?:^|\/)astaroth(?:\/|$)/i.test(file))).toBe(false);
		expect(changed.some(file => /\.dmg$/i.test(file))).toBe(false);
		expect(changed.some(file => /Info\.plist$/i.test(file))).toBe(false);
	});
});
