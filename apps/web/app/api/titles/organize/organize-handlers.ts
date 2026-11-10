import { NextResponse } from "next/server";
import {
  buildOrganizeRun,
  executeOrganizePlan,
  organizeDriftCopy,
  organizePlanCopy,
  planOrganizeMoves,
  MediaOrganizer,
  StorageArchiveAdapter,
  ensureMediaLibraryDirectory,
  type OrganizePlan,
  type TrackedSeasonState,
} from "@media-track/workflow";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function reviewPayload(plan: Extract<OrganizePlan, { kind: "manual_review" }>) {
  return {
    copy: organizePlanCopy(plan),
    review: {
      placeable: plan.moves.map((move) => ({
        fileId: move.fileId,
        fileName: move.fileName,
        episodeCode: move.episodeCode,
        seasonNumber: move.seasonNumber,
      })),
      unresolved: plan.unresolved.map((entry) => ({
        fileId: entry.fileId,
        fileName: entry.fileName,
        reason: entry.reason,
        ...(entry.suggestedSeasonNumber === undefined
          ? {}
          : { suggestedSeasonNumber: entry.suggestedSeasonNumber }),
        ...(entry.suggestedEpisodeCode === undefined
          ? {}
          : { suggestedEpisodeCode: entry.suggestedEpisodeCode }),
      })),
    },
  };
}

export async function resolveCanonicalMovieDirectory(
  storage: any,
  moviesParentDirectoryId: string | undefined,
  title: TrackedSeasonState["title"],
  fallbackDirId: string,
): Promise<string> {
  if (!moviesParentDirectoryId) return fallbackDirId;
  try {
    const canonicalDirId = await ensureMediaLibraryDirectory({
      executor: storage,
      parentId: moviesParentDirectoryId,
      title: title.title,
      year: title.year ?? "—",
      tmdbId: title.tmdbId,
    });
    return canonicalDirId || fallbackDirId;
  } catch {
    return fallbackDirId;
  }
}

