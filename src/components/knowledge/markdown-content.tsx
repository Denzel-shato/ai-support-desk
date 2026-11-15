import { Fragment, type ReactNode } from "react";
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
  type ListNode,
} from "@/lib/knowledge-base";

/**
 * Renders parsed Markdown as React elements (no HTML strings, so article text
 * can't inject markup). Search terms are highlighted in the text.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(value: string, terms: string[]): ReactNode {
  if (terms.length === 0) return value;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const lower = new Set(terms);
  return value.split(pattern).map((part, i) =>
    lower.has(part.toLowerCase()) ? (
      <mark key={i} className="rounded-sm bg-[#FBE7A6] px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function Inline({ nodes, terms }: { nodes: InlineNode[]; terms: string[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        const content = highlight(n.value, terms);
        switch (n.type) {
          case "bold":
            return <strong key={i} className="font-semibold text-foreground">{content}</strong>;
          case "italic":
            return <em key={i}>{content}</em>;
          case "code":
            return (
              <code key={i} className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[12px]">
                {content}
              </code>
            );
          default:
            return <Fragment key={i}>{content}</Fragment>;
        }
      })}
    </>
  );
}

function List({ list, terms }: { list: ListNode; terms: string[] }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag
      start={list.ordered && list.start !== 1 ? list.start : undefined}
      className={`space-y-1.5 pl-5 marker:text-subtle-foreground ${
        list.ordered ? "list-decimal" : "list-disc"
      }`}
    >
      {list.items.map((item, i) => (
        <li key={i} className="pl-1 leading-relaxed">
          <Inline nodes={item.inline} terms={terms} />
          {item.children && (
            <div className="mt-1.5">
              <List list={item.children} terms={terms} />
            </div>
          )}
        </li>
      ))}
    </Tag>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-semibold tracking-tight",
  2: "text-base font-semibold tracking-tight border-b border-border pb-1.5",
  3: "text-[14px] font-semibold",
  4: "text-[13px] font-semibold",
  5: "text-[13px] font-semibold text-muted-foreground",
  6: "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
};

function Block({ block, terms }: { block: BlockNode; terms: string[] }) {
  switch (block.type) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className={`mt-6 first:mt-0 ${HEADING_CLASS[block.level]}`}>
          <Inline nodes={block.inline} terms={terms} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="whitespace-pre-line leading-relaxed">
          <Inline nodes={block.inline} terms={terms} />
        </p>
      );
    case "rule":
      return <hr className="border-border" />;
    case "list":
      return <List list={block} terms={terms} />;
  }
}

export function MarkdownContent({
  source,
  terms = [],
  title,
}: {
  source: string;
  terms?: string[];
  /** If the text opens with a level-1 heading equal to this, it isn't repeated. */
  title?: string;
}) {
  let blocks = parseMarkdown(source);
  const first = blocks[0];
  if (
    title &&
    first?.type === "heading" &&
    first.level === 1 &&
    first.inline.map((n) => n.value).join("").trim().toLowerCase() === title.trim().toLowerCase()
  ) {
    blocks = blocks.slice(1);
  }
  if (blocks.length === 0) {
    return <p className="text-[13px] text-subtle-foreground">This article has no content.</p>;
  }
  return (
    <div className="space-y-3 text-[13px] text-foreground">
      {blocks.map((b, i) => (
        <Block key={i} block={b} terms={terms} />
      ))}
    </div>
  );
}
