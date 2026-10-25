/**
 * 媒体元数据端口（TMDB 官方 API + Worker 代理的统一抽象）。
 */

export type MediaType = "movie" | "tv";

export interface MediaMetadata {
  readonly tmdbId: number;
  readonly title: string;
  readonly originalTitle: string | null;
  readonly year: string | null;
  readonly overview: string | null;
  readonly posterUrl: string | null;
  readonly mediaType: MediaType;
}

export interface IMediaMetadataProvider {
  search(query: string, mediaType?: MediaType): Promise<MediaMetadata[]>;
  getDetail(tmdbId: number, mediaType: MediaType): Promise<MediaMetadata | null>;
}
