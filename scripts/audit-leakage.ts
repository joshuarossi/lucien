// One-off: verify the benchmark is fully quarantined from the finetune training data.
const read = async (p: string) => JSON.parse(await Bun.file(p).text());
const ds = {
    chunk: await read("benchmark/dataset/chunk.json"),
    cluster: (await read("benchmark/dataset/cluster.json")).cases,
    synthesize: await read("benchmark/dataset/synthesize.json"),
    wikify: await read("benchmark/dataset/wikify.json"),
};
const benchConv = new Set<string>(ds.chunk.map((c: any) => c.id));
const benchLabel = new Set<string>(ds.cluster.map((c: any) => c.label));
const benchSynthBucket = new Set<string>(ds.synthesize.map((c: any) => c.id));
const benchWikifyStem = new Set<string>(ds.wikify.map((c: any) => c.id));
const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, "_");

async function lines(stage: string) {
    const out: any[] = [];
    for (const f of ["train", "valid"]) {
        let t = "";
        try { t = await Bun.file(`benchmark/finetune/${stage}/${f}.jsonl`).text(); } catch { continue; }
        for (const ln of t.trim().split("\n").filter(Boolean)) out.push(JSON.parse(ln));
    }
    return out;
}
const chunkTr = await lines("chunk"), clusterTr = await lines("cluster"), synthTr = await lines("synthesize"), wikTr = await lines("wikify");

let chunkTargLeak = 0;
for (const o of chunkTr) { const m = o.messages[1].content.match(/uuid:\s*([0-9a-f-]{36})\)/); if (m && benchConv.has(m[1])) chunkTargLeak++; }

let clLabelLeak = 0;
for (const o of clusterTr) { const u = o.messages[1].content; for (const l of benchLabel) { if (u.includes(l)) { clLabelLeak++; break; } } }

const synthTarg = new Set(synthTr.map((o) => { const m = o.messages[1].content.match(/ARTICLE TO WRITE:\nBucket:\s*(.+)/); return m ? norm(m[1].trim()) : null; }).filter(Boolean));
const A = [...benchWikifyStem].map(norm).filter((s) => synthTarg.has(s));
const A2 = [...benchSynthBucket].map(norm).filter((s) => synthTarg.has(s));

const wikTarg = new Set(wikTr.map((o) => { const l = o.messages[1].content.split("\n").find((x: string) => /^#\s+/.test(x)); return l ? norm(l.replace(/^#\s+/, "").trim()) : null; }).filter(Boolean));
const B = [...benchSynthBucket].map(norm).filter((s) => wikTarg.has(s));
const B2 = [...benchWikifyStem].map(norm).filter((s) => wikTarg.has(s));

let C = 0;
for (const o of synthTr) { const u = o.messages[1].content; for (const uuid of benchConv) { if (u.includes(uuid)) { C++; break; } } }

console.log("chunk  — benchmark conv as TRAINING TARGET:", chunkTargLeak);
console.log("cluster— benchmark label in training prompt:", clLabelLeak);
console.log("GAP A  — wikify-bench article as SYNTH target:", A.length, "| synth-bench as SYNTH target:", A2.length);
console.log("GAP B  — synth-bench bucket as WIKIFY target:", B.length, "| wikify-bench as WIKIFY target:", B2.length);
console.log("GAP C  — benchmark conv in synth prompt (masked):", C);
const total = chunkTargLeak + clLabelLeak + A.length + A2.length + B.length + B2.length + C;
console.log(total === 0 ? "\n✅ CLEAN — benchmark fully quarantined from training data." : `\n❌ ${total} leak(s) remain.`);
