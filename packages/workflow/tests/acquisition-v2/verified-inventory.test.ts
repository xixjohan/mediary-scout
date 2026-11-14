import { describe, expect, it } from "vitest";
import { verifiedSeasonInventory } from "../../src/acquisition-v2/verified-inventory.js";

describe("verified inventory requires an episode in the video filename", () => {
  it("does not turn an episode-like parent directory into proof for a trailer", () => {
    const inventory = verifiedSeasonInventory(1, "season_1", [
      { id: "trailer", path: "Show.S01E197/Trailer.mp4", sizeBytes: 1000, isVideo: true, isSubtitle: false },
    ]);
    expect(inventory.files).toEqual([]);
  });

  it("uses the filename code and preserves the relative path separately", () => {
    const inventory = verifiedSeasonInventory(1, "season_1", [
      { id: "episode", path: "Show.S01E197/Show.S01E198.mp4", sizeBytes: 1000, isVideo: true, isSubtitle: false },
    ]);
    expect(inventory.files).toEqual([{
      id: "episode", providerFileId: "episode", storageDirectoryId: "season_1", sizeBytes: 1000,
      name: "Show.S01E198.mp4", relativePath: "Show.S01E197/Show.S01E198.mp4", episodeCode: "S01E198",
    }]);
  });
});
