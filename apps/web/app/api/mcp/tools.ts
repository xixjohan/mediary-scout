export const MCP_REGISTERED_TOOLS = [
  // ── 1. 影视搜索 ─────────────────────────────────────────────────────────────
  {
    name: "searchMedia",
    description: "在 TMDB 实时数据库中检索电影或剧集基本信息",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "影片名称或关键词" },
      },
    },
  },
  {
    name: "discoverMedia",
    description: "在 TMDB 实时数据库中按年份、分类类型（如科幻、动作、动画等）发现、推荐和筛选电影或剧集",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", description: "题材分类，例如：科幻、动作、动画、喜剧、悬疑等" },
        year: { type: "number", description: "上映年份，例如：2026、2025 等" },
        type: { type: "string", enum: ["movie", "tv"], description: "媒体类型：movie（电影）或 tv（剧集）" },
        sortBy: { type: "string", enum: ["popularity", "rating", "release_date"], description: "排序方式" },
      },
    },
  },
  {
    name: "getMediaDetail",
    description: "获取 TMDB 电影或剧集的详细信息、季集列表与演职员结构",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        type: { type: "string", enum: ["movie", "tv"], description: "媒体类型（默认 movie）" },
      },
    },
  },
  {
    name: "getTrendingMedia",
    description: "获取 TMDB 当前实时院线与流媒体流行榜单",
    inputSchema: {
      type: "object",
      properties: {
        timeWindow: { type: "string", enum: ["day", "week"], description: "时间窗口（默认 day）" },
        type: { type: "string", enum: ["movie", "tv", "all"], description: "媒体类型（默认 all）" },
      },
    },
  },

  // ── 2. 资源查询与刮削 ────────────────────────────────────────────────────────
  {
    name: "searchResources",
    description: "多源聚合网盘资源并发查询，返回网盘资源候选列表（包含清晰度、大小与分享源）",
    inputSchema: {
      type: "object",
      required: ["keyword"],
      properties: {
        keyword: { type: "string", description: "检索关键词或片名" },
        mediaType: { type: "string", enum: ["movie", "tv", "anime"], description: "媒体类型" },
        seasonNumber: { type: "number", description: "剧集季号（可选）" },
      },
    },
  },
  {
    name: "scrapeResourceMetadata",
    description: "文件名标准化刮削算法，提取片名、年份、季度、集数及分辨率与清晰度",
    inputSchema: {
      type: "object",
      required: ["rawTitle"],
      properties: {
        rawTitle: { type: "string", description: "待解析的原始文件或种子标题字符串" },
      },
    },
  },

  // ── 3. 订阅管理 ─────────────────────────────────────────────────────────────
  {
    name: "listSubscriptions",
    description: "分页列举当前在追影视追更订阅条目、追更状态与入库进度",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "completed", "all"], description: "订阅状态过滤" },
        page: { type: "number", description: "页码（默认 1）" },
        limit: { type: "number", description: "每页数量（默认 20）" },
      },
    },
  },
  {
    name: "getSubscriptionDetail",
    description: "查看单个影视作品的季集入库状态、缺失集数明细与追更策略",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        seasonNumber: { type: "number", description: "指定季号（可选）" },
      },
    },
  },
  {
    name: "subscribeMedia",
    description: "添加或更新影视剧作品的追更订阅与自动入库策略",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        type: { type: "string", enum: ["movie", "tv"], description: "媒体类型（电影或剧集）" },
        seasonNumber: { type: "number", description: "剧集季号（可选，默认第一季）" },
      },
    },
  },
  {
    name: "updateSubscription",
    description: "修改追更偏好、更新订阅状态或暂停订阅",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        seasonNumber: { type: "number", description: "剧集季号（可选）" },
        status: { type: "string", enum: ["active", "paused", "completed"], description: "目标状态" },
      },
    },
  },
  {
    name: "deleteSubscription",
    description: "取消影视追更订阅，并解除追踪状态",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        seasonNumber: { type: "number", description: "剧集季号（可选）" },
        mediaKind: { type: "string", enum: ["movie", "tv", "anime"], description: "媒体类别" },
      },
    },
  },

  // ── 4. 网盘管理 ─────────────────────────────────────────────────────────────
  {
    name: "getStorageDrives",
    description: "列举已绑定的网盘列表、协议类型与在线状态",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "checkDriveQuota",
    description: "查询网盘总空间、剩余容量及今日离线下载限额",
    inputSchema: {
      type: "object",
      properties: {
        storageId: { type: "string", description: "存储盘 ID（可选，默认主网盘）" },
      },
    },
  },
  {
    name: "listStorageFiles",
    description: "浏览或列举用户已绑定的网盘目录文件树（浅层安全浏览）",
    inputSchema: {
      type: "object",
      properties: {
        storageId: { type: "string", description: "存储盘 ID（可选，默认主网盘）" },
        dirId: { type: "string", description: "目录 ID（可选，默认根目录）" },
      },
    },
  },
  {
    name: "searchDriveFiles",
    description: "在已绑定的网盘存储中按关键词检索文件或目录",
    inputSchema: {
      type: "object",
      required: ["keyword"],
      properties: {
        keyword: { type: "string", description: "文件或文件夹搜索关键词" },
        storageId: { type: "string", description: "存储盘 ID（可选）" },
      },
    },
  },
  {
    name: "submitOfflineTask",
    description: "向已挂载的网盘提交磁力链接或 HTTP 下载链接离线转存任务",
    inputSchema: {
      type: "object",
      required: ["urls"],
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "磁力链接 (magnet:?xt=...) 或下载直链 URL 列表",
        },
        storageId: { type: "string", description: "目标存储网盘 ID（可选）" },
        directoryId: { type: "string", description: "存储目标文件夹 ID（可选）" },
      },
    },
  },
  {
    name: "getDriveDownloadUrl",
    description: "获取网盘文件的短期高速下载直链或播放直链",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: { type: "string", description: "网盘文件唯一 ID" },
        storageId: { type: "string", description: "存储盘 ID（可选）" },
        pickCode: { type: "string", description: "文件提取码（可选）" },
      },
    },
  },

  // ── 5. STRM 管理 ─────────────────────────────────────────────────────────────
  {
    name: "listStrmTasks",
    description: "列出 STRM 自动化生成任务及其执行周期、输出目录与运行状态",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "createStrmTask",
    description: "创建新的网盘目录到本地 STRM 虚拟映射与同步任务",
    inputSchema: {
      type: "object",
      required: ["name", "storageId", "remoteFolderId", "localOutputDir"],
      properties: {
        name: { type: "string", description: "任务名称" },
        storageId: { type: "string", description: "存储盘 ID" },
        remoteFolderId: { type: "string", description: "网盘源目录 ID" },
        localOutputDir: { type: "string", description: "本地 STRM 输出目录绝对路径" },
        deliveryMode: { type: "string", enum: ["redirect", "proxy", "auto"], description: "串流交付策略（默认 auto）" },
      },
    },
  },
  {
    name: "triggerStrmSync",
    description: "手动触发指定的 STRM 任务执行生成与孤儿清理",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", description: "STRM 任务 ID" },
        mode: { type: "string", enum: ["incremental", "full"], description: "同步模式（默认 incremental）" },
      },
    },
  },

  // ── 6. 第三方媒体库 ─────────────────────────────────────────────────────────
  {
    name: "listMediaServers",
    description: "列举已连接的 Emby/Jellyfin/Plex 媒体服务器实例配置与状态",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "syncMediaServerLibrary",
    description: "向第三方媒体服务器下发局部路径点对点刷新或全量扫描通知",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "媒体服务器实例 ID（全量扫描时必填）" },
        targetPath: { type: "string", description: "待刷新的局部文件/目录绝对路径（点对点增量防抖刷新）" },
      },
    },
  },
  {
    name: "testMediaServerConnection",
    description: "测试第三方媒体服务器连通性并拉取版本与媒体库清单",
    inputSchema: {
      type: "object",
      required: ["serverId"],
      properties: {
        serverId: { type: "string", description: "媒体服务器实例 ID" },
      },
    },
  },

  // ── 7. 动态扩展与插件 ───────────────────────────────────────────────────────
  {
    name: "listExtensions",
    description: "列举系统已安装的动态爬虫与网盘驱动插件",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "toggleExtension",
    description: "启用或停用指定的自定义扩展模块",
    inputSchema: {
      type: "object",
      required: ["extensionId", "enabled"],
      properties: {
        extensionId: { type: "string", description: "扩展插件唯一 ID" },
        enabled: { type: "boolean", description: "是否启用" },
      },
    },
  },

  // ── 8. 辅助状态与探针 ───────────────────────────────────────────────────────
  {
    name: "queryStatus",
    description: "查询当前后台正在进行的获取、转存、整理等任务进度",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "queryLibrary",
    description: "查询当前用户已订阅和追踪的影视列表",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "triggerAcquisition",
    description: "为已追踪的电影或指定季度创建一次按当前订阅策略执行的缺失资源搜索任务",
    inputSchema: {
      type: "object",
      required: ["tmdbId", "type"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        type: { type: "string", enum: ["movie", "tv", "anime"], description: "媒体类型" },
        seasonNumber: { type: "number", description: "剧集季号（可选）" },
        storageId: { type: "string", description: "目标网盘工作区 ID（可选，默认主网盘）" },
      },
    },
  },
  {
    name: "getSystemHealth",
    description: "获取巡影当前实例就绪状态、存储挂载与连通性探针",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const TOOL_TO_PERMISSION_MAP: Record<string, string> = {
  // 1. 影视搜索
  searchMedia: "media:search",
  discoverMedia: "media:detail",
  getMediaDetail: "media:detail",
  getTrendingMedia: "media:detail",

  // 2. 资源查询与刮削
  searchResources: "media:search",
  scrapeResourceMetadata: "media:detail",

  // 3. 订阅管理
  listSubscriptions: "media:subscribe",
  getSubscriptionDetail: "media:subscribe",
  subscribeMedia: "media:subscribe",
  updateSubscription: "media:subscribe",
  deleteSubscription: "media:subscribe",

  // 4. 网盘管理
  getStorageDrives: "storage:list",
  checkDriveQuota: "storage:quota",
  listStorageFiles: "storage:list",
  searchDriveFiles: "storage:list",
  submitOfflineTask: "storage:transfer",
  getDriveDownloadUrl: "storage:list",

  // 5. STRM 管理
  listStrmTasks: "strm:read",
  createStrmTask: "strm:manage",
  triggerStrmSync: "strm:manage",

  // 6. 第三方媒体库
  listMediaServers: "mediaserver:read",
  syncMediaServerLibrary: "mediaserver:sync",
  testMediaServerConnection: "mediaserver:manage",

  // 7. 动态扩展与插件
  listExtensions: "extension:read",
  toggleExtension: "extension:manage",

  // 8. 辅助状态与探针
  queryStatus: "workflow:status",
  queryLibrary: "media:detail",
  triggerAcquisition: "workflow:trigger",
  getSystemHealth: "system:health",
};
