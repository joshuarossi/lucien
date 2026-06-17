/**
 * chunk-eval-report.ts — render the multi-model chunk-eval into one HTML report.
 *
 * Reads benchmark/results/chunk-eval/{ideal,gen-*,judge-*}.json and emits a
 * comparison report: GPT-5.5 gold as the reference, each contestant (base CPM,
 * adapter CPM, …) graded against it by Opus 4.8. Reuses the 2026-06-10 report's
 * stylesheet + track-drawing so the visual language matches.
 *
 *   bun run scripts/chunk-eval.ts report
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./state-path.js";

const ORIG_REPORT = join(REPO_ROOT, "reports", "chunking-eval-2026-06-10.html");

interface ModelChunk { start: number | null; end: number | null; label: string }
interface GenConv { id: string; name: string; mc: number; promptHash: string; chunks: ModelChunk[]; anomalies: string[]; uncovered: number[]; error: string | null }
interface JudgeConv { id: string; name: string; mc: number; boundary_score: number | null; label_score: number | null; verdict: string; disagreements: { type: string; detail: string }[]; agreements: string[]; summary: string; error?: boolean }

function grade(meanB: number): string {
    if (meanB >= 93) return "A";
    if (meanB >= 90) return "A-";
    if (meanB >= 87) return "B+";
    if (meanB >= 83) return "B";
    if (meanB >= 80) return "B-";
    if (meanB >= 77) return "C+";
    if (meanB >= 73) return "C";
    if (meanB >= 70) return "C-";
    if (meanB >= 60) return "D";
    return "F";
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function renderReport(outDir: string, goldTag = "") {
    const files = await readdir(outDir);
    const idealFile = goldTag ? `ideal-${goldTag}.json` : "ideal.json";
    const judgePrefix = goldTag ? `judge-${goldTag}-` : "judge-";
    const ideal = JSON.parse(await readFile(join(outDir, idealFile), "utf8")) as { benchmark: string; convs: GenConv[] };
    const genLabels = files.filter((f) => f.startsWith("gen-") && f.endsWith(".json")).map((f) => f.slice(4, -5));
    const gens: Record<string, { meta: any; byId: Map<string, GenConv> }> = {};
    for (const label of genLabels) {
        const j = JSON.parse(await readFile(join(outDir, `gen-${label}.json`), "utf8"));
        gens[label] = { meta: j, byId: new Map((j.convs as GenConv[]).map((c) => [c.id, c])) };
    }
    const judges: Record<string, Map<string, JudgeConv>> = {};
    for (const label of genLabels) {
        // judge files for this gold; avoid matching judge-db-* when goldTag is ""
        const fname = `${judgePrefix}${label}.json`;
        if (files.includes(fname)) {
            const j = JSON.parse(await readFile(join(outDir, fname), "utf8"));
            judges[label] = new Map((j.convs as JudgeConv[]).map((c) => [c.id, c]));
        }
    }

    const idealById = new Map(ideal.convs.map((c) => [c.id, c]));
    const order = ideal.convs.map((c) => c.id);

    // ----- per-model aggregates -----
    interface Agg { label: string; meanB: number | null; meanL: number | null; agree: number; minor: number; major: number; judged: number; hallucinated: number; tailGaps: number; overlaps: number; emptyOrError: number; validJson: number; totalChunks: number; grade: string | null }
    const aggs: Agg[] = [];
    for (const label of genLabels) {
        const g = gens[label];
        let hallucinated = 0, tailGaps = 0, overlaps = 0, emptyOrError = 0, validJson = 0, totalChunks = 0;
        for (const id of order) {
            const c = g.byId.get(id); if (!c) continue;
            totalChunks += c.chunks.length;
            if (c.error) emptyOrError++; else validJson++;
            if (c.chunks.length === 0 && !c.error) emptyOrError++;
            for (const a of c.anomalies) {
                if (a.startsWith("HALLUCINATED")) hallucinated++;
                else if (a.startsWith("TAIL GAP")) tailGaps++;
                else if (a.startsWith("OVERLAP")) overlaps++;
            }
        }
        const jd = judges[label];
        let meanB: number | null = null, meanL: number | null = null, agree = 0, minor = 0, major = 0, judged = 0;
        if (jd) {
            let sb = 0, sl = 0, nb = 0;
            for (const id of order) {
                const v = jd.get(id); if (!v || v.error) continue;
                judged++;
                if (typeof v.boundary_score === "number") { sb += v.boundary_score; nb++; }
                if (typeof v.label_score === "number") sl += v.label_score;
                if (v.verdict === "agree") agree++;
                else if (v.verdict === "minor_disagreement") minor++;
                else if (v.verdict === "major_disagreement") major++;
            }
            if (nb) { meanB = Math.round(sb / nb); meanL = Math.round(sl / nb); }
        }
        aggs.push({ label, meanB, meanL, agree, minor, major, judged, hallucinated, tailGaps, overlaps, emptyOrError, validJson, totalChunks, grade: meanB === null ? null : grade(meanB) });
    }

    // ----- per-conversation DATA for client render -----
    const DATA = order.map((id) => {
        const gi = idealById.get(id)!;
        const models: Record<string, any> = {};
        for (const label of genLabels) {
            const c = gens[label].byId.get(id);
            const v = judges[label]?.get(id);
            models[label] = {
                chunks: (c?.chunks ?? []).map((k) => [k.start, k.end, k.label]),
                anomalies: c?.anomalies ?? [],
                uncovered: c?.uncovered ?? [],
                error: c?.error ?? null,
                bs: v?.boundary_score ?? null, ls: v?.label_score ?? null, v: v?.verdict ?? null,
                d: v?.disagreements ?? [], a: v?.agreements ?? [], s: v?.summary ?? "",
            };
        }
        return { id, name: gi.name, mc: gi.mc, gold: gi.chunks.map((k) => [k.start, k.end, k.label]), models };
    });

    // ----- prompt-hash parity check -----
    const parity: Record<string, boolean> = {};
    for (const id of order) {
        const hashes = new Set<string>();
        const ih = idealById.get(id)?.promptHash; if (ih) hashes.add(ih);
        for (const label of genLabels) { const h = gens[label].byId.get(id)?.promptHash; if (h) hashes.add(h); }
        parity[id] = hashes.size <= 1;
    }
    const parityOK = Object.values(parity).every(Boolean);

    // ----- methodology inputs: real system prompt + example payloads -----
    let chunkSystemPrompt = "";
    try {
        const cfg = JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "configs", "sysprompt-v1.json"), "utf8"));
        chunkSystemPrompt = cfg.stages?.chunk?.systemPrompt ?? "";
    } catch { }
    const exampleHash = idealById.get(order[0])?.promptHash ?? "";

    // ----- live leakage audit: are any eval-set UUIDs in the training data? -----
    let trainLines = 0, leaked = 0, trainExamined = false;
    try {
        const evalIds = new Set(order);
        for (const fn of ["train.jsonl", "valid.jsonl"]) {
            const text = await readFile(join(REPO_ROOT, "benchmark", "finetune", "chunk", fn), "utf8");
            for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                trainLines++;
                for (const id of evalIds) if (line.includes(id)) { leaked++; break; }
            }
        }
        trainExamined = true;
    } catch { }
    const localMeta = gens["cpm-base"]?.meta ?? gens["cpm-chunk"]?.meta ?? Object.values(gens)[0]?.meta;
    const localBaseUrl = localMeta?.baseUrl ?? "http://localhost:8090/v1";
    const basePayload = `curl ${localBaseUrl}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "local",
    "messages": [
      { "role": "system", "content": <chunk system prompt, verbatim, below> },
      { "role": "user",   "content": <CHUNK_PROMPT + Meta policy + formatted conversation> }
    ],
    "temperature": 0, "max_tokens": 8192, "stream": false
  }'                                    # BASE — no adapter field`;
    const adapterPayload = `curl ${localBaseUrl}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "local",
    "adapter": "chunk",                 ◄── THE ONLY DIFFERENCE
    "messages": [
      { "role": "system", "content": <identical> },
      { "role": "user",   "content": <identical> }
    ],
    "temperature": 0, "max_tokens": 8192, "stream": false
  }'                                    # ADAPTER — fine-tuned LoRA mounted at id "chunk"`;

    // ----- assemble HTML -----
    const origHtml = await readFile(ORIG_REPORT, "utf8");
    const css = (origHtml.match(/<style>[\s\S]*?<\/style>/) || ["<style></style>"])[0];

    const COLORS = ["var(--model)", "#7e9cd8", "#c98ec9", "#8fce8f"]; // contestant track colors
    const date = new Date().toISOString().slice(0, 10);
    const isDb = goldTag === "db";
    const goldName = isDb ? "the production pipeline (DB)" : esc(ideal.benchmark);
    const goldDesc = isDb
        ? `<b>The production pipeline's own chunks</b> — what the live system actually wrote to the DB for these conversations — set the gold reference (avg ${(DATA.reduce((s, d) => s + d.gold.length, 0) / DATA.length).toFixed(1)} chunks/conv). This anchors the benchmark to real running behavior rather than an external model's preference.`
        : `<b>GPT-5.5</b> sets the gold reference (avg ${(DATA.reduce((s, d) => s + d.gold.length, 0) / DATA.length).toFixed(1)} chunks/conv).`;

    const scorecardRows = aggs.map((a, i) => `
      <tr>
        <td class="mlabel"><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${esc(a.label)}</td>
        <td class="num hero">${a.meanB ?? "—"}</td>
        <td class="num">${a.meanL ?? "—"}</td>
        <td class="num">${a.judged ? `${a.agree}/${a.minor}/${a.major}` : "—"}</td>
        <td class="num ${a.hallucinated ? "bad" : ""}">${a.hallucinated}</td>
        <td class="num ${a.tailGaps ? "warn" : ""}">${a.tailGaps}</td>
        <td class="num">${a.overlaps}</td>
        <td class="num ${a.emptyOrError ? "bad" : ""}">${a.emptyOrError}</td>
        <td class="num">${a.validJson}/${order.length}</td>
        <td class="gradecell">${a.grade ?? "—"}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chunk Adapter Evaluation — CPM fine-tune vs GPT-5.5 gold · ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${css}
<style>
.cmptable{width:100%;border-collapse:collapse;margin:36px 0;font-size:12px}
.cmptable th{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);text-align:right;padding:8px 12px;border-bottom:1px solid var(--line);font-weight:500}
.cmptable th:first-child{text-align:left}
.cmptable td{padding:12px;border-bottom:1px solid var(--ink2);text-align:right}
.cmptable td.mlabel{text-align:left;color:var(--moon);font-size:13px}
.cmptable td.num{font-family:var(--serif);font-size:18px}
.cmptable td.num.hero{color:var(--model);font-size:22px}
.cmptable td.num.bad{color:var(--bad)} .cmptable td.num.warn{color:var(--warn)}
.cmptable td.gradecell{font-family:var(--serif);font-weight:900;font-size:24px;color:var(--ideal)}
.swatch{display:inline-block;width:11px;height:11px;margin-right:9px;vertical-align:0}
.parity{margin:10px 0 0;font-size:11px;letter-spacing:.04em}
.parity.ok{color:var(--good)} .parity.bad{color:var(--bad)}
.mtrack-label{font-size:9px;letter-spacing:.18em;text-transform:uppercase;text-align:right}
.mverdict{font-size:11px;color:var(--dim);margin:6px 0 0;padding-left:66px}
.mverdict b{color:var(--moon)}
.method{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:28px 0}
@media(max-width:860px){.method{grid-template-columns:1fr}}
.mcard{background:var(--panel);border:1px solid var(--line);padding:20px 22px}
.mcard h4{font-family:var(--serif);font-weight:600;font-size:15px;color:var(--moon);margin-bottom:10px}
.mcard p{color:var(--dim);font-size:12.5px;margin-bottom:9px}
.mcard b{color:var(--moon);font-weight:500}
.mcard ol,.mcard ul{margin:8px 0 8px 18px;color:var(--dim);font-size:12.5px}
.mcard li{margin-bottom:5px}
.payload{font-family:var(--mono);font-size:11px;line-height:1.5;background:var(--ink2);border:1px solid var(--line);padding:14px 16px;white-space:pre;overflow-x:auto;color:var(--dim);margin:8px 0}
.payload .hl{color:var(--model);font-weight:600}
.payload .gd{color:var(--ideal)}
.sysprompt{font-family:var(--mono);font-size:10.5px;line-height:1.5;background:var(--ink2);border:1px solid var(--line);border-left:3px solid var(--ideal);padding:12px 14px;white-space:pre-wrap;color:var(--faint);max-height:200px;overflow-y:auto;margin:8px 0}
.hashbox{font-family:var(--mono);font-size:12px;color:var(--good);background:var(--ink2);border:1px solid var(--ideal-dim);padding:10px 14px;margin:10px 0;letter-spacing:.04em}
</style>
</head><body><div class="wrap">
<header>
  <div class="kicker">Lucien · chunk stage · adapter evaluation</div>
  <h1>Chunk Adapter <em>vs.</em> the gold</h1>
  <p class="sub">The frozen 25-conversation benchmark set, chunked three ways under <b>byte-identical inputs</b> (same system prompt, same user prompt — only the LoRA adapter differs). ${goldDesc} <b>Opus 4.8</b> blind-scores each local contestant against it. The fine-tuned <b>MiniCPM5-1B chunk adapter</b> is measured against its un-tuned base.</p>
  <div class="runmeta">
    <span><b>Corpus</b> 25 convs · ${DATA.reduce((s, d) => s + d.mc, 0)} messages</span>
    <span><b>Gold</b> ${goldName}</span>
    <span><b>Judge</b> Opus 4.8</span>
    <span><b>Base</b> MiniCPM5-1B-OptiQ</span>
    <span><b>Generated</b> ${date}</span>
  </div>
  <p class="parity ${parityOK ? "ok" : "bad"}">${parityOK ? "✓ input parity verified — all models received identical prompt hashes on every conversation" : "⚠ input parity FAILED on some conversations — prompt hashes differ"}</p>
</header>

<h2><span class="idx">§00</span> Methodology</h2>
<p class="sectionnote">A fine-tune is only as trustworthy as the fairness of its test. This evaluation is built so that <b>the adapter is the only moving part</b> — same conversations, same system prompt, same user prompt, same decoding parameters. Everything below is reproducible from <span style="color:var(--moon)">benchmark/results/chunk-eval/</span>.</p>
<div class="method">
  <div class="mcard">
    <h4>The parity contract</h4>
    <p>Every model receives the <b>exact input the chunk adapter was trained on</b> (see <span style="color:var(--moon)">make-finetune-data.ts</span>): a fixed system prompt plus a user message of <span style="color:var(--moon)">CHUNK_PROMPT</span> (with the Meta policy inlined) followed by the formatted conversation. No coding-assistant system prompt, no <span style="color:var(--moon)">&lt;&lt;LUCIEN_INTERNAL&gt;&gt;</span> sentinel, no repository context files, no tools.</p>
    <p>To <b>prove</b> the inputs are identical, every call records a SHA-256 over <span style="color:var(--moon)">system + " " + user</span>. The report asserts these hashes match across gold, base, and adapter for all 25 conversations:</p>
    <div class="hashbox">${parityOK ? "✓" : "⚠"} per-conversation prompt hash — e.g. conv #1 = ${exampleHash} — ${parityOK ? "identical across all models" : "MISMATCH DETECTED"}</div>
    <p>The frozen 25-conversation set is a <b>held-out benchmark</b>, explicitly excluded from the adapter's training data, so the adapter is being tested on unseen conversations.</p>
    ${trainExamined ? `<div class="hashbox" style="${leaked ? "color:var(--bad);border-color:var(--bad)" : ""}">${leaked ? "⚠" : "✓"} leakage audit — ${leaked} of ${order.length} eval conversations found across ${trainLines} training examples${leaked ? " — CONTAMINATION" : " — eval set is unseen"}</div>` : ""}
  </div>
  <div class="mcard">
    <h4>How each model was run</h4>
    <ol>
      <li>${isDb
        ? `<b>Gold / benchmark — production pipeline</b>: the chunks the live Lucien pipeline already wrote to <span style="color:var(--moon)">lucien.db</span> for these conversations. The reference is the system's <b>actual running behavior</b>, not an external model's preference.`
        : `<b>Gold / benchmark — GPT-5.5</b> (<span style="color:var(--moon)">openai-codex</span>): cold-segments each conversation under the identical system+user prompt. This is the reference standard, not a contestant.`}</li>
      <li><b>Base CPM</b> — MiniCPM5-1B-OptiQ, served by mlx-bun, called with <b>no adapter</b>.</li>
      <li><b>Adapter CPM</b> — the same base weights with the fine-tuned LoRA mounted at id <span style="color:var(--moon)">"chunk"</span>, selected per-request.</li>
      <li><b>Judge — Opus 4.8</b>: blind-scores each contestant's segmentation against the GPT-5.5 gold (boundary + label, 0–100, with a verdict). A third model family, and not a contestant, so there is no self-grading bias.</li>
    </ol>
    <p>Local models are called by <b>direct HTTP</b> to the mlx-bun server (pi cannot carry the per-request <span style="color:var(--moon)">adapter</span> field); the cloud gold uses the same explicit system+user via pi with context-files and tools disabled.</p>
  </div>
</div>
<p class="sectionnote" style="margin-top:8px">The two local requests, side by side — <b style="color:var(--model)">the <span style="font-family:var(--mono)">adapter</span> field is the entire difference</b>:</p>
<div class="payload">${esc(basePayload)}</div>
<div class="payload">${esc(adapterPayload).replace("&quot;adapter&quot;: &quot;chunk&quot;,", "<span class=\"hl\">&quot;adapter&quot;: &quot;chunk&quot;,</span>").replace("◄── THE ONLY DIFFERENCE", "<span class=\"hl\">◄── THE ONLY DIFFERENCE</span>")}</div>
<p class="sectionnote">System prompt sent to <b>all three</b> models, verbatim (<span style="color:var(--moon)">sysprompt-v1.json → stages.chunk.systemPrompt</span>):</p>
<div class="sysprompt">${esc(chunkSystemPrompt)}</div>

<h2><span class="idx">§01</span> Scorecard</h2>
<p class="sectionnote">Boundary / label scores are Opus 4.8's grade of each contestant against the GPT-5.5 gold (0–100). Verdicts are agree / minor / major counts. Anchor, tail, overlap, and empty/error columns are deterministic from the raw model output (pre-repair). Valid-JSON is how many of ${order.length} conversations parsed at all.</p>
<table class="cmptable">
  <thead><tr>
    <th>Model</th><th>Boundary</th><th>Label</th><th>A/Mi/Ma</th><th>Halluc.</th><th>Tail gaps</th><th>Overlaps</th><th>Empty/err</th><th>Valid JSON</th><th>Grade</th>
  </tr></thead>
  <tbody>${scorecardRows}</tbody>
</table>

<h2><span class="idx">§02</span> Boundary maps — all 25 conversations</h2>
<p class="sectionnote">Each conversation shows the <b style="color:var(--ideal)">GPT-5.5 gold</b> track, then each contestant. Hover a segment for its label. Dashed = hallucinated anchor; hatched = uncovered substantive message. Cards ordered as in the corpus.</p>
<div id="cards"></div>

<footer style="margin-top:80px;color:var(--faint);font-size:11px;border-top:1px solid var(--line);padding-top:20px">
  Generated ${date} · Lucien chunk-adapter evaluation · gold ${esc(ideal.benchmark)} · judge Opus 4.8 · ${genLabels.length} contestants
</footer>
</div>
<script>
const DATA = ${JSON.stringify(DATA)};
const LABELS = ${JSON.stringify(genLabels)};
const COLORS = ${JSON.stringify(COLORS)};

function lanes(chunks){const out=[];chunks.forEach(ch=>{let l=0;while(out.some(o=>o.lane===l&&!(ch.e<o.s||ch.s>o.e)))l++;out.push({...ch,lane:l});});return out;}
function gapsOf(chunks,mc){const cov=new Set();chunks.forEach(c=>{const s=c[0]===null?0:c[0],e=c[1]===null?s:c[1];for(let i=s;i<=e;i++)cov.add(i);});const gaps=[];let run=null;for(let i=0;i<mc;i++){if(!cov.has(i)){if(run===null)run=i;}else if(run!==null){gaps.push([run,i-1]);run=null;}}if(run!==null)gaps.push([run,mc-1]);return gaps;}
function track(chunks,mc,color,gaps){
  const resolved=chunks.map(c=>({s:c[0]===null?0:c[0],e:c[1]===null?(c[0]===null?0:c[0]):c[1],label:c[2],hal:c[0]===null||c[1]===null}));
  const laned=lanes(resolved);const nLanes=laned.length?Math.max(...laned.map(c=>c.lane))+1:1;let html="";
  for(let l=0;l<nLanes;l++){html+='<div class="lane">';
    laned.filter(c=>c.lane===l).forEach(c=>{const left=c.s/mc*100,w=(c.e-c.s+1)/mc*100;
      html+='<div class="seg'+(c.hal?' hal':'')+'" style="left:'+left+'%;width:'+w+'%;'+(c.hal?'':'background:'+color)+'" title="'+(c.hal?'⚠ hallucinated anchor — ':'')+'['+c.s+'–'+c.e+'] '+(c.label||'').replace(/"/g,'&quot;')+'"></div>';});
    if(l===0&&gaps)gaps.forEach(g=>{html+='<div class="gapseg" style="left:'+g[0]/mc*100+'%;width:'+(g[1]-g[0]+1)/mc*100+'%" title="uncovered: messages '+g[0]+'–'+g[1]+'"></div>';});
    html+='</div>';}
  return '<div class="track">'+html+'</div>';
}
const vClass=v=>v==="agree"?"v-agree":v==="minor_disagreement"?"v-minor_disagreement":v==="major_disagreement"?"v-major_disagreement":"";
const cards=document.getElementById("cards");
DATA.forEach(d=>{
  let tracks='<div class="trackrow"><div class="tl i" style="color:var(--ideal)">GOLD</div>'+track(d.gold,d.mc,"var(--ideal)",null)+'</div>';
  let bodies="";
  LABELS.forEach((lab,i)=>{
    const m=d.models[lab];const gaps=gapsOf(m.chunks,d.mc);
    tracks+='<div class="trackrow"><div class="mtrack-label" style="color:'+COLORS[i%COLORS.length]+'">'+lab+'</div>'+track(m.chunks,d.mc,COLORS[i%COLORS.length],gaps)+'</div>';
    const chip=m.v?'<span class="chip '+vClass(m.v)+'">'+m.v.replace(/_/g," ")+'</span>':(m.error?'<span class="chip" style="color:var(--bad);border-color:var(--bad)">error</span>':'');
    const scores=m.bs!==null?'<span class="scorepair">B <b>'+m.bs+'</b> · L <b>'+m.ls+'</b></span>':'';
    bodies+='<div class="mverdict"><b>'+lab+'</b> '+chip+' '+scores+(m.s?' — '+m.s.replace(/</g,"&lt;"):'')+(m.error?' <span style="color:var(--bad)">['+m.error+']</span>':'')+'</div>';
  });
  cards.insertAdjacentHTML("beforeend",
    '<div class="card"><div class="cardhead"><h3>'+d.name.replace(/</g,"&lt;")+'</h3><div class="chips"><span class="chip">'+d.mc+' msgs</span></div></div>'+
    '<div class="tracks">'+tracks+'</div>'+bodies+'<div style="height:14px"></div></div>');
});
</script>
</body></html>`;

    const outPath = join(REPO_ROOT, "reports", `chunk-eval-cpm${goldTag ? "-" + goldTag : ""}-${date}.html`);
    await writeFile(outPath, html);
    console.error(`Wrote ${outPath}`);
    console.error(`\nScorecard:`);
    for (const a of aggs) console.error(`  ${a.label.padEnd(12)} boundary=${a.meanB ?? "—"} label=${a.meanL ?? "—"} grade=${a.grade ?? "—"} halluc=${a.hallucinated} validJSON=${a.validJson}/${order.length}`);
    console.error(parityOK ? "\n✓ input parity verified" : "\n⚠ INPUT PARITY FAILED");
}

// ---------------------------------------------------------------------------
// REFERENCE-FREE rubric report — the second lens. No gold track; each
// contestant's own segmentation is scored on coherence / boundary+granularity /
// label against the Lucien chunking policy. Reads judge-rubric-<label>.json.
// ---------------------------------------------------------------------------
interface RubricConv {
    id: string; name: string; mc: number;
    coherence_score: number | null; boundary_score: number | null; label_score: number | null;
    structural_defects: { type: string; detail: string }[]; verdict: string;
    issues: { type: string; detail: string }[]; strengths: string[]; summary: string; error?: boolean;
}

export async function renderRubricReport(outDir: string) {
    const files = await readdir(outDir);
    const genLabels = files.filter((f) => f.startsWith("gen-") && f.endsWith(".json")).map((f) => f.slice(4, -5));
    const gens: Record<string, Map<string, GenConv>> = {};
    const order: string[] = [];
    const nameById = new Map<string, string>(), mcById = new Map<string, number>();
    for (const label of genLabels) {
        const j = JSON.parse(await readFile(join(outDir, `gen-${label}.json`), "utf8"));
        gens[label] = new Map((j.convs as GenConv[]).map((c) => [c.id, c]));
        for (const c of j.convs as GenConv[]) { if (!nameById.has(c.id)) { order.push(c.id); nameById.set(c.id, c.name); mcById.set(c.id, c.mc); } }
    }
    const judges: Record<string, Map<string, RubricConv>> = {};
    const judged: string[] = [];
    for (const label of genLabels) {
        const fname = `judge-rubric-${label}.json`;
        if (!files.includes(fname)) continue;
        const j = JSON.parse(await readFile(join(outDir, fname), "utf8"));
        judges[label] = new Map((j.convs as RubricConv[]).map((c) => [c.id, c]));
        judged.push(label);
    }
    if (!judged.length) { console.error("no judge-rubric-*.json found — run judge-prep --mode rubric and score it first"); return; }

    interface RAgg { label: string; meanCoh: number; meanB: number; meanL: number; excellent: number; acceptable: number; poor: number; defectConvs: number; n: number; grade: string }
    const aggs: RAgg[] = judged.map((label) => {
        const jd = judges[label];
        let sc = 0, sb = 0, sl = 0, nb = 0, excellent = 0, acceptable = 0, poor = 0, defectConvs = 0;
        for (const id of order) {
            const v = jd.get(id); if (!v || v.error) continue;
            nb++; sc += v.coherence_score ?? 0; sb += v.boundary_score ?? 0; sl += v.label_score ?? 0;
            if (v.verdict === "excellent") excellent++; else if (v.verdict === "acceptable") acceptable++; else if (v.verdict === "poor") poor++;
            if ((v.structural_defects ?? []).length) defectConvs++;
        }
        const meanB = nb ? Math.round(sb / nb) : 0;
        return { label, meanCoh: nb ? Math.round(sc / nb) : 0, meanB, meanL: nb ? Math.round(sl / nb) : 0, excellent, acceptable, poor, defectConvs, n: nb, grade: grade(meanB) };
    });

    const DATA = order.map((id) => {
        const models: Record<string, any> = {};
        for (const label of judged) {
            const c = gens[label].get(id); const v = judges[label].get(id);
            models[label] = {
                chunks: (c?.chunks ?? []).map((k) => [k.start, k.end, k.label]),
                coh: v?.coherence_score ?? null, bs: v?.boundary_score ?? null, ls: v?.label_score ?? null,
                v: v?.verdict ?? null, defects: v?.structural_defects ?? [], issues: v?.issues ?? [], s: v?.summary ?? "",
            };
        }
        return { id, name: nameById.get(id), mc: mcById.get(id), models };
    });

    const origHtml = await readFile(ORIG_REPORT, "utf8");
    const css = (origHtml.match(/<style>[\s\S]*?<\/style>/) || ["<style></style>"])[0];
    const COLORS = ["var(--model)", "#7e9cd8", "#c98ec9", "#8fce8f"];
    const date = new Date().toISOString().slice(0, 10);
    const vClassMap: Record<string, string> = { excellent: "v-agree", acceptable: "v-minor_disagreement", poor: "v-major_disagreement" };

    const scorecardRows = aggs.map((a, i) => `
      <tr>
        <td class="mlabel"><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${esc(a.label)}</td>
        <td class="num">${a.meanCoh}</td>
        <td class="num hero">${a.meanB}</td>
        <td class="num">${a.meanL}</td>
        <td class="num">${a.excellent}/${a.acceptable}/${a.poor}</td>
        <td class="num ${a.defectConvs ? "bad" : ""}">${a.defectConvs}/${a.n}</td>
        <td class="gradecell">${a.grade}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chunk Segmentation — reference-free rubric · ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${css}
<style>
.cmptable{width:100%;border-collapse:collapse;margin:36px 0;font-size:12px}
.cmptable th{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);text-align:right;padding:8px 12px;border-bottom:1px solid var(--line);font-weight:500}
.cmptable th:first-child{text-align:left}
.cmptable td{padding:12px;border-bottom:1px solid var(--ink2);text-align:right}
.cmptable td.mlabel{text-align:left;color:var(--moon);font-size:13px}
.cmptable td.num{font-family:var(--serif);font-size:18px}
.cmptable td.num.hero{color:var(--model);font-size:22px}
.cmptable td.num.bad{color:var(--bad)}
.cmptable td.gradecell{font-family:var(--serif);font-weight:900;font-size:24px;color:var(--ideal)}
.swatch{display:inline-block;width:11px;height:11px;margin-right:9px;vertical-align:0}
.mtrack-label{font-size:9px;letter-spacing:.18em;text-transform:uppercase;text-align:right}
.mverdict{font-size:11px;color:var(--dim);margin:6px 0 0;padding-left:66px}
.mverdict b{color:var(--moon)}
.deftag{color:var(--bad);font-family:var(--mono);font-size:10px;margin-left:6px}
</style>
</head><body><div class="wrap">
<header>
  <div class="kicker">Lucien · chunk stage · reference-free rubric</div>
  <h1>How good is the segmentation, <em>on its own merits?</em></h1>
  <p class="sub">No gold reference. Each contestant's chunking is scored directly against the Lucien chunking policy: <b>one chunk = one coherent topic = one article-update</b>. A multi-stage process is ONE topic, sub-topics are penalized, and a long single-topic conversation kept whole is correct. This is the "in the grand scheme, how good is it?" lens — the production-gold report is the separate "how closely did we match the running system?" lens.</p>
  <div class="runmeta">
    <span><b>Corpus</b> ${order.length} convs · ${DATA.reduce((s, d) => s + (d.mc ?? 0), 0)} messages</span>
    <span><b>Reference</b> none — policy rubric</span>
    <span><b>Judge</b> Opus 4.8</span>
    <span><b>Generated</b> ${date}</span>
  </div>
</header>

<h2><span class="idx">§01</span> Scorecard</h2>
<p class="sectionnote"><b>Coherence</b> = is each chunk internally one topic. <b>Boundary</b> = boundary placement + appropriate granularity (the core metric; not too coarse, not sub-topic-fine). <b>Label</b> = specificity/accuracy. <b>E/A/P</b> = excellent / acceptable / poor verdict counts. <b>Defects</b> = conversations with any overlap, nested range, gap, or hallucinated anchor (objectively invalid tilings).</p>
<table class="cmptable">
  <thead><tr>
    <th>Model</th><th>Coherence</th><th>Boundary</th><th>Label</th><th>E/A/P</th><th>Defect convs</th><th>Grade</th>
  </tr></thead>
  <tbody>${scorecardRows}</tbody>
</table>

<h2><span class="idx">§02</span> Boundary maps — all ${order.length} conversations</h2>
<p class="sectionnote">Each conversation shows every judged contestant's own segmentation (no gold track). Hover a segment for its label. Dashed = hallucinated anchor; hatched = uncovered message.</p>
<div id="cards"></div>

<footer style="margin-top:80px;color:var(--faint);font-size:11px;border-top:1px solid var(--line);padding-top:20px">
  Generated ${date} · Lucien chunk segmentation · reference-free rubric · judge Opus 4.8 · ${judged.length} contestants
</footer>
</div>
<script>
const DATA = ${JSON.stringify(DATA)};
const LABELS = ${JSON.stringify(judged)};
const COLORS = ${JSON.stringify(COLORS)};
const VCLASS = ${JSON.stringify(vClassMap)};

function lanes(chunks){const out=[];chunks.forEach(ch=>{let l=0;while(out.some(o=>o.lane===l&&!(ch.e<o.s||ch.s>o.e)))l++;out.push({...ch,lane:l});});return out;}
function gapsOf(chunks,mc){const cov=new Set();chunks.forEach(c=>{const s=c[0]===null?0:c[0],e=c[1]===null?s:c[1];for(let i=s;i<=e;i++)cov.add(i);});const gaps=[];let run=null;for(let i=0;i<mc;i++){if(!cov.has(i)){if(run===null)run=i;}else if(run!==null){gaps.push([run,i-1]);run=null;}}if(run!==null)gaps.push([run,mc-1]);return gaps;}
function track(chunks,mc,color,gaps){
  const resolved=chunks.map(c=>({s:c[0]===null?0:c[0],e:c[1]===null?(c[0]===null?0:c[0]):c[1],label:c[2],hal:c[0]===null||c[1]===null}));
  const laned=lanes(resolved);const nLanes=laned.length?Math.max(...laned.map(c=>c.lane))+1:1;let html="";
  for(let l=0;l<nLanes;l++){html+='<div class="lane">';
    laned.filter(c=>c.lane===l).forEach(c=>{const left=c.s/mc*100,w=(c.e-c.s+1)/mc*100;
      html+='<div class="seg'+(c.hal?' hal':'')+'" style="left:'+left+'%;width:'+w+'%;'+(c.hal?'':'background:'+color)+'" title="'+(c.hal?'⚠ hallucinated anchor — ':'')+'['+c.s+'–'+c.e+'] '+(c.label||'').replace(/"/g,'&quot;')+'"></div>';});
    if(l===0&&gaps)gaps.forEach(g=>{html+='<div class="gapseg" style="left:'+g[0]/mc*100+'%;width:'+(g[1]-g[0]+1)/mc*100+'%" title="uncovered: messages '+g[0]+'–'+g[1]+'"></div>';});
    html+='</div>';}
  return '<div class="track">'+html+'</div>';
}
const cards=document.getElementById("cards");
DATA.forEach(d=>{
  let tracks="",bodies="";
  LABELS.forEach((lab,i)=>{
    const m=d.models[lab];const gaps=gapsOf(m.chunks,d.mc);
    tracks+='<div class="trackrow"><div class="mtrack-label" style="color:'+COLORS[i%COLORS.length]+'">'+lab+'</div>'+track(m.chunks,d.mc,COLORS[i%COLORS.length],gaps)+'</div>';
    const chip=m.v?'<span class="chip '+(VCLASS[m.v]||"")+'">'+m.v+'</span>':'';
    const scores=m.bs!==null?'<span class="scorepair">C <b>'+m.coh+'</b> · B <b>'+m.bs+'</b> · L <b>'+m.ls+'</b></span>':'';
    const defs=(m.defects||[]).map(x=>'<span class="deftag">⚠ '+x.type+'</span>').join("");
    bodies+='<div class="mverdict"><b>'+lab+'</b> '+chip+' '+scores+defs+(m.s?' — '+m.s.replace(/</g,"&lt;"):'')+'</div>';
  });
  cards.insertAdjacentHTML("beforeend",
    '<div class="card"><div class="cardhead"><h3>'+d.name.replace(/</g,"&lt;")+'</h3><div class="chips"><span class="chip">'+d.mc+' msgs</span></div></div>'+
    '<div class="tracks">'+tracks+'</div>'+bodies+'<div style="height:14px"></div></div>');
});
</script>
</body></html>`;

    const outPath = join(REPO_ROOT, "reports", `chunk-eval-rubric-${date}.html`);
    await writeFile(outPath, html);
    console.error(`Wrote ${outPath}`);
    console.error(`\nRubric scorecard (reference-free):`);
    for (const a of aggs) console.error(`  ${a.label.padEnd(20)} coherence=${a.meanCoh} boundary=${a.meanB} label=${a.meanL} grade=${a.grade} E/A/P=${a.excellent}/${a.acceptable}/${a.poor} defects=${a.defectConvs}/${a.n}`);
}
