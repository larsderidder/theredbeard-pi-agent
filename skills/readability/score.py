#!/usr/bin/env python3
"""
Readability scorer for practitioner-grade technical writing.

Usage:
  python3 score.py <file>                  Score a single file
  python3 score.py <directory>             Score all .md files in directory
  python3 score.py --all                   Score all .md files recursively from cwd
  python3 score.py --text "some text"      Score inline text
  python3 score.py --compare <f1> <f2>     Side-by-side comparison
  python3 score.py --prose <file>          Score prose only (strip lists, blockquotes)

Targets (calibrated against practitioner-grade technical writing):
  Avg sentence length:  16-21 words
  Flesch Reading Ease:  45-65
  Flesch-Kincaid Grade: 8-12
  Gunning Fog Index:    10-14
"""

import sys
import os
import re
import glob
import argparse

try:
    import textstat
except ImportError:
    print("textstat not found. Installing...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "textstat", "-q"])
    import textstat


def strip_markdown(text: str, prose_only: bool = False) -> str:
    """Remove markdown formatting, code blocks, and frontmatter.
    
    If prose_only is True, also strip list items, blockquotes, and table rows
    so only paragraph prose is scored.
    """
    # Remove YAML frontmatter
    parts = text.split("---", 2)
    if len(parts) >= 3 and len(parts[1]) < 2000:
        text = parts[2]

    # Remove code blocks (they skew sentence/word counts)
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)

    # Remove headers (before prose_only stripping, so they don't become stray sentences)
    text = re.sub(r"^#{1,6}\s+.*$", "", text, flags=re.MULTILINE)

    if prose_only:
        # Remove list items (bullets and numbered)
        text = re.sub(r"^[-*+]\s+.*$", "", text, flags=re.MULTILINE)
        text = re.sub(r"^\d+\.\s+.*$", "", text, flags=re.MULTILINE)
        # Remove blockquotes
        text = re.sub(r"^>.*$", "", text, flags=re.MULTILINE)

    # Remove markdown links, keep text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)

    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", text)

    # Remove markdown tables (header separator rows)
    text = re.sub(r"^\|[-:| ]+\|$", "", text, flags=re.MULTILINE)
    # Remove table rows (they confuse sentence splitting)
    text = re.sub(r"^\|.*\|$", "", text, flags=re.MULTILINE)

    # Collapse whitespace
    text = re.sub(r"\n{2,}", ". ", text)
    text = re.sub(r"\s+", " ", text).strip()

    return text


def strip_html(text: str) -> str:
    """Remove HTML tags and extract text content."""
    text = re.sub(r"<style.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<script.*?</script>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# Targets calibrated against practitioner-grade technical writing
TARGETS = {
    "words_per_sentence": (16, 21),
    "flesch_kincaid_grade": (8, 12),
    "gunning_fog": (10, 14),
    "flesch_reading_ease": (45, 65),
}

LABELS = {
    "words_per_sentence": "Avg sentence length",
    "flesch_kincaid_grade": "Flesch-Kincaid Grade",
    "gunning_fog": "Gunning Fog Index",
    "flesch_reading_ease": "Flesch Reading Ease",
}


def sentence_length_variation(text: str) -> float | None:
    """Coefficient of variation of sentence lengths. Higher = more varied."""
    import statistics
    sents = re.split(r"(?<=[.!?])\s+", text)
    lengths = [len(s.split()) for s in sents if len(s.split()) >= 3]
    if len(lengths) < 5:
        return None
    mean = statistics.mean(lengths)
    if mean == 0:
        return None
    return statistics.stdev(lengths) / mean


def score_text(raw_text: str, is_html: bool = False, prose_only: bool = False) -> dict | None:
    if is_html:
        clean = strip_html(raw_text)
    else:
        clean = strip_markdown(raw_text, prose_only=prose_only)

    if textstat.lexicon_count(clean) < 50:
        return None

    cv = sentence_length_variation(clean)

    return {
        "words_per_sentence": textstat.words_per_sentence(clean),
        "flesch_kincaid_grade": textstat.flesch_kincaid_grade(clean),
        "gunning_fog": textstat.gunning_fog(clean),
        "flesch_reading_ease": textstat.flesch_reading_ease(clean),
        "coleman_liau": textstat.coleman_liau_index(clean),
        "smog": textstat.smog_index(clean),
        "word_count": textstat.lexicon_count(clean),
        "sentence_count": textstat.sentence_count(clean),
        "avg_syllables": textstat.avg_syllables_per_word(clean),
        "variation": cv,
    }


def status_icon(key: str, value: float) -> str:
    if key not in TARGETS:
        return " "
    low, high = TARGETS[key]
    if low <= value <= high:
        return "✓"
    elif value < low:
        return "↓"
    else:
        return "↑"


def print_report(name: str, scores: dict):
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"  {scores['word_count']} words, {scores['sentence_count']} sentences")
    print(f"{'=' * 60}")

    for key in ["words_per_sentence", "flesch_reading_ease", "flesch_kincaid_grade", "gunning_fog"]:
        icon = status_icon(key, scores[key])
        label = LABELS[key]
        value = scores[key]
        target_str = ""
        if key in TARGETS:
            low, high = TARGETS[key]
            target_str = f"  (target: {low}-{high})"
        print(f"  {icon} {label:<24} {value:6.1f}{target_str}")

    print(f"    {'Coleman-Liau Index':<24} {scores['coleman_liau']:6.1f}")
    print(f"    {'SMOG Index':<24} {scores['smog']:6.1f}")
    print(f"    {'Avg syllables/word':<24} {scores['avg_syllables']:6.2f}")
    if scores.get("variation") is not None:
        cv = scores["variation"]
        cv_icon = "✓" if 0.5 <= cv <= 0.9 else "↓" if cv < 0.5 else "↑"
        print(f"  {cv_icon} {'Sentence variation':<24} {cv:6.2f}  (target: 0.50-0.90)")


