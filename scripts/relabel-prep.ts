/**
 * relabel-prep.ts — emit self-contained "ideal chunking" prompts for the merge
 * lever (v3). Reads the relabel-manifest.json produced by
 * `curate-chunk-v3.ts --emit-manifest` and writes one prompt file per window to
 * benchmark/finetune/chunk-v3/relabel/in/<windowId>.txt.
 *
 * A strong model (Opus sub-agent / workflow) reads each prompt and writes the
 * IDEAL segmentation as JSON to relabel/out/<windowId>.json. relabel-collect.ts
 * then validates + merges those into ideal-labels.json, which curate-chunk-v3.ts
 * folds in (curated gold REPLACES prod gold per window).
 *
 *   bun run scripts/relabel-prep.ts [--top N] [--all] [--out-base DIR]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./state-path.js";

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
}

// The relabel policy (calibrated 2026-06-17 per user): produce the EXACTLY-RIGHT
// segmentation — neither forced toward over- nor under-split. Split genuinely
// distinct topics (downstream NEEDS real splits), but keep one coherent topic /
// multi-stage plan as ONE chunk (a 5-part plan is one topic, not five). On GENUINE
// doubt only, lean ~52/48 toward splitting. So this pass BOTH merges plan-phase
// over-splits AND adds boundaries between distinct topics — the full correction.
const RUBRIC = `You are producing the EXACTLY-CORRECT topic-segmentation ("chunking") of one conversation for a knowledge-synthesis pipeline. Each chunk is routed downstream to update ONE encyclopedia-style article — so the pipeline genuinely NEEDS the conversation split into its real topics, AND it must not be over-fragmented. Produce the segmentation a careful editor would call exactly right: neither too coarse nor too fine.

WHAT "EXACTLY RIGHT" MEANS:
- SPLIT genuinely distinct topics. When the subject actually changes to a different subject (one that would update a different article), start a new chunk. The pipeline depends on these splits — do NOT collapse a multi-topic conversation into one chunk.
- DO NOT over-split one topic into pieces. A single coherent topic is ONE chunk, even if it is long or has several facets or a back-and-forth.
- A MULTI-STAGE PLAN OR PROCESS IS ONE TOPIC. A 5-part plan is ONE chunk, NOT five. The phases of one plan ("step 1 … step 2 … step 3") are not separate topics — splitting them makes no sense downstream ("phase 2 of WHAT?"). Keep the whole plan/process together. This is the most common over-split to fix.
- NEVER fuse two genuinely DISTINCT topics into one chunk, and never DROP a substantive span. Fusing distinct subjects is a permanent loss — the second subject never reaches its article.

THE TIEBREAKER (for GENUINE doubt only): if after honest judgment you truly cannot tell whether a span is one topic or two, lean SLIGHTLY toward splitting — about 52/48. This is a gentle tiebreaker for real toss-ups ONLY; it is NOT license to over-split. A clear single topic (including a multi-stage plan) stays one chunk regardless of this lean.

A PRODUCTION segmentation is provided for reference. It tends to OVER-SPLIT — especially breaking one plan/process into its phases. Correct it toward the exactly-right segmentation: merge the phases of one plan/topic back into one chunk; keep (or add) boundaries only between genuinely distinct topics.

ANCHORS: each chunk's start_message_uuid / end_message_uuid MUST be a uuid that appears in the transcript (the "(uuid: ...)" on a message line). Use the FIRST message of the topic as start and the LAST as end.
Chunks must TILE cleanly: ordered, non-overlapping (at most ONE shared boundary message when a message genuinely belongs to both), never nested, no [?-?] anchors.

OUTPUT: ONLY a JSON object, no prose, no markdown fences:
{"chunks":[{"start_message_uuid":"...","end_message_uuid":"...","label":"4-10 word specific topic label"}]}`;

function fmtProd(prod: { start_message_uuid: string; end_message_uuid: string; label: string }[]): string {
    return prod.map((c, i) => `  ${i + 1}. [${c.start_message_uuid} → ${c.end_message_uuid}] ${c.label}`).join("\n");
}

async function main() {
    const outBase = arg("--out-base", join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "relabel"))!;
    const all = process.argv.includes("--all");
    const top = arg("--top") ? parseInt(arg("--top")!, 10) : (all ? Infinity : 24);

    const manifest = JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "relabel-manifest.json"), "utf8"));
    const windows = manifest.windows.slice(0, top);
    const inDir = join(outBase, "in"), outDir = join(outBase, "out");
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    for (const w of windows) {
        const prompt = `${RUBRIC}

=== CONVERSATION: ${w.name} ===
${w.indexedTranscript}

=== PRODUCTION segmentation (reference — likely over-split; correct toward the rules) ===
${fmtProd(w.prodChunks)}

Produce the IDEAL chunking now. Output ONLY the JSON object.`;
        await writeFile(join(inDir, `${w.windowId}.txt`), prompt);
    }
    // an index the driver can iterate
    const ids = windows.map((w: any) => w.windowId);
    await writeFile(join(outBase, "windowIds.json"), JSON.stringify(ids, null, 2));

    // Emit a self-contained workflow script with the ids EMBEDDED (the Workflow
    // `args` channel proved unreliable, and workflow scripts have no filesystem
    // access). Launch with: Workflow({ scriptPath: <outBase>/relabel-workflow.mjs }).
    const wf = `export const meta = {
  name: 'chunk-v3-relabel',
  description: 'Relabel hardest multi-chunk windows to ideal chunkings (merge lever), asymmetry-aware',
  phases: [{ title: 'Relabel', detail: 'one sub-agent per window: read prompt file, write ideal-chunking JSON' }],
}
const BASE = ${JSON.stringify(outBase)}
const ids = ${JSON.stringify(ids)}
phase('Relabel')
log(\`relabeling \${ids.length} windows\`)
const results = await parallel(ids.map((id) => () =>
  agent(
    \`Read the file at \${BASE}/in/\${id}.txt — it is a complete, self-contained annotation task with its own instructions and a conversation transcript. Follow its instructions exactly and produce the ideal topic-segmentation.\\n\\nThen write ONLY the resulting JSON object (the {"chunks":[...]} object — no prose, no markdown fences, nothing else) to \${BASE}/out/\${id}.json\\n\\nDo not create or modify any other files. Reply with just the chunk count.\`,
    { label: \`relabel \${id.slice(0, 8)}\`, phase: 'Relabel', agentType: 'general-purpose' }
  ).then(() => true).catch(() => false)
))
log(\`relabel complete: \${results.filter(Boolean).length}/\${ids.length} agents finished\`)
return { attempted: ids.length, finished: results.filter(Boolean).length }
`;
    await writeFile(join(outBase, "relabel-workflow.mjs"), wf);

    console.log(`wrote ${windows.length} relabel prompts → ${inDir}`);
    console.log(`windowIds → ${join(outBase, "windowIds.json")}`);
    console.log(`workflow  → ${join(outBase, "relabel-workflow.mjs")}  (launch via Workflow scriptPath)`);
    console.log(`each sub-agent: read in/<id>.txt → write out/<id>.json (the JSON object)`);
}
main();
