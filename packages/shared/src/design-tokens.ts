/**
 * Design Tokens (设计令牌系统)
 *
 * 遵循 W3C DTCG 规范，定义 Mediary Scout 系统的三层设计令牌（Primitive / Semantic / Component）。
 * 视觉风格对标 Spotify / Apple 极简深色沉浸式设计：
 *   - 基底色：深灰近黑 (#121212)
 *   - 主辅色：Spotify Green (#1ed760)
 *   - 语义状态：Negative/Danger (#f3727f), Warning (#ffa42b), Info (#539df5)
 *   - 几何形态：全胶囊 (9999px) 按钮与圆角卡片
 */

export const DESIGN_TOKENS = {
  colors: {
    // 1. 背景层级 (Surfaces)
    bgBase: "#121212",
    bgSurface: "#181818",
    bgRaised: "#1f1f1f",
    bgCard: "#252525",
    bgCardAlt: "#272727",
    bgHover: "rgba(255, 255, 255, 0.05)",
    bgActive: "rgba(255, 255, 255, 0.08)",
    bgBackdrop: "rgba(0, 0, 0, 0.75)",

    // 2. 主品牌/强调色 (Brand / Accent)
    accent: "#1ed760",
    accentHover: "#3be477",
    accentPress: "#169c46",
    accentSubtle: "rgba(30, 215, 96, 0.12)",
    accentSubtleBorder: "rgba(30, 215, 96, 0.28)",

    // 3. 语义状态反馈 (Semantic Status)
    danger: "#f3727f",
    dangerHover: "#ff8591",
    dangerSubtle: "rgba(243, 114, 127, 0.12)",
    dangerBorder: "rgba(243, 114, 127, 0.28)",

    warning: "#ffa42b",
    warningHover: "#ffb44d",
    warningSubtle: "rgba(255, 164, 43, 0.12)",
    warningBorder: "rgba(255, 164, 43, 0.28)",

    info: "#539df5",
    infoHover: "#6caaf7",
    infoSubtle: "rgba(83, 157, 245, 0.12)",
    infoBorder: "rgba(83, 157, 245, 0.28)",

    success: "#1ed760",
    successSubtle: "rgba(30, 215, 96, 0.12)",

    // 4. 文字层级 (Typography Colors)
    textPrimary: "#ffffff",
    textSoft: "#cbcbcb",
    textMuted: "#b3b3b3",
    textFaint: "#8f8f8f",

    // 5. 边框与分割线 (Borders & Dividers)
    border: "#4d4d4d",
    borderSoft: "#7c7c7c",
    borderSubtle: "rgba(255, 255, 255, 0.1)",
    divider: "#2a2a2a",

    // 6. 媒体与文件类型分类色板 (Media & File Categories)
    fileFolder: "#f59e0b",
    fileFolderBg: "rgba(245, 158, 11, 0.12)",
    fileVideo: "#38bdf8",
    fileVideoBg: "rgba(56, 189, 248, 0.12)",
    fileSubtitle: "#a78bfa",
    fileSubtitleBg: "rgba(167, 139, 250, 0.12)",
    fileAudio: "#f472b6",
    fileAudioBg: "rgba(244, 114, 182, 0.12)",
    fileArchive: "#fb923c",
    fileArchiveBg: "rgba(251, 146, 60, 0.12)",
    fileImage: "#34d399",
    fileImageBg: "rgba(52, 211, 153, 0.12)",
    fileGeneric: "#94a3b8",
    fileGenericBg: "rgba(148, 163, 184, 0.12)",
  },

  radii: {
    xs: "2px",
    sm: "4px",
    md: "6px",
    lg: "8px",
    xl: "12px",
    pill: "9999px",
  },

  shadows: {
    sm: "0 1px 3px rgba(0, 0, 0, 0.3)",
    md: "0 4px 12px rgba(0, 0, 0, 0.4)",
    lg: "0 8px 24px rgba(0, 0, 0, 0.5)",
    heavy: "rgba(0, 0, 0, 0.5) 0px 8px 24px",
    glowAccent: "0 0 16px rgba(30, 215, 96, 0.25)",
    glowDanger: "0 0 16px rgba(243, 114, 127, 0.25)",
  },

  transitions: {
    fast: "120ms cubic-bezier(0.16, 1, 0.3, 1)",
    base: "200ms cubic-bezier(0.16, 1, 0.3, 1)",
    slow: "300ms cubic-bezier(0.16, 1, 0.3, 1)",
  },
} as const;

export type DesignTokenSystem = typeof DESIGN_TOKENS;

/**
 * 格式化为标准 CSS 变量引用形式，例如 tokenVar("accent") -> "var(--accent)"
 */
export function tokenVar(variableName: string): string {
  const cleanName = variableName.startsWith("--") ? variableName : `--${variableName}`;
  return `var(${cleanName})`;
}

/**
 * 将 CamelCase 转换为 kebab-case，供 CSS 属性名映射
 */
export function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
