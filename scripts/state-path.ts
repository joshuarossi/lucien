import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the directory holding Lucien's runtime state (sqlite db, ingest
 * watermarks, the Playwright profile). Co-located with the repo so the
 * Dreaming stays purely user-facing wiki content.
 *
 * Layout: <repo>/.lucien/
 *
 * `import.meta.url` of this file is .../lucien/scripts/state-path.ts, so the
 * repo root is two levels up.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(here);
export const LUCIEN_STATE_DIR = join(REPO_ROOT, ".lucien");

export const DB_PATH = join(LUCIEN_STATE_DIR, "lucien.db");
export const STATE_JSON_PATH = join(LUCIEN_STATE_DIR, "state.json");
export const PLAYWRIGHT_PROFILE_PATH = join(LUCIEN_STATE_DIR, "playwright-profile");
