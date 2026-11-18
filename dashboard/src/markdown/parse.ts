/**
 * Small Markdown parser for agent messages (the GitHub-flavored subset agents
 * actually emit). It produces a plain AST that the Markdown component turns
 * into React elements, so no HTML string is ever injected into the page:
 * raw HTML in a message is shown as text, and links only allow http(s)/mailto.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;
const BARE_URL_RE = /^https?:\/\/[^\s<]+/;
const AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;
const TRAILING_URL_PUNCTUATION_RE = /[.,:;!?"'*_~]+$/;
const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>\"'";

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

// --- Blocks ---

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], marker)) body.push(lines[i++]);
      i++; // skip the closing fence (or run past the end of an unclosed one)
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(lines[i++].replace(QUOTE_RE, ""));
      blocks.push({ type: "quote", children: parseBlocks(body) });
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      i = parseList(lines, i, blocks);
      continue;
    }

    if (i + 1 < lines.length && line.includes("|") && TABLE_DELIMITER_RE.test(lines[i + 1])) {
      i = parseTable(lines, i, blocks);
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines, i))) body.push(lines[i++]);
    blocks.push({ type: "paragraph", children: parseInline(body.map((l) => l.trimStart()).join("\n")) });
  }
  return blocks;
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length);
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    (i + 1 < lines.length && line.includes("|") && TABLE_DELIMITER_RE.test(lines[i + 1]))
  );
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker[0]);
}

/** Parse a list starting at lines[start]; returns the index after it. */
function parseList(lines: string[], start: number, blocks: Block[]): number {
  const first = LIST_RE.exec(lines[start]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = isOrderedMarker(first[2]);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_RE.exec(lines[i]);
    if (!match || match[1].length !== indent || isOrderedMarker(match[2]) !== ordered) break;

    const contentIndent = indent + match[2].length + 1;
    const body: string[] = [match[3] ?? ""];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        // A blank line continues the item only if indented content follows.
        const following = lines.slice(i + 1).find((l) => l.trim());
        if (following === undefined || leadingSpaces(following) < contentIndent) break;
        body.push("");
        i++;
        continue;
      }
      if (leadingSpaces(next) >= contentIndent) {
        body.push(next.slice(contentIndent));
      } else if (!LIST_RE.test(next) && !startsBlock(lines, i) && body[body.length - 1] !== "") {
        body.push(next.trimStart()); // lazy paragraph continuation
      } else {
        break;
      }
      i++;
    }

    const task = TASK_RE.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    items.push({ checked: task ? task[1] !== " " : null, children: parseBlocks(body) });

    // Blank lines between sibling items are allowed.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const sibling = j < lines.length ? LIST_RE.exec(lines[j]) : null;
    if (j > i && sibling && sibling[1].length === indent && isOrderedMarker(sibling[2]) === ordered) i = j;
  }

  blocks.push({ type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items });
  return i;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/** Parse a GFM table starting at lines[start]; returns the index after it. */
function parseTable(lines: string[], start: number, blocks: Block[]): number {
  const header = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell): Align => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    rows.push(header.map((_, c) => parseInline(cells[c] ?? "")));
    i++;
  }
  blocks.push({
    type: "table",
    align: header.map((_, c) => align[c] ?? null),
    header: header.map((cell) => parseInline(cell)),
    rows,
  });
  return i;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

