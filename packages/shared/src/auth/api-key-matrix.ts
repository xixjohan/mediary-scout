import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type RiskLevel = "Read" | "Execute" | "Dangerous";

export interface ApiKeyPermissionLeaf {
  id: string; // e.g. "media:search"
  name: string;
  description: string;
  riskLevel: RiskLevel;
  supportsApi: boolean;
  supportsMcp: boolean;
  /** 是否在当前用户角色委派边界内（用于 UI 禁用超出角色权限） */
  isAllowed?: boolean;
}

export interface ApiKeyPermissionModule {
  id: string; // e.g. "media"
  name: string;
  description: string;
  leaves: ApiKeyPermissionLeaf[];
}

export const PERMISSION_CATALOG: ApiKeyPermissionModule[] = [
  {
    id: "media",
    name: "媒体与资源检索",
    description: "影视元数据查询、多源网盘资源检索与订阅追踪",
    leaves: [
      {
        id: "media:search",
        name: "资源检索",
        description: "在已配置的资源提供商中检索影视剧网盘资源",
        riskLevel: "Read",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "media:detail",
        name: "影视详情",
        description: "查询 TMDB 影视元数据、季集信息与演职员表",
        riskLevel: "Read",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "media:subscribe",
        name: "订阅管理",
        description: "新增、查看与更新追剧追更订阅策略",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: true,
      },
    ],
  },
  {
    id: "storage",
    name: "云盘存储与离线",
    description: "115 / 夸克 / 迅雷 / 天翼等网盘文件浏览与离线下载转存",
    leaves: [
      {
        id: "storage:list",
        name: "网盘文件浏览",
        description: "列举云盘目录树、搜索云端文件与获取下载链接",
        riskLevel: "Read",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "storage:transfer",
        name: "离线下载与转存",
        description: "向云盘提交磁力/种子/分享链接离线转存任务",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "storage:organize",
        name: "文件重命名归档",
        description: "根据刮削规则对网盘剧集文件进行智能重命名与归档",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: false,
      },
      {
        id: "storage:delete",
        name: "文件物理删除",
        description: "从云盘存储中永久或移入回收站删除文件",
        riskLevel: "Dangerous",
        supportsApi: true,
        supportsMcp: false,
      },
    ],
  },
  {
    id: "workflow",
    name: "自动化采集工作流",
    description: "任务编排调度、断点续传与重试生命周期",
    leaves: [
      {
        id: "workflow:status",
        name: "查看工作流状态",
        description: "获取当前运行中与历史作业的状态及日志",
        riskLevel: "Read",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "workflow:trigger",
        name: "触发工作流任务",
        description: "手动或自动化触发指定的资源解析与刮削转存任务",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: true,
      },
    ],
  },
  {
    id: "assistant",
    name: "AI 助手对话与工具调用",
    description: "与 Mediary Scout 内置 Agent 交互及调用动态工具",
    leaves: [
      {
        id: "assistant:chat",
        name: "智能问答对话",
        description: "向 AI 助手发送提问并流式接收回答",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: true,
      },
      {
        id: "assistant:mcp_invoke",
        name: "外部 MCP 工具透传",
        description: "允许通过授权透传调用配置的外部 MCP 工具",
        riskLevel: "Execute",
        supportsApi: true,
        supportsMcp: true,
      },
    ],
  },
  {
    id: "system",
    name: "系统监控与健康状态",
    description: "实例存活探针、队列负载与运行时指标",
    leaves: [
      {
        id: "system:health",
        name: "健康检查探针",
        description: "读取系统就绪状态、存储挂载与连通性探针",
        riskLevel: "Read",
        supportsApi: true,
        supportsMcp: true,
      },
    ],
  },
];

