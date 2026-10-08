import { test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { deliveryDecision } from "./creator_delivery.js";

test("creator delivery waits for processing and domain verification", () => {
  const asset = { assetId: "clip-7", creatorId: "maya", source: "https://example.org/clip.mp4", state: "ingested" as const };
  const domain = { creatorId: "maya", state: "pending" as const };
  deepStrictEqual(deliveryDecision(asset, domain, "watch.example.org"), { state: "held" });
  deepStrictEqual(deliveryDecision({ ...asset, state: "processed" }, domain, "watch.example.org"), { state: "held" });
  deepStrictEqual(deliveryDecision({ ...asset, state: "processed" }, { ...domain, state: "ready" }, "watch.example.org"), { state: "deliverable", url: "https://watch.example.org/media/clip-7" });
});