// --- Inlines ---

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  const push = (node: Inline): void => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "\n") {
        push({ type: "br" });
        i += 2;
        continue;
      }
      if (ESCAPABLE.includes(next)) {
        buffer += next;
        i += 2;
        continue;
      }
    }

    if (ch === "\n") {
      if (buffer.endsWith("  ")) {
        buffer = buffer.trimEnd();
        push({ type: "br" });
      } else {
        buffer = buffer.trimEnd();
        buffer += "\n";
      }
      i++;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const close = findCodeClose(text, i + run.length, run.length);
      if (close !== -1) {
        let code = text.slice(i + run.length, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        push({ type: "code", text: code });
        i = close + run.length;
      } else {
        buffer += run;
        i += run.length;
      }
      continue;
    }

    if (ch === "[" || (ch === "!" && text[i + 1] === "[")) {
      const link = parseLink(text, ch === "!" ? i + 1 : i);
      if (link) {
        // Images render as links: loading remote images from agent output could leak data.
        push(link.node);
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const auto = AUTOLINK_RE.exec(rest);
      if (auto) {
        push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }

    if (ch === "h" && !/\w/.test(text[i - 1] ?? "")) {
      const bare = BARE_URL_RE.exec(rest);
      if (bare) {
        const url = trimBareUrl(bare[0]);
        push({ type: "link", href: url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const emphasis = parseEmphasis(text, i);
      if (emphasis) {
        push(emphasis.node);
        i = emphasis.end;
        continue;
      }
      const run = new RegExp(`^\\${ch}+`).exec(rest)?.[0] ?? ch;
      buffer += run;
      i += run.length;
      continue;
    }

    buffer += ch;
    i++;
  }
  flush();
  return out;
}

function findCodeClose(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    const close = text.indexOf("`", i);
    if (close === -1) return -1;
    const run = /^`+/.exec(text.slice(close))?.[0] ?? "";
    if (run.length === length) return close;
    i = close + run.length;
  }
  return -1;
}

function parseLink(text: string, open: number): { node: Inline; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null;

  let parens = 0;
  let end = -1;
  for (let i = close + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "(") parens++;
    else if (ch === ")" && parens-- === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const target = text.slice(close + 2, end).trim();
  const href = (/^<([^>]*)>/.exec(target)?.[1] ?? target.split(/\s+/)[0] ?? "").trim();
  // Anything but http(s)/mailto (javascript:, data:, relative paths) stays literal text.
  if (!SAFE_URL_RE.test(href)) return null;
  return { node: { type: "link", href, children: parseInline(text.slice(open + 1, close)) }, end: end + 1 };
}

function trimBareUrl(url: string): string {
  let trimmed = url.replace(TRAILING_URL_PUNCTUATION_RE, "");
  // Drop a trailing ")" that closes surrounding prose rather than the URL.
  while (trimmed.endsWith(")") && count(trimmed, "(") < count(trimmed, ")")) {
    trimmed = trimmed.slice(0, -1).replace(TRAILING_URL_PUNCTUATION_RE, "");
  }
  return trimmed;
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

function parseEmphasis(text: string, i: number): { node: Inline; end: number } | null {
  const ch = text[i];
  const run = new RegExp(`^\\${ch}+`).exec(text.slice(i))?.[0].length ?? 0;
  if (ch === "~") {
    if (run !== 2) return null;
    return wrapDelimited(text, i, "~~", "del");
  }
  if (ch === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "")) return null; // snake_case
  if (run >= 2) {
    const strong = wrapDelimited(text, i, ch.repeat(2), "strong");
    if (strong) return strong;
  }
  return wrapDelimited(text, i, ch, "em");
}

/** Find the closing delimiter for an opener at `i` and wrap the inner text. */
function wrapDelimited(
  text: string,
  i: number,
  delimiter: string,
  type: "strong" | "em" | "del",
): { node: Inline; end: number } | null {
  const start = i + delimiter.length;
  if (start >= text.length || /\s/.test(text[start])) return null;
  const ch = delimiter[0];

  for (let j = start + 1; j <= text.length - delimiter.length; j++) {
    if (text[j] === "`") {
      const run = /^`+/.exec(text.slice(j))?.[0].length ?? 1;
      const close = findCodeClose(text, j + run, run);
      if (close !== -1) j = close + run - 1;
      continue;
    }
    if (!text.startsWith(delimiter, j) || /\s/.test(text[j - 1])) continue;
    const after = text[j + delimiter.length] ?? "";
    // Prefer the last delimiter of a run, so "***x***" pairs up as strong(em(x)).
    if (after === ch) continue;
    // A single "*" inside a doubled run belongs to a nested strong, not this em.
    if (delimiter.length === 1 && text[j - 1] === ch && j - 1 >= start) continue;
    if (ch === "_" && /[\p{L}\p{N}]/u.test(after)) continue;
    return { node: { type, children: parseInline(text.slice(start, j)) }, end: j + delimiter.length };
  }
  return null;
}
