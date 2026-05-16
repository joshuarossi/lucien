/**
 * Turn raw LLM synthesis output into a clean article body, or reject it.
 *
 * The model is instructed to emit ONLY the markdown article, but it
 * sometimes wraps the article in conversational preamble/postamble, or
 * refuses and narrates instead. Writing that text into the Dreaming
 * pollutes the wiki, so we strip the obvious wrappers and hard-reject
 * anything that doesn't look like a real article.
 *
 * Throws on unsalvageable output so the caller skips the write and the
 * bucket is retried on the next run (no file written = no false "done").
 */
export function sanitizeArticleOutput(raw: string): string {
    let s = raw.trim();

    // 1. Strip a leading fenced block wrapper if the whole thing is fenced.
    s = s.replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();

    // 2. Drop leading non-article lines until the first markdown heading
    //    (`# `) or a stub marker (`{{stub}}`). LLM preamble like
    //    "I'll proceed with..." or "Here is the article:" lives here.
    const lines = s.split("\n");
    let start = 0;
    while (
        start < lines.length &&
        !/^\s*#\s/.test(lines[start]) &&
        !/^\s*\{\{stub\}\}/i.test(lines[start])
    ) {
        start++;
    }
    if (start >= lines.length) {
        throw new Error(
            "sanitizeArticleOutput: no markdown heading or {{stub}} found — output is not an article"
        );
    }
    s = lines.slice(start).join("\n").trim();

    // 3. Drop trailing maintainer-chatter blocks. If a line at the top
    //    level introduces an out-of-band note, cut from there down.
    const postambleMarkers = [
        /^\*\*?Note for the maintainer/i,
        /^Note to (the )?maintainer/i,
        /^\*\*?Note:\*\*?\s+I (did not|cannot|could not|won't|will not)/i,
        /^I (did not|cannot|could not) (generate|write|produce)/i,
        /^Let me know (which|how|if)/i,
    ];
    const outLines = s.split("\n");
    for (let i = 0; i < outLines.length; i++) {
        if (postambleMarkers.some((re) => re.test(outLines[i].trim()))) {
            s = outLines.slice(0, i).join("\n").trim();
            break;
        }
    }

    // 4. Final validation.
    if (!/^\s*(#\s|\{\{stub\}\})/i.test(s)) {
        throw new Error(
            "sanitizeArticleOutput: cleaned output does not start with a heading or {{stub}}"
        );
    }
    if (s.length < 50) {
        throw new Error(`sanitizeArticleOutput: article too short (${s.length} chars)`);
    }
    // Refusal phrases that should never be article content even mid-text
    // when they're the dominant content.
    const refusalSignals = [
        "requires your permission",
        "I did not generate",
        "fabricates nothing and emits no dead citations",
        "isn't on disk at the expected path",
    ];
    if (refusalSignals.some((p) => s.includes(p))) {
        throw new Error(
            "sanitizeArticleOutput: output contains refusal/meta signal after cleaning"
        );
    }

    return s;
}
