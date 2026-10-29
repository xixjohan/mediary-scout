import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBuildCommitCacheForTest, readBuildCommit } from "./deployment-update-server";

const VALID_COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("readBuildCommit (Strategy & Chain of Responsibility)", () => {
  const originalGitSha = process.env.GIT_SHA;
  const originalBuildCommit = process.env.BUILD_COMMIT;
  const originalPublicGitSha = process.env.NEXT_PUBLIC_GIT_SHA;

  beforeEach(() => {
    delete process.env.GIT_SHA;
    delete process.env.BUILD_COMMIT;
    delete process.env.NEXT_PUBLIC_GIT_SHA;
    _resetBuildCommitCacheForTest();
  });

  afterEach(() => {
    if (originalGitSha !== undefined) process.env.GIT_SHA = originalGitSha;
    else delete process.env.GIT_SHA;

    if (originalBuildCommit !== undefined) process.env.BUILD_COMMIT = originalBuildCommit;
    else delete process.env.BUILD_COMMIT;

    if (originalPublicGitSha !== undefined) process.env.NEXT_PUBLIC_GIT_SHA = originalPublicGitSha;
    else delete process.env.NEXT_PUBLIC_GIT_SHA;

    _resetBuildCommitCacheForTest();
  });

  it("resolves from GIT_SHA environment variable with top priority", async () => {
    process.env.GIT_SHA = VALID_COMMIT;
    const commit = await readBuildCommit();
    expect(commit).toBe(VALID_COMMIT);
  });

  it("resolves from BUILD_COMMIT environment variable when GIT_SHA is not set", async () => {
    process.env.BUILD_COMMIT = VALID_COMMIT.toUpperCase();
    const commit = await readBuildCommit();
    expect(commit).toBe(VALID_COMMIT);
  });

  it("resolves from NEXT_PUBLIC_GIT_SHA when other env vars are absent", async () => {
    process.env.NEXT_PUBLIC_GIT_SHA = VALID_COMMIT;
    const commit = await readBuildCommit();
    expect(commit).toBe(VALID_COMMIT);
  });

  it("caches the resolved commit for subsequent calls", async () => {
    process.env.GIT_SHA = VALID_COMMIT;
    expect(await readBuildCommit()).toBe(VALID_COMMIT);

    delete process.env.GIT_SHA;
    // Should still return the cached commit
    expect(await readBuildCommit()).toBe(VALID_COMMIT);

    // After reset, it will re-evaluate
    _resetBuildCommitCacheForTest();
    // In this git workspace, it falls back to git cli strategy and gets HEAD sha
    const gitHead = await readBuildCommit();
    expect(gitHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ignores invalid commits in environment variables and proceeds through the chain", async () => {
    process.env.GIT_SHA = "not-a-valid-sha";
    const commit = await readBuildCommit();
    // Falls through to git rev-parse HEAD in this workspace
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