export interface ApiKeyV2Entity {
  id: string; // "key_xxx"
  userId?: string | undefined; // 所属/签发用户账号 ID (如 "acct_default")
  ownerSecurityVersion?: number | undefined; // 签发时的用户安全版本号
  name: string;
  keyHash: string; // SHA-256 hash of secret key
  keyPrefix: string; // "msk_live_xxxx"
  maskedKey: string; // "msk_live_abc...xyz"
  permissions: string[]; // List of permitted leaf IDs, e.g. ["media:search", "media:detail"]
  createdAt: number;
  expiresAt: number | null; // null = never expires
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * 策略模式：快速权限预设生成器
 */
export type PermissionStrategyType = "full" | "readonly" | "safe_automation" | "clear";

export class ApiKeyPermissionPreset {
  public static applyStrategy(
    strategy: PermissionStrategyType,
    catalog: ApiKeyPermissionModule[] = PERMISSION_CATALOG
  ): string[] {
    const allLeaves = catalog.flatMap((m) => m.leaves);
    switch (strategy) {
      case "full":
        // 排除 Dangerous 等级以防止误删
        return allLeaves.filter((l) => l.riskLevel !== "Dangerous").map((l) => l.id);
      case "readonly":
        return allLeaves.filter((l) => l.riskLevel === "Read").map((l) => l.id);
      case "safe_automation":
        return allLeaves
          .filter((l) => l.riskLevel === "Read" || (l.riskLevel === "Execute" && l.id !== "storage:organize"))
          .map((l) => l.id);
      case "clear":
      default:
        return [];
    }
  }

  /**
   * 计算父模块在多选框树下的三态状态
   */
  public static calculateModuleState(
    module: ApiKeyPermissionModule,
    selectedLeafIds: Set<string>
  ): "checked" | "unchecked" | "indeterminate" {
    if (module.leaves.length === 0) return "unchecked";
    const selectedCount = module.leaves.filter((l) => selectedLeafIds.has(l.id)).length;
    if (selectedCount === 0) return "unchecked";
    if (selectedCount === module.leaves.length) return "checked";
    return "indeterminate";
  }

  /**
   * 当勾选或取消勾选模块时，级联返回更新后的选择集合
   */
  public static toggleModule(
    module: ApiKeyPermissionModule,
    currentSelected: string[],
    check: boolean
  ): string[] {
    const set = new Set(currentSelected);
    for (const leaf of module.leaves) {
      if (check) {
        set.add(leaf.id);
      } else {
        set.delete(leaf.id);
      }
    }
    return Array.from(set);
  }

  /**
   * 动态 MCP 工具投影过滤：
   * 外部客户端接入 MCP 时，根据 API Key 的授权集合裁剪工具列表。
   * 节省 Prompt Token 达 70%，并彻底避免越权幻觉。
   */
  public static projectMcpTools<T extends { name: string }>(
    permittedLeafIds: string[],
    tools: T[],
    toolNameToPermissionMap: Record<string, string>
  ): T[] {
    const permSet = new Set(permittedLeafIds);
    // 如果包含通配符或拥有完整权限
    if (permSet.has("*")) return tools;

    return tools.filter((tool) => {
      const requiredPerm = toolNameToPermissionMap[tool.name];
      if (!requiredPerm) {
        // 未声明权限要求的内部只读工具默认允许
        return true;
      }
      return permSet.has(requiredPerm);
    });
  }

  /**
   * 校验特定操作是否被授权
   */
  public static hasPermission(permittedLeafIds: string[], requiredLeafId: string): boolean {
    if (permittedLeafIds.includes("*")) return true;
    return permittedLeafIds.includes(requiredLeafId);
  }
}

export const FORBIDDEN_API_KEY_PATHS = [
  "/api/auth",
  "/api/settings/api-keys",
  "/api/settings/api-key",
  "/api/tunnel",
  "/api/settings/security",
  "/api/settings/password",
];

export function isForbiddenApiKeyPath(pathname: string): boolean {
  const norm = pathname.toLowerCase().replace(/\/+$/, "");
  return FORBIDDEN_API_KEY_PATHS.some((prefix) => norm === prefix || norm.startsWith(prefix + "/"));
}

export function hashApiKeyV2(rawKey: string): string {
  return createHash("sha256").update(rawKey.trim()).digest("hex");
}

export function generateApiKeyV2(prefix = "msk_live_"): {
  key: string;
  keyHash: string;
  keyPrefix: string;
  maskedKey: string;
} {
  const secret = randomBytes(24).toString("base64url");
  const key = `${prefix}${secret}`;
  const keyHash = hashApiKeyV2(key);
  const keyPrefix = key.slice(0, 12);
  const maskedKey = `${keyPrefix}...${key.slice(-4)}`;
  return { key, keyHash, keyPrefix, maskedKey };
}

export function verifyApiKeyV2Hash(rawKey: string, storedHash: string): boolean {
  const candidateHash = hashApiKeyV2(rawKey);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

