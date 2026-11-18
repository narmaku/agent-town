import type React from "react";
import { Fragment, useMemo } from "react";

import { type Align, type Block, type Inline, type ListItem, parseMarkdown } from "../markdown/parse";

interface Props {
  text: string;
}

/** Render agent Markdown as React elements (never as injected HTML). */
export function Markdown({ text }: Props): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <>{renderBlocks(blocks, false)}</>;
}

/** Rendered Markdown is static, so an element's position is its identity. */
function keyed(nodes: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let position = 0; position < nodes.length; position++) {
    out.push(<Fragment key={position}>{nodes[position]}</Fragment>);
  }
  return out;
}

function renderBlocks(blocks: Block[], tight: boolean): React.ReactNode[] {
  return keyed(blocks.map((block) => renderBlock(block, tight)));
}

function renderInlines(nodes: Inline[]): React.ReactNode[] {
  return keyed(nodes.map(renderInline));
}

function renderBlock(block: Block, tight: boolean): React.ReactNode {
  switch (block.type) {
    case "paragraph":
      // Tight list items render their text directly, like GitHub does.
      return tight ? <span>{renderInlines(block.children)}</span> : <p>{renderInlines(block.children)}</p>;
    case "heading":
      return renderHeading(block.level, renderInlines(block.children));
    case "code":
      return (
        <pre className="code-block">
          <code className={block.lang ? `language-${block.lang}` : undefined}>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote>{renderBlocks(block.children, false)}</blockquote>;
    case "hr":
      return <hr />;
    case "list": {
      const items = keyed(block.items.map(renderListItem));
      return block.ordered ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <table>
          <thead>
            <tr>{keyed(block.header.map((cell, c) => renderCell("th", block.align[c], cell)))}</tr>
          </thead>
          <tbody>{keyed(block.rows.map((row) => renderRow(row, block.align)))}</tbody>
        </table>
      );
  }
}

function renderListItem(item: ListItem): React.ReactNode {
  const tight = item.children.filter((child) => child.type === "paragraph").length <= 1;
  return (
    <li className={item.checked === null ? undefined : "task-list-item"}>
      {item.checked !== null && (
        <input type="checkbox" checked={item.checked} disabled readOnly aria-label="Task status" />
      )}
      {renderBlocks(item.children, tight)}
    </li>
  );
}

function renderRow(row: Inline[][], align: Align[]): React.ReactNode {
  return <tr>{keyed(row.map((cell, c) => renderCell("td", align[c], cell)))}</tr>;
}

function renderCell(tag: "th" | "td", align: Align, cell: Inline[]): React.ReactNode {
  const style = align ? { textAlign: align } : undefined;
  return tag === "th" ? <th style={style}>{renderInlines(cell)}</th> : <td style={style}>{renderInlines(cell)}</td>;
}

function renderHeading(level: number, children: React.ReactNode): React.ReactNode {
  switch (level) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    default:
      return <h6>{children}</h6>;
  }
}

function renderInline(node: Inline): React.ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return <code className="inline-code">{node.text}</code>;
    case "strong":
      return <strong>{renderInlines(node.children)}</strong>;
    case "em":
      return <em>{renderInlines(node.children)}</em>;
    case "del":
      return <del>{renderInlines(node.children)}</del>;
    case "link":
      return (
        <a href={node.href} target="_blank" rel="noopener noreferrer">
          {renderInlines(node.children)}
        </a>
      );
    case "br":
      return <br />;
  }
}
