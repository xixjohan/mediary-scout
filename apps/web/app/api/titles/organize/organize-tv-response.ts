import { NextResponse } from "next/server";

/**
 * 剧集整理的响应构造。
 *
 * 从 `handleTvOrganize` 里抽出来的原因有两个：
 * 1. 处理器已经逼近 600 行预算，响应分支（已对齐 / 无变化 / 需人工）属于**展示层**，
 *    不该和编排逻辑混在一起；
 * 2. 文案与状态码集中在一处，方便前端与验收脚本按同一份契约断言。
 */
export interface TvOrganizeResponseInput {
  mediaLabel: string;
  title: string;
  /** 已拼接好的「归档/清理/未识别」后缀，可能为空串。 */
  cleanupSuffix: string;
  /** 缺扩展名未参与整理的文件数，前端据此挂出「一键补后缀」。 */
  unrecognizedCount: number;
  placedEpisodes: string[];
  totalArchived: number;
  reconciled: { totalReconciledSeasons: number; totalReconciledEpisodes: number };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function buildTvOrganizeResponse(input: TvOrganizeResponseInput): NextResponse {
  const { mediaLabel, title, cleanupSuffix, unrecognizedCount, placedEpisodes, totalArchived } = input;
  const reconciled = input.reconciled;

  if (placedEpisodes.length === 0 && totalArchived === 0) {
    if (reconciled.totalReconciledEpisodes > 0) {
      return NextResponse.json(
        {
          status: "organized",
          copy: `${mediaLabel}《${title}》文件已就绪，已成功对齐并点亮 ${reconciled.totalReconciledSeasons} 个季目录共 ${reconciled.totalReconciledEpisodes} 集物理正片${cleanupSuffix}，媒体库与订阅状态已更新！`,
          unrecognizedCount,
          moves: [],
        },
        { status: 200, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      {
        status: "manual_review",
        copy: "目录中未找到可整理的剧集视频文件或暂存目录。",
        review: { placeable: [], unresolved: [] },
      },
      { status: 200, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      status: "organized",
      copy: `${mediaLabel}《${title}》已整理就绪，共提取并规范命名 ${placedEpisodes.length} 集正片，自动归档 ${totalArchived} 个多余版本${cleanupSuffix}。`,
      unrecognizedCount,
      moves: placedEpisodes.map((code) => ({
        fileId: code,
        fileName: code,
        episodeCode: code,
        seasonNumber: 1,
      })),
    },
    { status: 200, headers: NO_STORE },
  );
}
