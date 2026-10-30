#!/usr/bin/env node
/**
 * Git Slides — turn a small JSON deck definition into one self-contained HTML file.
 *
 *   node git-slides.mjs deck.json
 *   node git-slides.mjs deck.json --out pr-495.html
 *
 * No dependencies, no network requests, no build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const HELP = `
Git Slides — JSON to a single-file HTML slideshow

Usage:
  node git-slides.mjs <deck.json> [--out <file.html>]

Deck shape:
  {
    "title": "Deck title",
    "subtitle": "Optional deck subtitle",
    "theme": { "accent": "#5eead4", "accent2": "#818cf8" },
    "options": { "maxDiffLines": 28 },
    "slides": [
      { "type": "title", "eyebrow": "...", "title": "...", "subtitle": "...", "meta": ["..."] },
      { "type": "markdown", "eyebrow": "...", "title": "...", "content": "## Markdown\\n..." },
      { "type": "split", "eyebrow": "...", "title": "...",
        "markdown": "Explanation on the left.",
        "diffs": [
          { "path": "src/file.ts", "diff": "diff --git ..." },
          { "path": "src/other.ts", "diff": "diff --git ..." }
        ]
      }
    ]
  }

A split slide puts markdown on the left and one or more diffs on the right.
Long diffs paginate automatically; each page repeats the left-hand markdown.
`;

const DEFAULT_THEME = {
  bg: "#070a12",
  bg2: "#0b1220",
  panel: "#0d1524",
  panel2: "#09101c",
  line: "#1d2a3f",
  text: "#e8eef8",
  muted: "#8fa0b8",
  accent: "#5eead4",
  accent2: "#818cf8",
  add: "#34d399",
  del: "#fb7185",
  warn: "#fbbf24",
};

const cssColorKeys = new Set(Object.keys(DEFAULT_THEME));

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });

const escapeAttr = (value) => escapeHtml(value).replace(/`/g, "&#96;");

const sanitizeColor = (value, fallback) => {
  const raw = String(value ?? "").trim();
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(raw) ? raw : fallback;
};

const sanitizeHref = (value) => {
  const href = String(value ?? "").trim();
  if (/^(https?:\/\/|mailto:)/i.test(href) || /^(#|\/|\.{1,2}\/)/.test(href)) {
    return href;
  }
  return "";
};

function inlineMarkdown(source) {
  const stash = [];
  let text = String(source ?? "");

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000${stash.length}\u0000`;
    stash.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = sanitizeHref(href.replace(/&amp;/g, "&"));
    return safe
      ? `<a href="${escapeAttr(safe)}" target="_blank" rel="noreferrer">${label}</a>`
      : label;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
  return text;
}

const isTableDivider = (line) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(line, lines, index) {
  if (/^\s*$/.test(line)) return true;
  if (/^\s*(```|~~~)/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) return true;
  return false;
}

function markdownToHtml(source) {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      i += 1;
      const code = [];
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(
        `<pre class="code-block${lang ? ` language-${escapeAttr(lang)}` : ""}"><code>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[i + 1] ?? "")) {
      const headers = tableCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${headers
          .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map(
            (row) =>
              `<tr>${headers
                .map((_, column) => `<td>${inlineMarkdown(row[column] ?? "")}</td>`)
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
        i += 1;
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])
        ) {
          item += ` ${lines[i].trim()}`;
          i += 1;
        }
        items.push(`<li>${inlineMarkdown(item)}</li>`);
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i], lines, i)) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

function pathFromDiffHeader(header) {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  return match ? match[2] : null;
}

function parseDiffFiles(raw, fallbackPath) {
  const lines = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const files = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = {
        path: pathFromDiffHeader(line) ?? fallbackPath ?? "diff",
        lines: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (!current) {
      current = {
        path: fallbackPath ?? "diff",
        lines: [],
        additions: 0,
        deletions: 0,
      };
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path !== "/dev/null" && current.lines.every((entry) => !entry.startsWith("+++ "))) {
        current.path = path.replace(/^b\//, "");
      }
    }

    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
    current.lines.push(line);
  }

  if (current) files.push(current);
  return files;
}

function parseDiffUnits(fileLines) {
  const units = [];
  let oldNumber = 0;
  let newNumber = 0;
  let hunk = null;

  for (const line of fileLines) {
    if (/^\\ No newline at end of file/.test(line)) {
      units.push({ kind: "meta", text: line.slice(2) });
      continue;
    }

    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldNumber = Number(match[1]);
        newNumber = Number(match[2]);
      }
      hunk = line;
      units.push({ kind: "hunk", text: line });
      continue;
    }

    if (/^(index |--- |\+\+\+ )/.test(line)) continue;

    if (
      /^(new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/.test(
        line,
      )
    ) {
      units.push({ kind: "meta", text: line });
      continue;
    }

    if (line.startsWith("+")) {
      units.push({
        kind: "line",
        type: "add",
        text: line.slice(1),
        oldNo: null,
        newNo: newNumber,
        hunk,
      });
      newNumber += 1;
      continue;
    }

    if (line.startsWith("-")) {
      units.push({
        kind: "line",
        type: "del",
        text: line.slice(1),
        oldNo: oldNumber,
        newNo: null,
        hunk,
      });
      oldNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      units.push({
        kind: "line",
        type: "ctx",
        text: line.slice(1),
        oldNo: oldNumber,
        newNo: newNumber,
        hunk,
      });
      oldNumber += 1;
      newNumber += 1;
      continue;
    }

    if (line === "") continue;
    units.push({ kind: "meta", text: line });
  }

  return units;
}

function paginateDiffUnits(units, maxLines) {
  const total = units.length;
  if (!total) return [[]];

  // A small overflow fits on one page once the viewer auto-shrinks the font.
  if (total <= Math.ceil(maxLines * 1.25)) return [units];

  const pageCount = Math.ceil(total / maxLines);
  const base = Math.floor(total / pageCount);
  const extra = total % pageCount;
  const pages = [];
  let cursor = 0;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const size = base + (pageIndex < extra ? 1 : 0);
    const slice = units.slice(cursor, cursor + size);
    cursor += size;

    if (pageIndex > 0 && slice[0]?.kind === "line" && slice[0].hunk) {
      slice.unshift({
        kind: "hunk",
        text: `${slice[0].hunk}  (continued)`,
        continued: true,
      });
    }

    pages.push(slice);
  }

  return pages;
}

function buildDiffPages(raw, { maxLines, path: fallbackPath }) {
  const files = parseDiffFiles(raw, fallbackPath);
  const pages = [];

  for (const file of files) {
    const units = parseDiffUnits(file.lines);
    const chunks = paginateDiffUnits(units, maxLines);
    chunks.forEach((chunk, chunkIndex) => {
      pages.push({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        units: chunk,
        firstPageOfFile: chunkIndex === 0,
        continued: chunkIndex > 0,
      });
    });
  }

  return pages.length
    ? pages
    : [{ path: fallbackPath ?? "diff", additions: 0, deletions: 0, units: [], firstPageOfFile: true }];
}

function renderDiffRow(unit) {
  if (unit.kind === "hunk") {
    return `<div class="diff-row diff-hunk${unit.continued ? " is-continued" : ""}"><span class="diff-no"></span><span class="diff-no"></span><span class="diff-sign"></span><code>${escapeHtml(unit.text)}</code></div>`;
  }

  if (unit.kind === "meta") {
    return `<div class="diff-row diff-meta"><span class="diff-no"></span><span class="diff-no"></span><span class="diff-sign"></span><code>${escapeHtml(unit.text)}</code></div>`;
  }

  const sign = unit.type === "add" ? "+" : unit.type === "del" ? "-" : " ";
  return `<div class="diff-row diff-${unit.type}"><span class="diff-no">${unit.oldNo ?? ""}</span><span class="diff-no">${unit.newNo ?? ""}</span><span class="diff-sign">${sign}</span><code>${escapeHtml(unit.text) || " "}</code></div>`;
}

function renderDiffCard(page) {
  const rows = page.units.map(renderDiffRow).join("\n");
  const rowsCount = page.units.filter((unit) => unit.kind !== "hunk").length;
  const size = rowsCount > 42 ? 12.5 : rowsCount > 34 ? 14 : rowsCount > 27 ? 15.5 : rowsCount > 20 ? 17 : 18.5;

  return `<div class="diff-card" style="--diff-fs:${size}px">
    <div class="diff-top">
      <div class="diff-path"><span class="diff-path-icon" aria-hidden="true">◆</span>${escapeHtml(page.path)}</div>
      <div class="diff-stats">
        <span class="stat stat-add">+${page.additions}</span>
        <span class="stat stat-del">−${page.deletions}</span>
      </div>
    </div>
    <div class="diff-body" tabindex="0" aria-label="Diff for ${escapeAttr(page.path)}">
      ${rows || `<div class="diff-row diff-meta"><span class="diff-no"></span><span class="diff-no"></span><span class="diff-sign"></span><code>No changes</code></div>`}
    </div>
  </div>`;
}

function slideHeading(slide, fallback) {
  const eyebrow = slide.eyebrow
    ? `<div class="eyebrow">${inlineMarkdown(slide.eyebrow)}</div>`
    : "";
  const title = slide.title
    ? `<h2>${inlineMarkdown(slide.title)}</h2>`
    : `<h2>${escapeHtml(fallback)}</h2>`;
  const description = slide.description
    ? `<p class="lede">${inlineMarkdown(slide.description)}</p>`
    : "";
  return `${eyebrow}${title}${description}`;
}

function renderSlide(slide, index, total, ctx, pager) {
  const active = index === 0 ? " active" : "";
  const aria = index === 0 ? "false" : "true";
  const label = slide.title ? String(slide.title).replace(/\n/g, " ") : `Slide ${index + 1}`;
  const common = `class="slide slide-${escapeAttr(slide.type ?? "markdown")}${active}" id="slide-${index}" data-index="${index}" data-title="${escapeAttr(label)}" aria-hidden="${aria}"`;

  if (slide.type === "title") {
    const meta = Array.isArray(slide.meta)
      ? slide.meta
          .map((item) => `<span class="chip">${inlineMarkdown(item)}</span>`)
          .join("")
      : "";
    return `<section ${common}>
      <div class="slide-inner title-inner">
        <div class="title-glow" aria-hidden="true"></div>
        ${slide.eyebrow ? `<div class="eyebrow title-eyebrow reveal">${inlineMarkdown(slide.eyebrow)}</div>` : ""}
        <h1 class="reveal">${inlineMarkdown(slide.title ?? ctx.deck.title ?? "Untitled deck")}</h1>
        ${slide.subtitle ? `<p class="title-sub reveal">${inlineMarkdown(slide.subtitle)}</p>` : ""}
        ${meta ? `<div class="title-meta reveal">${meta}</div>` : ""}
        <div class="title-hint reveal">→ or space to begin</div>
      </div>
    </section>`;
  }

  if (slide.type === "split") {
    const diffs = (slide.__diffs ?? []).map((page) => renderDiffCard(page)).join("");
    return `<section ${common}>
      <div class="slide-inner split-inner">
        <div class="split-left reveal">
          ${slide.eyebrow ? `<div class="eyebrow">${inlineMarkdown(slide.eyebrow)}</div>` : ""}
          ${slide.title ? `<h2>${inlineMarkdown(slide.title)}</h2>` : ""}
          <div class="markdown split-markdown">${markdownToHtml(slide.markdown ?? slide.content ?? "")}</div>
          ${pager ? `<div class="pager split-pager">${pager}</div>` : ""}
        </div>
        <div class="split-right reveal">${diffs}</div>
      </div>
    </section>`;
  }

  if (slide.type === "diff") {
    return `<section ${common}>
      <div class="slide-inner">
        <header class="slide-head reveal">
          ${slideHeading(slide, "Diff")}
          ${pager ? `<div class="pager">${pager}</div>` : ""}
        </header>
        <div class="slide-body reveal">${renderDiffCard(slide.__page)}</div>
      </div>
    </section>`;
  }

  return `<section ${common}>
    <div class="slide-inner${slide.align === "center" ? " align-center" : ""}">
      <header class="slide-head reveal">
        ${slideHeading(slide, "Slide")}
      </header>
      <div class="slide-body markdown reveal">${markdownToHtml(slide.content ?? "")}</div>
    </div>
  </section>`;
}

function normalizeDeck(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Deck JSON must be an object.");
  }
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    throw new Error('Deck JSON must include a non-empty "slides" array.');
  }
  return input;
}

function buildSlides(deck) {
  const maxDiffLines = Math.max(
    8,
    Math.min(80, Number(deck.options?.maxDiffLines) || 28),
  );
  const slides = [];

  for (const slide of deck.slides) {
    if (slide?.type === "split") {
      const defs =
        Array.isArray(slide.diffs) && slide.diffs.length
          ? slide.diffs
          : [{ diff: slide.diff ?? "", path: slide.path, maxLines: slide.maxLines }];
      const builds = defs.map((entry) => {
        const perDiffMax = Math.max(
          8,
          Math.min(
            80,
            Number(entry.maxLines) ||
              Number(slide.maxLines) ||
              maxDiffLines,
          ),
        );
        return {
          entry,
          pages: buildDiffPages(entry.diff ?? "", {
            maxLines: perDiffMax,
            path: entry.path ?? slide.path,
          }),
        };
      });
      const pageCount = Math.max(1, ...builds.map((build) => build.pages.length));

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const visibleDiffs = builds
          .filter((build) => build.pages[pageIndex])
          .map((build) => build.pages[pageIndex]);
        slides.push({
          ...slide,
          __diffs: visibleDiffs,
          __pager:
            pageCount > 1 ? `${pageIndex + 1} / ${pageCount}` : "",
        });
      }
      continue;
    }

    if (slide?.type === "diff") {
      const perSlideMax = Math.max(
        8,
        Math.min(80, Number(slide.maxLines) || maxDiffLines),
      );
      const pages = buildDiffPages(slide.diff ?? "", {
        maxLines: perSlideMax,
        path: slide.path,
      });
      pages.forEach((page, pageIndex) => {
        slides.push({
          ...slide,
          __page: page,
          __pager:
            pages.length > 1 ? `${pageIndex + 1} / ${pages.length}` : "",
        });
      });
      continue;
    }

    slides.push(slide);
  }

  return slides;
}

function renderHtml(deck, slides) {
  const theme = { ...DEFAULT_THEME };
  for (const key of cssColorKeys) {
    if (deck.theme?.[key] != null) {
      theme[key] = sanitizeColor(deck.theme[key], DEFAULT_THEME[key]);
    }
  }

  const title = deck.title ?? "Git Slides";
  const subtitle = deck.subtitle ?? "";
  const total = slides.length;
  const context = { deck };
  const slideHtml = slides
    .map((slide, index) =>
      renderSlide(slide, index, total, context, slide.__pager),
    )
    .join("\n");

  const overviewItems = slides
    .map((slide, index) => {
      const slideTitle = String(slide.title ?? `Slide ${index + 1}`)
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ");
      const kind = slide.type === "diff" ? "diff" : slide.type === "title" ? "title" : "note";
      return `<li><button type="button" data-goto="${index}" class="overview-item">
        <span class="overview-num">${String(index + 1).padStart(2, "0")}</span>
        <span class="overview-title">${escapeHtml(slideTitle)}</span>
        <span class="overview-kind">${kind}</span>
      </button></li>`;
    })
    .join("\n");

  const cssVars = [
    `--bg:${theme.bg}`,
    `--bg2:${theme.bg2}`,
    `--panel:${theme.panel}`,
    `--panel2:${theme.panel2}`,
    `--line:${theme.line}`,
    `--text:${theme.text}`,
    `--muted:${theme.muted}`,
    `--accent:${theme.accent}`,
    `--accent2:${theme.accent2}`,
    `--add:${theme.add}`,
    `--del:${theme.del}`,
    `--warn:${theme.warn}`,
  ].join(";");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>
:root { ${cssVars}; --sans: "Inter", "SF Pro Display", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --mono: "JetBrains Mono", "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  background:
    radial-gradient(1200px 700px at 15% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 62%),
    radial-gradient(1000px 700px at 100% 110%, color-mix(in srgb, var(--accent2) 12%, transparent), transparent 60%),
    linear-gradient(145deg, var(--bg), var(--bg2));
  color: var(--text);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
body::before {
  content: "";
  position: fixed; inset: 0; pointer-events: none; opacity: .22; z-index: 0;
  background-image: linear-gradient(color-mix(in srgb, var(--line) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--line) 45%, transparent) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(ellipse at center, black, transparent 82%);
}
button { font: inherit; color: inherit; }
a { color: var(--accent); text-underline-offset: .18em; }

.topbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  display: flex; align-items: center; gap: 16px;
  padding: 18px clamp(20px, 3.4vw, 48px);
  pointer-events: none;
}
.brand {
  font-family: var(--mono); font-size: 12px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--muted); white-space: nowrap;
}
.brand b { color: var(--accent); font-weight: 600; }
.deck-label {
  font-size: 12px; color: var(--muted); opacity: .8;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.topbar-spacer { flex: 1; }
.icon-btn {
  pointer-events: auto; border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 72%, transparent);
  border-radius: 10px; height: 36px; min-width: 36px; padding: 0 12px;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); cursor: pointer; font-family: var(--mono); font-size: 11px;
  transition: color .18s, border-color .18s, background .18s;
}
.icon-btn:hover, .icon-btn:focus-visible { color: var(--text); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); background: var(--panel); outline: none; }

.deck { position: relative; z-index: 1; height: 100%; }
.slide {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: clamp(64px, 9vh, 104px) clamp(24px, 6vw, 96px) clamp(72px, 10vh, 112px);
  opacity: 0; visibility: hidden; transform: translateY(18px) scale(.995);
  transition: opacity .42s ease, transform .42s cubic-bezier(.2,.75,.25,1), visibility .42s;
}
.slide.active { opacity: 1; visibility: visible; transform: none; z-index: 2; }
.slide.prev { transform: translateY(-18px) scale(.995); }
.slide-diff { padding-top: clamp(58px, 7vh, 86px); padding-bottom: clamp(62px, 8.4vh, 94px); }
.slide-inner { width: min(1240px, 100%); max-height: 100%; display: flex; flex-direction: column; min-height: 0; }
.slide-split {
  padding-top: clamp(68px, 8.2vh, 94px); padding-bottom: clamp(68px, 8.6vh, 96px);
  padding-left: clamp(24px, 4.6vw, 72px); padding-right: clamp(24px, 4.6vw, 72px);
}
.slide-split .slide-inner { width: min(1460px, 100%); height: 100%; }
.split-inner { flex-direction: row; align-items: stretch; gap: clamp(26px, 3.2vw, 50px); }
.split-left {
  flex: 0 0 min(36%, 420px); max-width: 420px; min-height: 0;
  display: flex; flex-direction: column; justify-content: flex-start;
  padding-top: 4px;
}
.split-left h2 {
  margin: 0 0 18px; font-size: clamp(25px, 2.75vw, 40px); line-height: 1.06;
  letter-spacing: -.035em; font-weight: 720;
}
.split-left .eyebrow { margin-bottom: 13px; }
.split-left .eyebrow::before { width: 18px; }
.split-markdown {
  min-height: 0; overflow: auto; max-width: none;
  font-size: clamp(13px, 1.02vw, 15.5px); line-height: 1.58;
  padding-right: 8px; scrollbar-width: thin; scrollbar-color: var(--line) transparent;
}
.split-markdown::-webkit-scrollbar { width: 7px; }
.split-markdown::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
.split-markdown > :first-child { margin-top: 0; }
.split-markdown > :last-child { margin-bottom: 0; }
.split-markdown h2 { font-size: 1.25em; margin: .9em 0 .35em; }
.split-markdown h3 { font-size: 1.1em; margin: .9em 0 .3em; }
.split-markdown p { margin: .55em 0; }
.split-markdown ul, .split-markdown ol { margin: .55em 0; padding-left: 1.15em; }
.split-markdown li { margin: .25em 0; }
.split-markdown blockquote { padding: 10px 14px; margin: .8em 0; font-size: 1.02em; }
.split-markdown pre.code-block { padding: 12px 14px; margin: .8em 0; border-radius: 10px; }
.split-markdown pre.code-block code { font-size: .78em; }
.split-markdown .table-wrap { margin: .8em 0; }
.split-markdown th, .split-markdown td { padding: 7px 9px; }
.split-pager { margin-top: 12px; flex: 0 0 auto; }
.split-right { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: clamp(10px, 1.1vw, 16px); }
.split-right .diff-card { flex: 1 1 0; }
.align-center { text-align: center; align-items: center; }

.eyebrow {
  font-family: var(--mono); font-size: clamp(10px, .92vw, 12px);
  letter-spacing: .2em; text-transform: uppercase; color: var(--accent);
  margin: 0 0 16px; display: flex; align-items: center; gap: 10px;
}
.eyebrow::before { content: ""; width: 22px; height: 1px; background: var(--accent); opacity: .7; }
.slide-head h2 {
  margin: 0; font-size: clamp(30px, 4.3vw, 54px); line-height: 1.04;
  letter-spacing: -.035em; font-weight: 720; max-width: 1000px;
}
.slide-head .lede {
  margin: 18px 0 0; color: var(--muted); font-size: clamp(15px, 1.45vw, 19px);
  line-height: 1.55; max-width: 880px;
}
.slide-head { margin-bottom: clamp(18px, 2.6vh, 30px); flex: 0 0 auto; }
.slide-diff .slide-head { margin-bottom: clamp(12px, 1.8vh, 20px); }
.slide-diff .slide-head h2 { font-size: clamp(27px, 3.55vw, 44px); }
.slide-diff .slide-head .lede { font-size: clamp(13px, 1.12vw, 16px); line-height: 1.45; margin-top: 12px; max-width: 940px; }
.pager { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 12px; letter-spacing: .08em; }
.slide-diff .pager { margin-top: 8px; }
.slide-body { min-height: 0; flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.slide-body.markdown { display: block; }
.slide-body::-webkit-scrollbar { width: 8px; height: 8px; }
.slide-body::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }

.reveal { opacity: 0; transform: translateY(12px); }
.slide.active .reveal { opacity: 1; transform: none; transition: opacity .5s ease, transform .5s cubic-bezier(.2,.75,.25,1); }
.slide.active .reveal:nth-child(2) { transition-delay: .06s; }
.slide.active .reveal:nth-child(3) { transition-delay: .12s; }
.slide.active .reveal:nth-child(4) { transition-delay: .18s; }

.title-inner { position: relative; max-width: 1180px; padding: 20px 0 40px; }
.title-glow {
  position: absolute; width: 520px; height: 520px; left: -140px; top: -240px;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 68%);
  filter: blur(20px); pointer-events: none;
}
.title-eyebrow { margin-bottom: 26px; }
.title-inner h1 {
  position: relative; margin: 0; font-size: clamp(52px, 8.2vw, 118px);
  line-height: .94; letter-spacing: -.055em; font-weight: 800; max-width: 1080px;
  background: linear-gradient(112deg, var(--text) 24%, color-mix(in srgb, var(--accent) 78%, white) 64%, var(--accent2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.title-sub {
  margin: 30px 0 0; max-width: 760px; color: var(--muted);
  font-size: clamp(17px, 1.8vw, 24px); line-height: 1.48; letter-spacing: -.01em;
}
.title-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 38px; }
.chip {
  border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 68%, transparent);
  color: color-mix(in srgb, var(--text) 84%, var(--muted));
  border-radius: 999px; padding: 9px 14px; font-family: var(--mono); font-size: 12px;
}
.title-hint { margin-top: clamp(34px, 7vh, 74px); color: var(--muted); font-family: var(--mono); font-size: 11px; letter-spacing: .12em; opacity: .7; }

.markdown { font-size: clamp(15px, 1.3vw, 18px); line-height: 1.68; color: color-mix(in srgb, var(--text) 90%, var(--muted)); max-width: 1040px; }
.markdown > :first-child { margin-top: 0; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { color: var(--text); letter-spacing: -.02em; line-height: 1.15; margin: 1.15em 0 .45em; }
.markdown h1 { font-size: 1.9em; }
.markdown h2 { font-size: 1.55em; }
.markdown h3 { font-size: 1.24em; }
.markdown h4 { font-size: 1.05em; color: var(--accent); }
.markdown p { margin: .75em 0; }
.markdown strong { color: var(--text); font-weight: 680; }
.markdown em { color: color-mix(in srgb, var(--text) 82%, var(--accent)); }
.markdown a { text-decoration-thickness: 1px; }
.markdown ul, .markdown ol { margin: .7em 0; padding-left: 1.35em; }
.markdown li { margin: .34em 0; padding-left: .18em; }
.markdown li::marker { color: var(--accent); }
.markdown blockquote {
  margin: 1.05em 0; padding: 18px 22px; border-left: 2px solid var(--accent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent);
  border-radius: 0 12px 12px 0; font-size: 1.1em; color: var(--text);
}
.markdown blockquote p { margin: 0; }
.markdown hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; }
.markdown code {
  font-family: var(--mono); font-size: .86em; padding: .16em .38em;
  border: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  background: var(--panel2); border-radius: 6px; color: color-mix(in srgb, var(--accent) 68%, var(--text));
}
.markdown pre.code-block {
  margin: 1.1em 0; padding: 18px 20px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel2) 88%, black); border-radius: 14px;
  overflow: auto; line-height: 1.55; box-shadow: 0 20px 50px -30px black;
}
.markdown pre.code-block code { padding: 0; border: 0; background: transparent; color: var(--text); font-size: clamp(12px, 1.08vw, 15px); }
.table-wrap { margin: 1.1em 0; overflow: auto; border: 1px solid var(--line); border-radius: 14px; }
.markdown table { border-collapse: collapse; width: 100%; font-size: .92em; }
.markdown th, .markdown td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--line); }
.markdown th { background: var(--panel2); color: var(--muted); font-family: var(--mono); font-size: .8em; letter-spacing: .1em; text-transform: uppercase; }
.markdown tr:last-child td { border-bottom: 0; }
.markdown td:last-child { color: var(--accent); font-family: var(--mono); }

.diff-card {
  display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto;
  border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
  background: color-mix(in srgb, var(--panel2) 92%, black);
  box-shadow: 0 32px 80px -44px black, 0 0 0 1px color-mix(in srgb, white 3%, transparent) inset;
}
.diff-top {
  display: flex; align-items: center; gap: 16px; flex: 0 0 auto;
  padding: 11px 16px; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 80%, black);
}
.diff-path { font-family: var(--mono); font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-path-icon { color: var(--accent); margin-right: 8px; font-size: 9px; }
.diff-stats { margin-left: auto; display: flex; gap: 8px; flex: 0 0 auto; }
.stat { font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 6px; }
.stat-add { color: var(--add); background: color-mix(in srgb, var(--add) 12%, transparent); }
.stat-del { color: var(--del); background: color-mix(in srgb, var(--del) 12%, transparent); }
.diff-body { overflow: auto; font-family: var(--mono); font-size: var(--diff-fs, 17px); line-height: 1.5; padding: 9px 0; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.diff-body::-webkit-scrollbar { width: 8px; height: 8px; }
.diff-body::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
.diff-row { display: grid; grid-template-columns: 52px 52px 26px minmax(max-content, 1fr); min-height: 1.5em; white-space: pre; }
.diff-row code { font: inherit; padding: 0 18px 0 4px; color: color-mix(in srgb, var(--text) 88%, var(--muted)); }
.diff-no { text-align: right; padding-right: 8px; color: color-mix(in srgb, var(--muted) 62%, transparent); font-size: .8em; line-height: 1.88; user-select: none; }
.diff-sign { text-align: center; color: var(--muted); user-select: none; }
.diff-ctx { background: transparent; }
.diff-add { background: color-mix(in srgb, var(--add) 9%, transparent); box-shadow: inset 2px 0 var(--add); }
.diff-add .diff-sign { color: var(--add); }
.diff-add code { color: color-mix(in srgb, var(--add) 30%, var(--text)); }
.diff-del { background: color-mix(in srgb, var(--del) 9%, transparent); box-shadow: inset 2px 0 var(--del); }
.diff-del .diff-sign { color: var(--del); }
.diff-del code { color: color-mix(in srgb, var(--del) 28%, var(--text)); }
.diff-hunk {
  margin: 7px 0; background: color-mix(in srgb, var(--accent2) 9%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--accent2) 18%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent2) 18%, transparent);
}
.diff-hunk code { color: color-mix(in srgb, var(--accent2) 70%, var(--text)); font-style: italic; }
.diff-meta { opacity: .65; }
.diff-meta code { color: var(--muted); }

.bottom {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
  display: flex; align-items: center; gap: 20px;
  padding: 18px clamp(20px, 3.4vw, 48px) 20px;
}
.progress { flex: 1; height: 2px; background: color-mix(in srgb, var(--line) 70%, transparent); border-radius: 4px; overflow: hidden; }
.progress span { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .3s ease; }
.nav { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.counter { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 64px; text-align: right; letter-spacing: .08em; }
.nav-btn {
  width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 76%, transparent); color: var(--muted);
  cursor: pointer; display: grid; place-items: center; font-size: 16px;
  transition: color .18s, border-color .18s, background .18s, transform .18s;
}
.nav-btn:hover, .nav-btn:focus-visible { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--panel); outline: none; }
.nav-btn:active { transform: scale(.96); }

.overlay {
  position: fixed; inset: 0; z-index: 80; display: grid; place-items: center;
  padding: 28px; background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(14px);
}
.overlay[hidden] { display: none; }
.overlay-panel {
  width: min(900px, 100%); max-height: min(78vh, 760px); overflow: auto;
  border: 1px solid var(--line); border-radius: 20px; padding: 26px;
  background: color-mix(in srgb, var(--panel) 94%, black);
  box-shadow: 0 40px 120px -40px black;
}
.overlay-head { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; }
.overlay-head h3 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
.overlay-head span { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.overview-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.overview-item {
  width: 100%; display: grid; grid-template-columns: 46px 1fr auto; gap: 12px; align-items: center;
  text-align: left; border: 1px solid transparent; border-radius: 10px;
  padding: 11px 13px; background: transparent; color: var(--muted); cursor: pointer;
}
.overview-item:hover, .overview-item:focus-visible, .overview-item.current { background: var(--panel2); border-color: var(--line); color: var(--text); outline: none; }
.overview-item.current { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.overview-num { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.overview-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.overview-kind { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; opacity: .55; }
.key-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.key-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel2); color: var(--muted); font-size: 13px; }
kbd { font-family: var(--mono); font-size: 11px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 6px; padding: 3px 7px; color: var(--text); background: var(--panel); min-width: 26px; text-align: center; }

@media (max-width: 900px) {
  .split-inner { flex-direction: column; gap: 18px; }
  .split-left { flex: 0 0 auto; max-width: none; }
  .split-left h2 { font-size: clamp(24px, 6vw, 34px); margin-bottom: 12px; }
  .split-markdown { max-height: 28vh; }
  .split-right { min-height: 42vh; }
}
@media (max-width: 760px) {
  .slide { padding: 76px 20px 88px; }
  .slide-split { padding-top: 72px; padding-bottom: 84px; }
  .slide-head h2 { font-size: clamp(26px, 7vw, 38px); }
  .title-inner h1 { font-size: clamp(40px, 13vw, 72px); }
  .title-sub { font-size: 16px; }
  .diff-row { grid-template-columns: 34px 34px 20px minmax(max-content, 1fr); }
  .diff-no { font-size: .65em; }
  .deck-label { display: none; }
  .bottom { padding-bottom: 14px; }
}
@media (max-height: 650px) {
  .slide { padding-top: 62px; padding-bottom: 72px; }
  .slide-head { margin-bottom: 12px; }
  .slide-head .lede { margin-top: 10px; }
}
@media print {
  html, body { height: auto; overflow: visible; background: var(--bg); }
  body::before, .topbar, .bottom, .overlay { display: none !important; }
  .deck { height: auto; }
  .slide { position: relative; inset: auto; opacity: 1 !important; visibility: visible !important; transform: none !important; page-break-after: always; min-height: 100vh; padding: 48px; }
  .reveal { opacity: 1 !important; transform: none !important; }
  .diff-body, .slide-body { overflow: visible; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">git&nbsp;<b>slides</b></div>
  <div class="deck-label">${escapeHtml(title)}${subtitle ? ` &middot; ${escapeHtml(subtitle)}` : ""}</div>
  <div class="topbar-spacer"></div>
  <button type="button" class="icon-btn" data-action="overview" aria-label="Open slide overview">Overview <span aria-hidden="true">O</span></button>
  <button type="button" class="icon-btn" data-action="help" aria-label="Show keyboard shortcuts">?</button>
</header>

<main class="deck" id="deck">
${slideHtml}
</main>

<footer class="bottom">
  <div class="progress" aria-hidden="true"><span id="progress"></span></div>
  <div class="nav">
    <span class="counter" id="counter">1 / ${total}</span>
    <button type="button" class="nav-btn" data-action="prev" aria-label="Previous slide">←</button>
    <button type="button" class="nav-btn" data-action="next" aria-label="Next slide">→</button>
  </div>
</footer>

<div class="overlay" id="overview" hidden>
  <div class="overlay-panel" role="dialog" aria-modal="true" aria-labelledby="overview-title">
    <div class="overlay-head"><h3 id="overview-title">Slides</h3><span>${total} total</span></div>
    <ol class="overview-list">
${overviewItems}
    </ol>
  </div>
</div>

<div class="overlay" id="help" hidden>
  <div class="overlay-panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
    <div class="overlay-head"><h3 id="help-title">Keyboard</h3><span>Esc to close</span></div>
    <div class="key-grid">
      <div class="key-row"><kbd>→</kbd><kbd>Space</kbd><span>Next slide</span></div>
      <div class="key-row"><kbd>←</kbd><span>Previous slide</span></div>
      <div class="key-row"><kbd>Home</kbd><kbd>End</kbd><span>First / last slide</span></div>
      <div class="key-row"><kbd>O</kbd><span>Slide overview</span></div>
      <div class="key-row"><kbd>F</kbd><span>Fullscreen</span></div>
      <div class="key-row"><kbd>?</kbd><span>This panel</span></div>
    </div>
  </div>
</div>

<script>
(() => {
  "use strict";
  const slides = Array.from(document.querySelectorAll(".slide"));
  const total = slides.length;
  const counter = document.getElementById("counter");
  const progress = document.getElementById("progress");
  const overview = document.getElementById("overview");
  const help = document.getElementById("help");
  const overviewItems = Array.from(document.querySelectorAll("[data-goto]"));
  let index = 0;

  const hashIndex = Number.parseInt(location.hash.replace("#", ""), 10);
  if (Number.isInteger(hashIndex) && hashIndex >= 1 && hashIndex <= total) index = hashIndex - 1;

  function fitDiff(slide) {
    if (!slide) return;
    slide.querySelectorAll(".diff-body").forEach((body) => {
      body.style.fontSize = "";
      let size = Number.parseFloat(getComputedStyle(body).fontSize) || 17;
      let guard = 0;
      while (body.scrollHeight > body.clientHeight + 1 && size > 10 && guard < 40) {
        size -= 0.5;
        body.style.fontSize = size + "px";
        guard += 1;
      }
    });
  }

  function render() {
    slides.forEach((slide, i) => {
      const isCurrent = i === index;
      slide.classList.toggle("active", isCurrent);
      slide.classList.toggle("prev", i < index);
      slide.setAttribute("aria-hidden", isCurrent ? "false" : "true");
      if (isCurrent) slide.removeAttribute("inert");
      else slide.setAttribute("inert", "");
    });
    counter.textContent = (index + 1) + " / " + total;
    progress.style.width = ((index + 1) / total) * 100 + "%";
    overviewItems.forEach((item) => {
      item.classList.toggle("current", Number(item.dataset.goto) === index);
    });
    history.replaceState(null, "", "#" + (index + 1));
    requestAnimationFrame(() => fitDiff(slides[index]));
  }

  function go(next) {
    index = Math.max(0, Math.min(total - 1, next));
    render();
  }

  function toggleOverlay(element) {
    const willOpen = element.hidden;
    [overview, help].forEach((overlay) => { overlay.hidden = true; });
    element.hidden = !willOpen;
    if (willOpen) {
      const current = element.querySelector(".current, button");
      if (current) current.focus({ preventScroll: true });
    }
  }

  function closeOverlays() {
    overview.hidden = true;
    help.hidden = true;
  }

  document.addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto]");
    if (goto) {
      go(Number(goto.dataset.goto));
      closeOverlays();
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "next") go(index + 1);
    else if (action === "prev") go(index - 1);
    else if (action === "overview") toggleOverlay(overview);
    else if (action === "help") toggleOverlay(help);
    else if (!overview.hidden || !help.hidden) {
      if (event.target.classList.contains("overlay")) closeOverlays();
      return;
    } else if (event.target.closest(".slide") && !event.target.closest("a, button, pre, code, .diff-body")) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) go(index + 1);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === "Escape") { closeOverlays(); return; }
    if (!overview.hidden || !help.hidden) {
      if (key === "o" || key === "O") { closeOverlays(); return; }
      if (key === "?" || key === "/") { closeOverlays(); return; }
    }
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) {
      event.preventDefault(); go(index + 1);
    } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(key)) {
      event.preventDefault(); go(index - 1);
    } else if (key === "Home") {
      event.preventDefault(); go(0);
    } else if (key === "End") {
      event.preventDefault(); go(total - 1);
    } else if (key === "o" || key === "O") {
      event.preventDefault(); toggleOverlay(overview);
    } else if (key === "?" || key === "/") {
      event.preventDefault(); toggleOverlay(help);
    } else if (key === "f" || key === "F") {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    }
  });

  let touchX = null;
  let touchY = null;
  document.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    touchX = touch.clientX; touchY = touch.clientY;
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    if (touchX == null) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchX;
    const dy = touch.clientY - touchY;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) go(index + (dx < 0 ? 1 : -1));
    touchX = touchY = null;
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => fitDiff(slides[index]), 120);
  });

  render();
})();
</script>
</body>
</html>
`;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(HELP.trim());
    process.exit(args.length ? 0 : 1);
  }

  let inputPath = args[0];
  let outputPath = null;

  const outFlag = args.findIndex((arg) => arg === "--out" || arg === "-o");
  if (outFlag !== -1) {
    outputPath = args[outFlag + 1];
    if (!outputPath) {
      console.error("error: --out requires a file path");
      process.exit(1);
    }
    if (outFlag === 0) inputPath = args[outFlag + 2];
  }

  if (!inputPath) {
    console.error("error: missing input JSON path\n");
    console.log(HELP.trim());
    process.exit(1);
  }

  const absoluteInput = resolve(process.cwd(), inputPath);
  const deck = normalizeDeck(JSON.parse(readFileSync(absoluteInput, "utf8")));
  const slides = buildSlides(deck);
  const html = renderHtml(deck, slides);

  const fallbackName = `${basename(absoluteInput, extname(absoluteInput))}.html`;
  const absoluteOutput = resolve(
    process.cwd(),
    outputPath ?? resolve(dirname(absoluteInput), fallbackName),
  );

  writeFileSync(absoluteOutput, html, "utf8");
  const size = Buffer.byteLength(html, "utf8");
  console.log(`wrote ${absoluteOutput} (${slides.length} slides, ${(size / 1024).toFixed(1)} kB)`);
}

main();
