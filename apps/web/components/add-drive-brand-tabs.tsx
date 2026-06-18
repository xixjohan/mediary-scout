"use client";

import { useState } from "react";
import { Pan115QrConnect } from "./pan115-qr-connect";
import { QuarkCookieConnect } from "./quark-cookie-connect";

type Brand = "pan115" | "quark";

/** Settings "添加网盘": pick a brand, then connect it. 115 = QR scan; 夸克 = cookie
 *  paste. Each bound drive becomes its own isolated workspace (tree model). */
export function AddDriveBrandTabs() {
  const [brand, setBrand] = useState<Brand>("pan115");

  return (
    <div>
      <div className="tab-row" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          className={brand === "pan115" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("pan115")}
          aria-pressed={brand === "pan115"}
        >
          115 网盘
        </button>
        <button
          type="button"
          className={brand === "quark" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("quark")}
          aria-pressed={brand === "quark"}
        >
          夸克网盘
        </button>
      </div>
      {brand === "pan115" ? <Pan115QrConnect /> : <QuarkCookieConnect />}
    </div>
  );
}