def print_comparison(results: list[tuple[str, dict]]):
    """Side-by-side comparison table."""
    if len(results) < 2:
        return

    header = f"{'Metric':<24}"
    for name, _ in results:
        short = os.path.basename(name).replace(".md", "")[:20]
        header += f" {short:>22}"
    print(f"\n{header}")
    print("-" * (24 + 23 * len(results)))

    for key in ["words_per_sentence", "flesch_reading_ease", "flesch_kincaid_grade", "gunning_fog", "coleman_liau", "smog"]:
        label = LABELS.get(key, key.replace("_", " ").title())
        row = f"{label:<24}"
        for _, scores in results:
            icon = status_icon(key, scores[key])
            row += f" {icon}{scores[key]:>20.1f}"
        print(row)


def print_summary(all_scores: list[tuple[str, dict]]):
    if len(all_scores) <= 1:
        return

    print(f"\n{'=' * 60}")
    print(f"  SUMMARY ({len(all_scores)} files)")
    print(f"{'=' * 60}")
    for key in ["words_per_sentence", "flesch_reading_ease", "flesch_kincaid_grade", "gunning_fog"]:
        values = [s[key] for _, s in all_scores]
        avg = sum(values) / len(values)
        lo = min(values)
        hi = max(values)
        icon = status_icon(key, avg)
        label = LABELS[key]
        print(f"  {icon} {label:<24} avg {avg:5.1f}  (range {lo:.1f}-{hi:.1f})")


def collect_files(args: list[str]) -> list[str]:
    paths = []
    for arg in args:
        if arg == "--all":
            paths.extend(glob.glob("**/*.md", recursive=True))
        elif os.path.isdir(arg):
            paths.extend(glob.glob(os.path.join(arg, "**/*.md"), recursive=True))
        elif os.path.isfile(arg):
            paths.append(arg)
        else:
            # Try as glob
            expanded = glob.glob(arg)
            if expanded:
                paths.extend(expanded)
            else:
                print(f"Not found: {arg}")
    return sorted(set(paths))


def main():
    parser = argparse.ArgumentParser(description="Readability scorer")
    parser.add_argument("files", nargs="*", help="Files, directories, or --all")
    parser.add_argument("--text", "-t", help="Score inline text")
    parser.add_argument("--compare", "-c", action="store_true", help="Side-by-side comparison")
    parser.add_argument("--all", "-a", action="store_true", help="Score all .md files recursively")
    parser.add_argument("--prose", "-p", action="store_true", help="Score prose only (strip lists, blockquotes)")
    args = parser.parse_args()

    if args.text:
        scores = score_text(args.text, prose_only=args.prose)
        if scores:
            print_report("(inline text)", scores)
        else:
            print("Text too short to score (need 50+ words).")
        return

    file_args = args.files[:]
    if args.all:
        file_args.append("--all")

    if not file_args:
        print(__doc__)
        sys.exit(1)

    paths = collect_files(file_args)
    if not paths:
        print("No files found.")
        sys.exit(1)

    all_scores = []
    for path in paths:
        with open(path) as f:
            text = f.read()
        is_html = path.endswith((".html", ".htm", ".astro"))
        scores = score_text(text, is_html=is_html, prose_only=args.prose)
        if scores:
            name = path
            all_scores.append((name, scores))

    if args.compare and len(all_scores) >= 2:
        for name, scores in all_scores:
            print_report(os.path.basename(name), scores)
        print_comparison(all_scores)
    else:
        for name, scores in all_scores:
            print_report(os.path.basename(name), scores)

    print_summary(all_scores)


if __name__ == "__main__":
    main()
