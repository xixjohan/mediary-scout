import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateRuntimeConfig } from "../../src/index.js";

describe("validateRuntimeConfig", () => {
  it("accepts the live trio (pansou + 115 + vercel-ai)", () => {
    expect(() =>
      validateRuntimeConfig({
        MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
        MEDIA_TRACK_STORAGE_ADAPTER: "115",
        MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid agent adapter value like 'real'", () => {
    expect(() => validateRuntimeConfig({ MEDIA_TRACK_AGENT_ADAPTER: "real" })).toThrow(
      /MEDIA_TRACK_AGENT_ADAPTER_INVALID/,
    );
  });

  it("rejects live workflow/storage without the vercel-ai agent", () => {
    expect(() =>
      validateRuntimeConfig({
        MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
        MEDIA_TRACK_STORAGE_ADAPTER: "115",
        MEDIA_TRACK_AGENT_ADAPTER: "fake",
      }),
    ).toThrow(/MEDIA_TRACK_AGENT_ADAPTER_REQUIRED_FOR_LIVE_WORKFLOW/);
  });

  it("accepts the fake agent adapter (no live provider/storage)", () => {
    expect(() => validateRuntimeConfig({ MEDIA_TRACK_AGENT_ADAPTER: "fake" })).not.toThrow();
  });

  it("accepts an unset agent adapter", () => {
    expect(() => validateRuntimeConfig({})).not.toThrow();
  });
});

describe("docker-compose.yml web service config", () => {
  it("ships a valid runtime config (regression guard for the MEDIA_TRACK_AGENT_ADAPTER=real outage)", () => {
    // Resolve relative to THIS test file so it works regardless of the vitest
    // working directory (process.cwd() would require running from the repo root).
    const composePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docker-compose.yml");
    const compose = parse(readFileSync(composePath, "utf8")) as {
      services: { web: { environment: Record<string, string> } };
    };
    const webEnv = compose.services.web.environment;
    expect(webEnv).toBeTruthy();
    expect(webEnv.MEDIA_TRACK_AGENT_ADAPTER).toBeDefined();
    expect(() => validateRuntimeConfig(webEnv)).not.toThrow();
  });

  // H1：更新链「四处同源」此前只有 updater 脚本那一处有用例——compose 的镜像
  // 推导与透传删掉后全量 5195 用例照样全绿（第四轮复核实测）。这里把它们钉住。
  it("H1：web/worker 镜像默认值由更新源推导，且 web 与 updater 透传同一个更新源", () => {
    const composePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docker-compose.yml");
    const compose = parse(readFileSync(composePath, "utf8")) as {
      services: {
        web: { image: string; environment: Record<string, string> };
        worker: { image: string };
        updater: { environment: Record<string, string> };
      };
    };
    const derived = "ghcr.io/${MEDIA_TRACK_UPDATE_REPO:-xixjohan/mediary-scout}:latest";
    // 两处镜像默认值都必须从更新源推导，且互不相同地写死上游
    expect(compose.services.web.image).toBe("${MEDIARY_IMAGE:-" + derived + "}");
    expect(compose.services.worker.image).toBe("${MEDIARY_IMAGE:-" + derived + "}");
    // 宿主设了 MEDIA_TRACK_UPDATE_REPO 时，web 与 updater 必须看到同一个值
    expect(compose.services.web.environment.MEDIA_TRACK_UPDATE_REPO).toBe("${MEDIA_TRACK_UPDATE_REPO:-}");
    expect(compose.services.updater.environment.MEDIA_TRACK_UPDATE_REPO).toBe("${MEDIA_TRACK_UPDATE_REPO:-}");
    // 不再残留写死的上游镜像默认值
    expect(compose.services.web.image).not.toContain("fancydirty");
    expect(compose.services.worker.image).not.toContain("fancydirty");
  });

  it("gives the Docker socket only to updater, and the token volume to web read-only", () => {
    const composePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docker-compose.yml");
    const compose = parse(readFileSync(composePath, "utf8")) as {
      services: {
        web: { volumes?: string[]; privileged?: boolean };
        updater: { ports?: unknown; privileged?: boolean; volumes?: string[] };
      };
    };
    const updater = compose.services.updater;
    expect(updater).toBeTruthy();
    expect(updater.ports).toBeUndefined();
    expect(updater.privileged).toBeUndefined();
    expect(updater.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    const web = compose.services.web;
    expect(web.privileged).toBeUndefined();
    expect(web.volumes).toContain("updater-state:/updater-state:ro");
    expect(web.volumes?.some((mount) => mount.includes("docker.sock"))).toBe(false);
  });

  it("starts the updater with an exec-form node ENTRYPOINT", () => {
    // docker:*-cli's own entrypoint prepends `docker` to a CMD that is a docker
    // subcommand, and `node` is one: `CMD ["node", ...]` runs `docker node ...`.
    const dockerfile = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/updater/Dockerfile"), "utf8");
    const lines = dockerfile.split("\n").map((line) => line.trim());
    expect(lines).toContain('ENTRYPOINT ["node", "server.mjs"]');
    expect(lines.some((line) => /^CMD\b/.test(line))).toBe(false);
  });

  it("keeps database dumps out of the image build context and out of git", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const entries = (file: string) =>
      readFileSync(resolve(root, file), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    expect(entries(".dockerignore")).toContain("backups");
    expect(entries(".gitignore")).toContain("/backups/");
  });
});
