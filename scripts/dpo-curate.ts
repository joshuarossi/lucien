/**
 * dpo-curate — select the BEST + HARDEST ~450 train (+50 valid) ORPO pairs from
 * the full set produced by dpo-collect.ts.
 *
 * "Hardest" = heuristic difficulty + a prod-confusion proxy:
 *   - length:    long conversations are the documented failure zone (long-span
 *                collapse / over-split). Longer window ⇒ harder.
 *   - subtlety:  a Δ=1 deviation (merge one seam / split one chunk) sits right on
 *                the decision boundary — harder than a Δ≫1 extreme.
 *   - source:    prod-judged windows are where production (a model) ACTUALLY
 *                over-split — a free hard-negative signal. Ranked above ideal,
 *                and ideal-long above ideal-short.
 *   - headline boost: long window + few correct chunks + over-split rejected is
 *                the "long ≠ split" lesson — kept prominent.
 *
 * Constraints (so it stays a centered, balanced curriculum, not a pile of one
 * window's near-misses):
 *   - slight over-split lean (~1.3:1), same as the full set;
 *   - ≤2 pairs per window (diversity — 450 pairs span ≥225 conversations);
 *   - reserved wall quotas so the 0-chunk (collapse) and ~8-chunk (explode/
 *     multicut) failure modes you've actually hit are still taught.
 *
 * Train and valid are drawn from disjoint conversation pools (train.jsonl vs
 * valid.jsonl), so there is no conversation leakage across the split.
 *
 * Outputs (benchmark/finetune/chunk-v3/dpo/):
 *   orpo-curated-train.jsonl / orpo-curated-valid.jsonl          clean
 *   orpo-curated-{train,valid}.with-meta.jsonl                   + score/meta
 *   curate-info.json                                             composition
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "benchmark/finetune/chunk-v3/dpo");

const argNum = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };

const MSG_ANCHOR = /\n\[[^\]\n]+\]\s*\(uuid:\s*([^)\s]+)\)/g;
const msgCount = (user: string) => { let n = 0; MSG_ANCHOR.lastIndex = 0; while (MSG_ANCHOR.exec(user)) n++; return n; };
const convOf = (user: string) => { const m = user.match(/Conversation:.*?\(uuid:\s*([^)\s]+)\)/); return m ? m[1] : "?"; };

const OVER_EXTREME = new Set(["explode", "multicut_2", "multicut_3", "multicut_4", "over_split_prod"]);
const UNDER_EXTREME = new Set(["collapse_all"]);

type Row = {
    line: string; meta: any; mc: number; conv: string; dir: "over" | "under";
    delta: number; H: number; extreme: boolean;
};

function load(file: string): Row[] {
    return file.split("\n").filter(Boolean).map((line) => {
        const o = JSON.parse(line);
        const mc = msgCount(o.prompt[1].content);
        const m = o.meta;
        const delta = Math.abs(m.chosenCount - m.rejectedCount);
        const Ln = Math.min(mc, 40) / 40;
        const Sub = delta <= 1 ? 1.0 : delta === 2 ? 0.55 : 0.25;
        const Src = m.source === "prod-judged" ? 1.0 : mc >= 13 ? 0.7 : mc >= 8 ? 0.45 : 0.25;
        const headline = m.dir === "over" && m.chosenCount <= 2 && mc >= 12 ? 0.6 : 0;
        const H = 1.0 * Ln + 1.1 * Sub + 0.8 * Src + headline;
        const extreme = OVER_EXTREME.has(m.tag) || UNDER_EXTREME.has(m.tag);
        return { line: JSON.stringify({ prompt: o.prompt, chosen: o.chosen, rejected: o.rejected }), meta: m, mc, conv: convOf(o.prompt[1].content), dir: m.dir, delta, H, extreme };
    });
}

function select(pool: Row[], N: number, lean: number, capPerDir: number, overExtMin: number, underExtMin: number): Row[] {
    const nUnder = Math.round(N / (1 + lean)), nOver = N - nUnder;
    const picked = new Set<Row>();
    const byH = (a: Row, b: Row) => b.H - a.H;
    const fill = (src: Row[], bucket: Row[], target: number) => {
        for (const r of src) { if (bucket.length >= target) break; if (!picked.has(r)) { picked.add(r); bucket.push(r); } }
    };
    const pOver: Row[] = [], pUnder: Row[] = [];

    // 1. Reserve a minority of WALLS from the full pool, hardest-first — the H
    //    score's length term means these come from the longest conversations,
    //    where an 8-chunk explosion / 1-chunk collapse is most clearly the
    //    documented failure. (Extremes lose the per-direction cap below, so they
    //    must be claimed here or they vanish.)
    fill(pool.filter((r) => r.dir === "over" && r.extreme).sort(byH), pOver, Math.min(overExtMin, nOver));
    fill(pool.filter((r) => r.dir === "under" && r.extreme).sort(byH), pUnder, Math.min(underExtMin, nUnder));

    // 2. Fill the rest with the hardest near-misses, capped per window per
    //    direction so no single conversation dominates.
    const byWin = new Map<string, { over: Row[]; under: Row[] }>();
    for (const r of pool) { if (picked.has(r)) continue; const g = byWin.get(r.meta.windowId) ?? byWin.set(r.meta.windowId, { over: [], under: [] }).get(r.meta.windowId)!; g[r.dir].push(r); }
    const over: Row[] = [], under: Row[] = [];
    for (const g of byWin.values()) { g.over.sort(byH); g.under.sort(byH); over.push(...g.over.slice(0, capPerDir)); under.push(...g.under.slice(0, capPerDir)); }
    fill(over.sort(byH), pOver, nOver);
    fill(under.sort(byH), pUnder, nUnder);

    return [...pOver, ...pUnder].sort(byH);
}

function dist(rows: Row[]) {
    const tags: Record<string, number> = {}, chosen: Record<number, number> = {}, mcBuckets: Record<string, number> = {};
    let over = 0, under = 0;
    for (const r of rows) {
        tags[r.meta.tag] = (tags[r.meta.tag] ?? 0) + 1;
        chosen[r.meta.chosenCount] = (chosen[r.meta.chosenCount] ?? 0) + 1;
        const b = r.mc < 8 ? "<8" : r.mc < 13 ? "8-12" : r.mc < 21 ? "13-20" : "21+";
        mcBuckets[b] = (mcBuckets[b] ?? 0) + 1;
        r.dir === "over" ? over++ : under++;
    }
    return { count: rows.length, over, under, ratio: Number((over / Math.max(1, under)).toFixed(2)), windows: new Set(rows.map((r) => r.meta.windowId)).size, byTag: tags, chosenCountDist: chosen, msgCountBuckets: mcBuckets };
}

async function main() {
    const nTrain = argNum("--train", 450), nValid = argNum("--valid", 50), lean = argNum("--lean", 1.3), cap = argNum("--per-window-dir", 1);

    const train = load(await readFile(join(OUT, "orpo-train.with-meta.jsonl"), "utf8"));
    const valid = load(await readFile(join(OUT, "orpo-valid.with-meta.jsonl"), "utf8"));

    // No conversation leakage: the v3 split is window-level, so a conversation can
    // have windows in both train.jsonl and valid.jsonl. Restrict the valid pool to
    // conversations entirely absent from train.jsonl for a true held-out set.
    const trainConvs = new Set<string>();
    for (const l of (await readFile(join(ROOT, "benchmark/finetune/chunk-v3/train.jsonl"), "utf8")).split("\n").filter(Boolean))
        trainConvs.add(convOf(JSON.parse(l).messages[1].content));
    const validDisjoint = valid.filter((r) => !trainConvs.has(r.conv));

    const overExt = argNum("--over-walls", 0.12), underExt = argNum("--under-walls", 0.08); // fractions of N reserved as walls
    const selTrain = select(train, nTrain, lean, cap, Math.round(overExt * nTrain), Math.round(underExt * nTrain));
    const selValid = select(validDisjoint, nValid, lean, cap, Math.round(overExt * nValid), Math.round(underExt * nValid));
    if (selValid.length < nValid) console.error(`  ! valid: only ${selValid.length}/${nValid} pairs after leakage filter (disjoint pool ${validDisjoint.length})`);

    for (const [name, sel] of [["train", selTrain], ["valid", selValid]] as const) {
        await writeFile(join(OUT, `orpo-curated-${name}.jsonl`), sel.map((r) => r.line).join("\n") + (sel.length ? "\n" : ""));
        await writeFile(join(OUT, `orpo-curated-${name}.with-meta.jsonl`),
            sel.map((r) => JSON.stringify({ ...JSON.parse(r.line), meta: { ...r.meta, mc: r.mc, H: Number(r.H.toFixed(3)) } })).join("\n") + (sel.length ? "\n" : ""));
    }

    const info = { builtAt: new Date().toISOString(), params: { nTrain, nValid, lean, perWindowCap: cap }, train: dist(selTrain), valid: dist(selValid) };
    await writeFile(join(OUT, "curate-info.json"), JSON.stringify(info, null, 2));

    const fmt = (d: any) => `${d.count} pairs, ${d.over}/${d.under} over/under (${d.ratio}:1), ${d.windows} windows`;
    console.error(`dpo-curate complete:
  TRAIN  ${fmt(info.train)}
         msg-len buckets ${JSON.stringify(info.train.msgCountBuckets)}
         chosen-count dist ${JSON.stringify(info.train.chosenCountDist)}
         tags ${JSON.stringify(info.train.byTag)}
  VALID  ${fmt(info.valid)}
  wrote -> ${OUT}/orpo-curated-{train,valid}.jsonl`);
}

main();
