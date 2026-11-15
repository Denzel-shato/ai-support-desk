import { toIsoOrNull } from "./ticket-serialization";
import type { KnowledgeArticle } from "./types";

/**
 * Pure helpers for the Knowledge Base page: document normalisation, search
 * and a small Markdown parser. No React, no Firebase, no HTML strings (the
 * parser returns plain data, so article text can never inject markup).
 */

export const KNOWLEDGE_COLLECTION = "knowledge_base";

/* -------------------------------------------------------------------------- */
/*  Document -> article                                                       */
/* -------------------------------------------------------------------------- */

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function toActive(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/** An array of strings, or a comma-separated string; anything else is empty. */
function toKeywords(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Builds the API shape from a raw document. Tolerates missing or odd fields. */
export function toKnowledgeArticle(
  id: string,
  data: Record<string, unknown>,
): KnowledgeArticle {
  return {
    id,
    title: text(data.title),
    category: text(data.category),
    active: toActive(data.active),
    keywords: toKeywords(data.keywords),
    content: typeof data.content === "string" ? data.content : "",
    updatedAt: toIsoOrNull(data.updatedAt),
  };
}

/** Title for display: the stored title, else the document ID. */
export function articleTitle(a: KnowledgeArticle): string {
  return a.title ?? a.id;
}

/** Active articles first, then by title. */
export function compareArticles(a: KnowledgeArticle, b: KnowledgeArticle): number {
  const rank = (x: KnowledgeArticle) => (x.active === true ? 0 : x.active === null ? 1 : 2);
  return rank(a) - rank(b) || articleTitle(a).localeCompare(articleTitle(b));
}

/* -------------------------------------------------------------------------- */
/*  Search                                                                    */
/* -------------------------------------------------------------------------- */

/** Lower-cased search terms; every term must match (AND). */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function haystack(a: KnowledgeArticle): string {
  return [a.title, a.category, a.id, a.keywords.join(" "), a.content]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export interface SearchHit {
  article: KnowledgeArticle;
  /** A short passage from the content around the first match, if the match is there. */
  snippet: string | null;
}

/** Excerpt of `content` around the first term that appears in it. */
export function makeSnippet(content: string, terms: string[], radius = 60): string | null {
  const lower = content.toLowerCase();
  let at = -1;
  let len = 0;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = term.length;
    }
  }
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(content.length, at + len + radius);
  const body = content.slice(start, end).replace(/[#*`]+/g, "").replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < content.length ? "…" : ""}`;
}

export function searchArticles(articles: KnowledgeArticle[], query: string): SearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return articles.map((article) => ({ article, snippet: null }));
  return articles
    .filter((a) => {
      const h = haystack(a);
      return terms.every((t) => h.includes(t));
    })
    .map((article) => ({ article, snippet: makeSnippet(article.content, terms) }));
}

/* -------------------------------------------------------------------------- */
/*  Markdown                                                                  */
/* -------------------------------------------------------------------------- */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "code"; value: string };

export interface ListItemNode {
  inline: InlineNode[];
  children: ListNode | null;
}
export interface ListNode {
  type: "list";
  ordered: boolean;
  /** Starting number of an ordered list (as written in the source). */
  start: number;
  items: ListItemNode[];
}
export type BlockNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineNode[] }
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "rule" }
  | ListNode;

/** **bold**, __bold__, *italic*, _italic_ (word-bounded) and `code`. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*?\*)|((?<![A-Za-z0-9])_[^_\s][^_\n]*?_(?![A-Za-z0-9]))/g;

export function parseInline(source: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;
  for (const m of source.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", value: source.slice(last, i) });
    const raw = m[0];
    if (m[1]) out.push({ type: "code", value: raw.slice(1, -1) });
    else if (m[2] || m[3]) out.push({ type: "bold", value: raw.slice(2, -2) });
    else out.push({ type: "italic", value: raw.slice(1, -1) });
    last = i + raw.length;
  }
  if (last < source.length) out.push({ type: "text", value: source.slice(last) });
  return out;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/;

function indentOf(spaces: string): number {
  return spaces.replace(/\t/g, "    ").length;
}

/**
 * Parses the Markdown subset the knowledge base uses: headings, paragraphs,
 * nested ordered and unordered lists, horizontal rules, bold, italic and code.
 * Unrecognised text is kept as plain paragraphs, never dropped.
 */
export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let para: string[] = [];
  /** Open list levels, innermost last. */
  let stack: { indent: number; list: ListNode }[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
      para = [];
    }
  };
  const closeLists = () => {
    stack = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      // A blank line doesn't end a list: numbered steps are often spaced out.
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseInline(heading[2]),
      });
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      closeLists();
      blocks.push({ type: "rule" });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const indent = indentOf(item[1]);
      const ordered = /\d/.test(item[2]);
      const node: ListItemNode = { inline: parseInline(item[3]), children: null };

      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (top && indent === top.indent && top.list.ordered === ordered) {
        top.list.items.push(node);
      } else if (top && indent > top.indent) {
        const parent = top.list.items[top.list.items.length - 1];
        const child: ListNode = {
          type: "list",
          ordered,
          start: ordered ? parseInt(item[2], 10) : 1,
          items: [node],
        };
        parent.children = child;
        stack.push({ indent, list: child });
      } else {
        if (top && indent === top.indent) stack.pop(); // same level, different kind
        const list: ListNode = {
          type: "list",
          ordered,
          start: ordered ? parseInt(item[2], 10) : 1,
          items: [node],
        };
        if (stack.length === 0) blocks.push(list);
        else {
          const parentList = stack[stack.length - 1].list;
          parentList.items[parentList.items.length - 1].children = list;
        }
        stack.push({ indent, list });
      }
      continue;
    }

    // Plain text. A line indented under a list item continues that item.
    if (stack.length && /^\s+\S/.test(line) && para.length === 0) {
      const list = stack[stack.length - 1].list;
      const last = list.items[list.items.length - 1];
      last.inline = [...last.inline, { type: "text", value: ` ${line.trim()}` }, ];
      continue;
    }
    closeLists();
    para.push(line.trimEnd());
  }
  flushPara();
  return blocks;
}
