import {
  CooldownLimiter,
  TitleResourceCache,
  type ResourceCandidateView,
} from "@media-track/workflow";

/**
 * The search cache + rate limiter shared by the resource routes (batch 5).
 *
 * These were module-level singletons inside `resources/route.ts`. The rule preview
 * (subscription-policy/preview) needs the SAME instances: a preview issued right after a
 * search should hit the cache and cost nothing, and it should be rate-limited the same
 * way. Two copies would mean a preview bypasses the cooldown the user's search just paid.
 *
 * Next.js may instantiate this module more than once across bundles; within a server
 * process these are the shared instances (same caveat as before the extraction).
 */

/** 30 minutes — how long a returned candidateId stays usable (plan §3.2). */
export const RESOURCE_TTL_MS = 30 * 60 * 1000;

/** 60s — how soon the same title may be searched again (plan §3.2). */
export const RESOURCE_COOLDOWN_MS = 60 * 1000;

export const resourceCache = new TitleResourceCache<ResourceCandidateView>({
  now: () => Date.now(),
  ttlMs: RESOURCE_TTL_MS,
  idOf: (view) => view.candidateId,
});

export const resourceLimiter = new CooldownLimiter({
  now: () => Date.now(),
  cooldownMs: RESOURCE_COOLDOWN_MS,
});
