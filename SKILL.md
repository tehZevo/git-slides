---
name: git-slides
description: Generate a self-contained HTML code-review presentation from unified git diffs and Markdown commentary. Use when asked for Git Slides, a PR walkthrough, or to turn a diff/code review into a shareable slideshow.
---

# Git Slides Code Review

Turn a GitHub pull request or local diff range into one self-contained HTML deck with Markdown on the left and unified diffs on the right.

## Workflow

1. Identify the source: PR number/URL, branch comparison, commit range, or supplied patch.
2. Collect review context when available: title, body, base/head branches, changed-file stats, and full unified diff. Inspect surrounding code only when needed to explain a change accurately.
3. Decide the review story before writing JSON. Prefer 5–8 slides:
   - Title/review overview
   - Problem or motivation
   - One or more coherent implementation changes
   - Tests and validation
   - Risks, follow-ups, or verdict
4. Create a deck JSON file next to where the HTML should be written. Validate it against `schema.json` in this skill’s directory when possible.
5. Generate and open the output:

```sh
node "<skill-dir>/git-slides.mjs" review.slides.json --out review.html
```

Replace `<skill-dir>` with the directory containing this file. The script inlines its template and theme, so the resulting HTML is portable.

## Deck rules

- Use `layout: "title"` only for the opening slide; include repo, PR number, branch, and additions/deletions in `meta` when known.
- Other slides with a non-empty `diffs` array automatically become split diff slides. Omit `type`.
- Group files by review concern, not file order. Put unrelated changes on separate slides.
- Use Markdown to explain the reason, behavior change, risk, or evidence—not narrate every line.
- Preserve real unified-diff output in each `diff` string; include its `diff --git` header and hunk headers.
- Long diffs paginate automatically and repeat the left-hand commentary on continuation pages. Do not manually add page markers.

## Minimal example

```json
{
  "$schema": "<skill-dir>/schema.json",
  "title": "Review PR #495",
  "subtitle": "Keep durable work marked active while startup completes",
  "slides": [
    {
      "layout": "title",
      "eyebrow": "CODE REVIEW",
      "title": "Runs that settle. State that stays.",
      "meta": ["tehZevo/bots", "PR #495", "fix/chat-active-state", "+77 / −6"]
    },
    {
      "eyebrow": "FIX",
      "title": "Close the startup gap",
      "markdown": "Explain why the runtime and database need to agree.",
      "diffs": [
        {
          "path": "packages/server/src/db.ts",
          "diff": "diff --git a/packages/server/src/db.ts b/packages/server/src/db.ts\n..."
        }
      ]
    }
  ]
}
```
