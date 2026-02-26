---
name: readability
description: "Score text readability against writing benchmarks for practitioner-grade technical content. Use after writing to check it doesn't read like AI output."
---

# Readability Scorer

Scores text against benchmarks calibrated for practitioner-grade technical writing. Use it as a quality gate after drafting or editing content.

## Usage

```bash
python3 <skill-dir>/score.py <file-or-directory>
python3 <skill-dir>/score.py --all    # score all .md files recursively
python3 <skill-dir>/score.py --text "paste some text here"
python3 <skill-dir>/score.py --prose <file>   # strip lists/blockquotes, score prose only
python3 <skill-dir>/score.py --compare <f1> <f2>  # side-by-side
```

`textstat` is auto-installed if missing.

## Targets

Calibrated against practitioner-grade technical writing (blog posts, articles, technical docs). These also match the complexity level of practitioner-grade technical writing like Anthropic's engineering blog (avg sentence length 20.0).

| Metric | Target | Notes |
|--------|--------|-------|
| Avg sentence length | 16-21 words | **Most important.** AI text lands at 11-14. Good technical writing is at 16-20. Below 16 = too choppy. |
| Flesch Reading Ease | 45-65 | Technical vocabulary pulls this down; that's fine. |
| Flesch-Kincaid Grade | 8-12 | Above 12 is OK for dense technical topics. |
| Gunning Fog Index | 10-14 | Same. |
| Sentence variation | 0.50-0.90 | Coefficient of variation of sentence lengths. Below 0.50 = monotone rhythm (all sentences similar length). Good writing lands at 0.60-0.80. |

## How to Interpret

**Sentence length is the signal that matters most.** It's the clearest quantitative difference between AI-generated text and human writing. If average sentence length is below 16, the draft has too many short declarative sentences that should be joined with semicolons, commas, or conjunctions.

**Grade-level metrics run high on technical content.** That's the vocabulary (tokens, context window, multi-agent, programmatically), not the sentence structure. A FK Grade of 12-13 on a technical article about LLM context management is fine. A FK Grade of 12-13 on a LinkedIn post is not.

**Flesch Reading Ease below 45** on non-technical content means the writing is too dense. On technical content, 40-45 is acceptable if the complexity comes from the subject matter rather than from unnecessarily complex sentence construction.

## Reference Benchmarks

| Source | AvgSL | FRE | FK | Fog |
|--------|-------|-----|----|-----|
| Anthropic: "Effective CE for Agents" | 20.0 | 32.0 | 13.8 | 16.3 |
| LangChain: "CE for Agents" | 14.7 | 48.3 | 10.2 | 12.5 |
| Typical AI-generated prose | 11-14 | 60-70 | 7-10 | 9-12 |

## After Scoring

If the draft is below target on sentence length:
1. Look for consecutive short sentences that are clearly part of the same thought and join them with semicolons
2. Look for "orphaned short sentences" mid-paragraph that should be folded into the surrounding sentence
3. Look for places where two sentences share a subject and can be combined with a conjunction

Do NOT pad sentences with filler words to hit the target. The fix is always structural: combining related thoughts, not inflating individual sentences.

## When Scores Don't Apply

**List-heavy and table-heavy content** (pattern catalogs, API docs, checklists, comparison tables) will score low on sentence length because textstat counts each bullet point, numbered step, and table cell as a sentence. A page with solid prose paragraphs and a dozen short bullets or a summary table will land at 9-12 avg sentence length regardless of writing quality. This is fine.

Use `--prose` to strip lists and blockquotes and score only the paragraph prose. This gives a much more accurate picture for list-heavy content. If the prose scores well but the default mode scores low, the content is fine.

The sentence length target matters for the *prose sections*: problem descriptions, explanations, analysis. If those read choppy, fix them. But don't restructure bullets and numbered steps into compound sentences just to hit a target. The format is appropriate for the content type.
