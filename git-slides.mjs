#!/usr/bin/env node
/**
 * Git Slides — turn a small JSON deck definition into one self-contained HTML file.
 *
 * Reads template.html and theme.css from this script's directory, inlines them,
 * and writes a single portable HTML file with no external assets.
 *
 *   node git-slides.mjs deck.json
 *   node git-slides.mjs deck.json --out pr-495.html
 *
 * No dependencies, no network requests, no build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `
Git Slides — JSON to a single-file HTML slideshow

Usage:
  node git-slides.mjs <deck.json> [--out <file.html>]

Requires template.html and theme.css next to this script. They are inlined into
the generated HTML, so the output remains a single self-contained file.
See schema.json for the deck format.

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

function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return String(values[key]);
  });
}

function readAsset(name) {
  try {
    return readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  } catch (error) {
    throw new Error(
      `missing ${name}; expected it next to ${basename(fileURLToPath(import.meta.url))} (${error.message})`,
    );
  }
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
    .map((slide, index) => renderSlide(slide, index, total, context, slide.__pager))
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

  const css = fillTemplate(readAsset("theme.css"), { CSS_VARS: cssVars }).replace(/\n+$/, "");
  return fillTemplate(readAsset("template.html"), {
    TITLE: escapeHtml(title),
    DECK_LABEL: `${escapeHtml(title)}${subtitle ? ` &middot; ${escapeHtml(subtitle)}` : ""}`,
    TOTAL: String(total),
    SLIDES: slideHtml,
    OVERVIEW_ITEMS: overviewItems,
    CSS: css,
  });
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
