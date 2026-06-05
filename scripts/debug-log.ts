import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEBUG_LOG_DIR = join(REPO_ROOT, ".lucien", "logs");

export async function debugLogPath(filename: string): Promise<string> {
    await mkdir(DEBUG_LOG_DIR, { recursive: true });
    return join(DEBUG_LOG_DIR, filename);
}
