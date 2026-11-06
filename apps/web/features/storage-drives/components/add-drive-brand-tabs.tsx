"use client";

import { useState } from "react";
import { Pan115QrConnect } from "./pan115-qr-connect";
import { Pan115CookieConnect } from "./pan115-cookie-connect";
import { Pan115OpenConnect } from "./pan115-open-connect";
import { QuarkQrConnect } from "./quark-qr-connect";
import { QuarkCookieConnect } from "./quark-cookie-connect";
import { CloudFamilyCookieConnect } from "./cloud-family-cookie-connect";
import { CloudFamilyQrConnect } from "./cloud-family-qr-connect";
import { GuangYaTokenConnect } from "./guangya-token-connect";
import { GuangYaQrConnect } from "./guangya-qr-connect";
import { TianyiQrConnect } from "./tianyi-qr-connect";
import { TianyiSsonConnect } from "./tianyi-sson-connect";
import { Pan123QrConnect } from "./pan123-qr-connect";
import { Pan123TokenConnect } from "./pan123-token-connect";

type Brand = "pan115" | "quark" | "uc" | "guangya" | "tianyi" | "pan123";

/** 品牌图库瓦片的静态元数据:图标走 /brands/<key>.svg(workspace-switcher 同款资产),
 *  authNote 把认证方式前置到选择时刻(选之前就知道要扫码还是粘贴)。加新品牌:此表加一行 + Brand 联合 + 下方连接区分支 + /brands svg(完整触点见加品牌清单)。 */
const BRAND_TILES: Array<{ key: Brand; label: string; authNote: string }> = [
  { key: "pan115", label: "115网盘", authNote: "双轨: 扫码 / 开放OAuth" },
  { key: "quark", label: "夸克网盘", authNote: "扫码 / 粘 cookie" },
  { key: "uc", label: "UC网盘", authNote: "扫码 / 粘 cookie" },
  { key: "guangya", label: "光鸭云盘", authNote: "扫码 / 粘 token" },
  { key: "tianyi", label: "天翼云盘", authNote: "扫码 / SSON" },
  { key: "pan123", label: "123网盘", authNote: "扫码 / 粘 token" },
];

/** Settings「添加网盘」:集成图库式品牌选择(图标 + 名称 + 认证方式瓦片),选中后
 *  瓦片下方展开该品牌的连接区。115/夸克/UC/天翼/123/光鸭 scan a QR(折叠手动粘贴回退)。
 *  Each bound drive becomes its own isolated workspace (tree model).
 *  defaultBrand:首盘用户传 "pan115" 直接引导扫码;已有盘时传 null,连接区收起,
 *  点瓦片才展开(添加是低频动作,别让 115 连接区常驻占位)。再点选中瓦片可收起。 */
export function AddDriveBrandTabs({ defaultBrand = "pan115" }: { defaultBrand?: Brand | null }) {
  const [brand, setBrand] = useState<Brand | null>(defaultBrand);
  const [pan115Tab, setPan115Tab] = useState<"qr" | "oauth" | "cookie">("qr");

  return (
    <div>
      <div className="brand-gallery" role="group" aria-label="选择网盘品牌">
        {BRAND_TILES.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`brand-tile${brand === tile.key ? " is-selected" : ""}`}
            onClick={() => setBrand(brand === tile.key ? null : tile.key)}
            aria-pressed={brand === tile.key}
          >
            {/* 已注册品牌必有 svg(加品牌 touch-point 清单项);alt 空,名称由下方文字承担。
                本地小 svg 无需 next/image 优化(workspace-switcher 同款惯例)。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-tile-icon" src={`/brands/${tile.key}.svg`} alt="" width={32} height={32} />
            <span className="brand-tile-label">{tile.label}</span>
            <span className="brand-tile-note">{tile.authNote}</span>
          </button>
        ))}
      </div>
      {brand === "pan115" ? (
        <div className="brand-connect-area">
          {/* 115 双轨认证方式平铺切换卡，消除用户将 OAuth 误认为客户端类型下拉选项的困惑 */}
          <div className="pan115-auth-mode-tabs">
            <button
              type="button"
              className={`pan115-auth-mode-tab ${pan115Tab === "qr" ? "primary-button" : "secondary-button"}`}
              onClick={() => setPan115Tab("qr")}
              aria-pressed={pan115Tab === "qr"}
            >
              📱 扫码快捷登录 (Cookie 基础轨 · 负责转存)
            </button>
            <button
              type="button"
              className={`pan115-auth-mode-tab ${pan115Tab === "oauth" ? "primary-button" : "secondary-button"}`}
              onClick={() => setPan115Tab("oauth")}
              aria-pressed={pan115Tab === "oauth"}
              style={{
                ...(pan115Tab !== "oauth" ? { borderColor: "rgba(16, 185, 129, 0.4)", color: "#10b981" } : {}),
              }}
            >
              ⚡ 开放平台授权 (OAuth 高性能轨 · 推荐)
            </button>
            <button
              type="button"
              className={`pan115-auth-mode-tab ${pan115Tab === "cookie" ? "primary-button" : "secondary-button"}`}
              onClick={() => setPan115Tab("cookie")}
              aria-pressed={pan115Tab === "cookie"}
            >
              📋 粘贴 Cookie
            </button>
          </div>

          {pan115Tab === "qr" ? (
            <div>
              <Pan115QrConnect />
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  background: "rgba(16, 185, 129, 0.06)",
                  border: "1px dashed rgba(16, 185, 129, 0.3)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "#10b981",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span>💡 提示：扫码获得 Cookie（负责转存）；推荐点击上方「⚡ 开放平台授权」绑定 OAuth 开启双轨引擎（免频繁掉线/千级文件秒级扫库/直链高并发）。</span>
                <button
                  type="button"
                  onClick={() => setPan115Tab("oauth")}
                  style={{
                    marginLeft: 10,
                    background: "transparent",
                    border: "none",
                    color: "#10b981",
                    textDecoration: "underline",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    fontWeight: 600,
                  }}
                >
                  去配置 OAuth →
                </button>
              </div>
            </div>
          ) : pan115Tab === "oauth" ? (
            <div>
              <Pan115OpenConnect />
            </div>
          ) : (
            <div>
              <Pan115CookieConnect />
            </div>
          )}
        </div>
      ) : brand === "quark" ? (
        <div className="brand-connect-area">
          <QuarkQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <QuarkCookieConnect />
            </div>
          </details>
        </div>
      ) : brand === "uc" ? (
        <div className="brand-connect-area">
          <CloudFamilyQrConnect brand="uc" />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <CloudFamilyCookieConnect brand="uc" />
            </div>
          </details>
        </div>
      ) : brand === "guangya" ? (
        <div className="brand-connect-area">
          <GuangYaQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 token
            </summary>
            <div style={{ marginTop: 10 }}>
              <GuangYaTokenConnect />
            </div>
          </details>
        </div>
      ) : brand === "tianyi" ? (
        <div className="brand-connect-area">
          <TianyiQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 SSON cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <TianyiSsonConnect />
            </div>
          </details>
        </div>
      ) : brand === "pan123" ? (
        <div className="brand-connect-area">
          <Pan123QrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 token
            </summary>
            <div style={{ marginTop: 10 }}>
              <Pan123TokenConnect />
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
