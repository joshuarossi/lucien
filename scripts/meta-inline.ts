import { Glob } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Inline the user's Meta policy pages directly into stage prompts, replacing
 * the old "use the Read tool on ~/Dreaming/Meta" instruction.
 *
 * Tool-read policy turned every pipeline call into an agent loop whose
 * context accumulates (a 34k-char conversation was observed ballooning to a
 * 105k-token prefill on the local server). Inlining makes calls single-turn:
 * one bounded prefill, one bounded generation. Discovery-by-location is
 * preserved — every page in Meta/ is picked up on the next run with zero
 * code change.
 */

const DEFAULT_META_DIR = join(homedir(), "Dreaming", "Meta");

// Changelog.md is the machine-written nightly run log, not editorial policy —
// 20KB+ that would balloon every prefill for nothing.
const EXCLUDED = new Set(["Changelog.md"]);

export async function loadMetaPolicyBlock(
    metaDir: string = DEFAULT_META_DIR
): Promise<string> {
    const glob = new Glob("*.md");
    const names: string[] = [];
    try {
        for await (const name of glob.scan({ cwd: metaDir })) {
            if (!EXCLUDED.has(name)) names.push(name);
        }
    } catch {
        return "(no Meta policy pages found)";
    }
    names.sort();

    const sections: string[] = [];
    for (const name of names) {
        const text = (await Bun.file(join(metaDir, name)).text()).trim();
        if (text) sections.push(`--- Meta/${name} ---\n\n${text}`);
    }
    if (sections.length === 0) return "(no Meta policy pages found)";
    return sections.join("\n\n");
}
