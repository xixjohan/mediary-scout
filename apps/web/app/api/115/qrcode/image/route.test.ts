import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

describe("GET /api/115/qrcode/image", () => {
  it("renders a valid PNG buffer when a uid is provided", async () => {
    const req = new NextRequest("http://localhost/api/115/qrcode/image?uid=test_uid_123");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(100);
    // PNG file header starts with 0x89 0x50 0x4E 0x47 (‰PNG)
    const header = new Uint8Array(buf.slice(0, 4));
    expect(header).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("renders a valid PNG buffer when content is provided directly", async () => {
    const req = new NextRequest(
      "http://localhost/api/115/qrcode/image?content=" +
        encodeURIComponent("https://115.com/scan/dg-custom_content"),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(100);
  });

  it("returns 400 when neither uid nor content is provided", async () => {
    const req = new NextRequest("http://localhost/api/115/qrcode/image");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
