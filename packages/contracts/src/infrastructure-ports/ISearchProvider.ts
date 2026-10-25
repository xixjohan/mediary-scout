/**
 * 资源检索提供商端口（PanSou / Prowlarr 等聚合源的统一抽象）。
 * 具体适配器属于 Infrastructure 层，Features 只依赖本端口。
 */

export interface ResourceCandidate {
  readonly title: string;
  readonly sizeBytes: number | null;
  readonly shareUrl: string | null;
  readonly magnetUrl: string | null;
  /** 来源标识，如 "pansou" / "prowlarr" */
  readonly source: string;
  readonly metadata: Record<string, unknown>;
}

export interface SearchQuery {
  readonly keyword: string;
  /** 限定媒体类型，缩小检索范围 */
  readonly mediaType?: "movie" | "tv";
  readonly maxResults?: number;
}

export interface ISearchProvider {
  readonly source: string;
  search(query: SearchQuery): Promise<ResourceCandidate[]>;
}