export async function persistReconciledMovieDirectory(input: {
  accountId: string;
  connectedStorageId?: string | null | undefined;
  title: TrackedSeasonState["title"];
  season: TrackedSeasonState["season"];
  targetMovieDirectoryId: string;
}): Promise<void> {
  try {
    const repo = getWorkflowRepository();
    await repo.saveWorkflowRunSnapshot({
      accountId: input.accountId,
      connectedStorageId: input.connectedStorageId ?? null,
      title: input.title as any,
      season: {
        ...input.season,
        storageDirectoryId: input.targetMovieDirectoryId,
      },
      workflowRun: {
        id: crypto.randomUUID(),
        kind: "title_organize",
        status: "succeeded",
        trackedSeasonId: input.season.id,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        auditEvents: [
          {
            type: "movie_directory_reconciled",
            message: `自愈校准电影主目录: ${input.targetMovieDirectoryId}`,
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      keepCurrentEpisodes: true,
    });
  } catch (e) {
    console.warn("[organize] Failed to persist reconciled movie directory:", e);
  }
}

export async function resolveCanonicalTvDirectory(
  storage: any,
  tvParentDirectoryId: string | undefined,
  title: TrackedSeasonState["title"],
  fallbackDirId: string,
): Promise<string> {
  if (!tvParentDirectoryId) return fallbackDirId;
  try {
    const canonicalDirId = await ensureMediaLibraryDirectory({
      executor: storage,
      parentId: tvParentDirectoryId,
      title: title.title,
      year: title.year ?? "—",
      tmdbId: title.tmdbId,
    });
    return canonicalDirId || fallbackDirId;
  } catch {
    return fallbackDirId;
  }
}

export async function findTvStagingDirectories(
  storage: any,
  showDirectoryId: string,
  sourceDirectoryId: string,
): Promise<Array<{ id: string; name: string }>> {
  const stagingDirs: Array<{ id: string; name: string }> = [];

  if (sourceDirectoryId !== showDirectoryId) {
    try {
      const parentListing = await storage.listChildDirectories(showDirectoryId);
      const isStaging = parentListing.some(
        (d: { id: string; name: string }) =>
          d.id === sourceDirectoryId && d.name.toLowerCase().startsWith("staging-"),
      );
      if (isStaging) {
        stagingDirs.push({ id: sourceDirectoryId, name: "staging" });
      }
    } catch {
      // ignore
    }
  }

  try {
    const childDirs = await storage.listChildDirectories(showDirectoryId);
    console.log("[findTvStagingDirectories] showDirectoryId:", showDirectoryId, "childDirs:", childDirs);
    for (const child of childDirs) {
      if (child.name.toLowerCase().startsWith("staging-") && !stagingDirs.some((s) => s.id === child.id)) {
        stagingDirs.push({ id: child.id, name: child.name });
      }
    }
  } catch (err) {
    console.warn("[organize] listChildDirectories failed:", err);
  }

  return stagingDirs;
}

export async function reconcileTvSeasonDirectories(input: {
  storage: any;
  accountId: string;
  connectedStorageId?: string | null;
  title: TrackedSeasonState["title"];
  showDirectoryId: string;
}): Promise<void> {
  try {
    const repo = getWorkflowRepository();
    const states = await repo.listTrackedSeasonStates(input.accountId);
    const showChildren = await input.storage.listChildDirectories(input.showDirectoryId);
    const seasonDirs = showChildren.filter((d: { name: string }) => /^Season\s+\d+$/i.test(d.name));

    for (const seasonDir of seasonDirs) {
      const match = /^Season\s+(\d+)$/i.exec(seasonDir.name);
      if (!match?.[1]) continue;
      const seasonNum = Number(match[1]);
      const matchedState = states.find(
        (s) => s.title.tmdbId === input.title.tmdbId && s.season?.seasonNumber === seasonNum,
      );
      if (!matchedState?.season) continue;

      await repo.saveWorkflowRunSnapshot({
        accountId: input.accountId,
        connectedStorageId: input.connectedStorageId ?? null,
        title: input.title as any,
        season: {
          ...matchedState.season,
          storageDirectoryId: seasonDir.id,
        },
        workflowRun: {
          id: crypto.randomUUID(),
          kind: "title_organize",
          status: "succeeded",
          trackedSeasonId: matchedState.season.id,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          auditEvents: [
            {
              type: "tv_directory_reconciled",
              message: `自愈校准剧集第 ${seasonNum} 季目录: ${seasonDir.id}`,
            },
          ],
        },
        episodes: [],
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
        keepCurrentEpisodes: true,
      });
    }
  } catch (err) {
    console.warn("[organize] Reconcile tv seasons failed:", err);
  }
}

export async function handleTvDeterministicExecution(input: {
  storage: any;
  plan: Extract<OrganizePlan, { kind: "deterministic" }>;
  run: ReturnType<typeof buildOrganizeRun>;
}): Promise<NextResponse> {
  const { storage, plan, run } = input;
  const recordedEvents = [...run.workflowRun.auditEvents];
  const execution = await executeOrganizePlan({
    storage,
    plan,
    persist: async (event) => {
      recordedEvents.push(event);
      await getWorkflowRepository().saveWorkflowRunSnapshot({
        ...run,
        workflowRun: {
          ...run.workflowRun,
          auditEvents: [...recordedEvents],
        },
        keepCurrentEpisodes: true,
      });
    },
  });

  if (execution.status !== "organized") {
    const failureCopy =
      execution.status === "drift"
        ? organizeDriftCopy(execution.drift)
        : execution.status === "failed"
          ? execution.error
          : organizePlanCopy(plan);
    await getWorkflowRepository().saveWorkflowRunSnapshot({
      ...run,
      workflowRun: {
        ...run.workflowRun,
        status: "failed",
        auditEvents: [...recordedEvents],
      },
      keepCurrentEpisodes: true,
    });
    return NextResponse.json(
      {
        status: execution.status,
        copy: failureCopy,
      },
      { status: 409, headers: NO_STORE },
    );
  }

  await getWorkflowRepository().saveWorkflowRunSnapshot({
    ...run,
    workflowRun: {
      ...run.workflowRun,
      auditEvents: [...recordedEvents],
    },
    keepCurrentEpisodes: true,
  });
  return NextResponse.json(
    {
      status: "organized",
      copy: organizePlanCopy(plan),
      moves: plan.moves.map((move) => ({
        fileId: move.fileId,
        fileName: move.fileName,
        episodeCode: move.episodeCode,
        seasonNumber: move.seasonNumber,
      })),
    },
    { status: 200, headers: NO_STORE },
  );
}

export async function handleMovieOrganize(input: {
  storage: any;
  title: TrackedSeasonState["title"];
  sourceDirectoryId: string;
  connectedStorageId?: string | null;
  moviesParentDirectoryId?: string | undefined;
  season?: TrackedSeasonState["season"] | undefined;
  accountId: string;
}): Promise<NextResponse> {
  const targetMovieDirectoryId = await resolveCanonicalMovieDirectory(
    input.storage,
    input.moviesParentDirectoryId,
    input.title,
    input.sourceDirectoryId,
  );

  const archiveAdapter = new StorageArchiveAdapter({
    storage: input.storage,
    rootCid: input.moviesParentDirectoryId ?? input.connectedStorageId ?? null,
  });
  const organizer = new MediaOrganizer({
    storage: input.storage,
    archiveAdapter,
  });

  const result = await organizer.organizeMovieDirectory({
    movieDirectoryId: targetMovieDirectoryId,
    title: input.title.title,
    year: input.title.year,
    tmdbId: input.title.tmdbId,
    fallbackCategoryParentId: input.moviesParentDirectoryId ?? targetMovieDirectoryId,
  });

  if (result.status === "no_media") {
    return NextResponse.json(
      {
        status: "manual_review",
        copy: "目录中未找到可整理的电影视频文件。",
        review: { placeable: [], unresolved: [] },
      },
      { status: 200, headers: NO_STORE },
    );
  }

  if (targetMovieDirectoryId !== input.sourceDirectoryId && input.season) {
    await persistReconciledMovieDirectory({
      accountId: input.accountId,
      connectedStorageId: input.connectedStorageId,
      title: input.title,
      season: input.season,
      targetMovieDirectoryId,
    });
  }

  return NextResponse.json(
    {
      status: "organized",
      copy: `电影已整理就绪（最优正片：${result.primaryMovie?.name ?? "已放置"}），已自动归档 ${result.archivedCount} 个多余版本。`,
      moves: result.primaryMovie
        ? [
            {
              fileId: result.primaryMovie.id,
              fileName: result.primaryMovie.name,
              episodeCode: "MOVIE",
              seasonNumber: 1,
            },
          ]
        : [],
    },
    { status: 200, headers: NO_STORE },
  );
}

export async function handleTvOrganize(input: {
  storage: any;
  title: TrackedSeasonState["title"];
  sourceDirectoryId: string;
  connectedStorageId?: string | null;
  tvParentDirectoryId?: string | undefined;
  season?: TrackedSeasonState["season"] | undefined;
  accountId: string;
}): Promise<NextResponse> {
  let showDirectoryId = input.sourceDirectoryId;

  let childDirsOfSource: Array<{ id: string; name: string }> = [];
  try {
    childDirsOfSource = await input.storage.listChildDirectories(input.sourceDirectoryId);
  } catch (err) {
    console.warn("[organize] listChildDirectories for source failed:", err);
  }

  const hasStagingOrSeason = childDirsOfSource.some(
    (d) => d.name.toLowerCase().startsWith("staging-") || /^Season\s+\d+$/i.test(d.name),
  );

  if (!hasStagingOrSeason) {
    const canonicalShowDirId = await resolveCanonicalTvDirectory(
      input.storage,
      input.tvParentDirectoryId,
      input.title,
      input.sourceDirectoryId,
    );
    showDirectoryId = canonicalShowDirId;
  }

  const archiveAdapter = new StorageArchiveAdapter({
    storage: input.storage,
    rootCid: input.tvParentDirectoryId ?? input.connectedStorageId ?? null,
  });
  const organizer = new MediaOrganizer({
    storage: input.storage,
    archiveAdapter,
  });

  const stagingDirs = await findTvStagingDirectories(input.storage, showDirectoryId, input.sourceDirectoryId);
  const allPlaced: string[] = [];
  let totalArchived = 0;

  for (const st of stagingDirs) {
    const res = await organizer.organizeStagingDirectory({
      stagingDirectoryId: st.id,
      showDirectoryId,
      title: input.title.title,
      type: input.title.type === "anime" ? "anime" : "tv",
      year: input.title.year,
      tmdbId: input.title.tmdbId,
      fallbackCategoryParentId: input.tvParentDirectoryId ?? showDirectoryId,
    });

    if (res.status === "organized") {
      allPlaced.push(...res.placedEpisodes);
      totalArchived += res.archivedCount;
    }
  }

  await reconcileTvSeasonDirectories({
    storage: input.storage,
    accountId: input.accountId,
    connectedStorageId: input.connectedStorageId ?? null,
    title: input.title,
    showDirectoryId,
  });

  if (allPlaced.length === 0 && totalArchived === 0) {
    return NextResponse.json(
      {
        status: "manual_review",
        copy: "目录中未找到可整理的剧集视频文件或暂存目录。",
        review: { placeable: [], unresolved: [] },
      },
      { status: 200, headers: NO_STORE },
    );
  }

  const mediaLabel = input.title.type === "anime" ? "动漫" : "剧集";
  return NextResponse.json(
    {
      status: "organized",
      copy: `${mediaLabel}《${input.title.title}》已整理就绪，共提取并规范命名 ${allPlaced.length} 集正片，自动归档 ${totalArchived} 个多余版本。`,
      moves: allPlaced.map((code) => ({
        fileId: code,
        fileName: code,
        episodeCode: code,
        seasonNumber: 1,
      })),
    },
    { status: 200, headers: NO_STORE },
  );
}

export async function handleLegacyTvOrganize(input: {
  storage: any;
  title: TrackedSeasonState["title"];
  season: TrackedSeasonState["season"];
  sourceDirectoryId: string;
  accountId: string;
  connectedStorageId?: string | null;
}): Promise<NextResponse> {
  const { storage, title, season, sourceDirectoryId, accountId, connectedStorageId } = input;
  const files = await storage.listVideoFiles(sourceDirectoryId);

  const targetSeasons = season === undefined ? [] : [season.seasonNumber];
  const plan: OrganizePlan =
    targetSeasons.length === 0
      ? { kind: "manual_review", moves: [], unresolved: [] }
      : planOrganizeMoves({
          files: files.map((file: any) => ({ fileId: file.id, fileName: file.name })),
          targetSeasons,
          resolveTargetDirectory: () => sourceDirectoryId,
        });

  const run = buildOrganizeRun({
    title: title as unknown as Parameters<typeof buildOrganizeRun>[0]["title"],
    season: season as unknown as Parameters<typeof buildOrganizeRun>[0]["season"],
    sourceDirectoryId,
    plan,
    accountId,
    connectedStorageId: connectedStorageId ?? null,
    now: new Date().toISOString(),
  });

  if (plan.kind !== "deterministic") {
    await getWorkflowRepository().saveWorkflowRunSnapshot({ ...run, keepCurrentEpisodes: true });
    return NextResponse.json(
      { status: "manual_review", ...reviewPayload(plan) },
      { status: 200, headers: NO_STORE },
    );
  }

  return handleTvDeterministicExecution({ storage, plan, run });
}
