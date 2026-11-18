import { describe, expect, test } from "bun:test";

import { parseInline, parseMarkdown } from "./parse";

describe("parseInline", () => {
  test("parses emphasis, strong, strikethrough and code", () => {
    expect(parseInline("a **b** *c* ~~d~~ `e*f`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "code", text: "e*f" },
    ]);
  });

  test("nests strong and emphasis", () => {
    expect(parseInline("***x***")).toEqual([
      { type: "strong", children: [{ type: "em", children: [{ type: "text", text: "x" }] }] },
    ]);
    expect(parseInline("*a **b** c*")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }] },
          { type: "text", text: " c" },
        ],
      },
    ]);
  });

  test("leaves snake_case identifiers and lone stars alone", () => {
    expect(parseInline("my_var_name and 2 * 3 * 4")).toEqual([{ type: "text", text: "my_var_name and 2 * 3 * 4" }]);
  });

  test("handles backslash escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ type: "text", text: "*not em*" }]);
  });

  test("allows only http(s) and mailto links", () => {
    expect(parseInline("[docs](https://example.com/a_(b))")).toEqual([
      { type: "link", href: "https://example.com/a_(b)", children: [{ type: "text", text: "docs" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "[x](javascript:alert(1))" }]);
  });

  test("renders images as plain links so remote images are never loaded", () => {
    expect(parseInline("![logo](https://example.com/l.png)")).toEqual([
      { type: "link", href: "https://example.com/l.png", children: [{ type: "text", text: "logo" }] },
    ]);
  });

  test("autolinks bare URLs without trailing punctuation", () => {
    expect(parseInline("see https://example.com/x. (or https://a.dev/b)")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://example.com/x", children: [{ type: "text", text: "https://example.com/x" }] },
      { type: "text", text: ". (or " },
      { type: "link", href: "https://a.dev/b", children: [{ type: "text", text: "https://a.dev/b" }] },
      { type: "text", text: ")" },
    ]);
  });

  test("keeps raw HTML as text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { type: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  test("turns two trailing spaces into a line break", () => {
    expect(parseInline("a  \nb\nc")).toEqual([
      { type: "text", text: "a" },
      { type: "br" },
      { type: "text", text: "b\nc" },
    ]);
  });
});

describe("parseMarkdown", () => {
  test("parses headings, paragraphs, rules and quotes", () => {
    expect(parseMarkdown("# Title\n\nline one\nline two\n\n---\n\n> quoted")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
      { type: "paragraph", children: [{ type: "text", text: "line one\nline two" }] },
      { type: "hr" },
      { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "quoted" }] }] },
    ]);
  });

  test("keeps fenced code verbatim, including markdown-like content", () => {
    expect(parseMarkdown("```ts\nconst a = **b**;\n\n# not a heading\n```\nafter")).toEqual([
      { type: "code", lang: "ts", text: "const a = **b**;\n\n# not a heading" },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
    ]);
  });

  test("parses nested lists, ordered starts and task items", () => {
    const blocks = parseMarkdown("3. first\n   - [x] done\n   - [ ] todo\n4. second");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          {
            checked: null,
            children: [
              { type: "paragraph", children: [{ type: "text", text: "first" }] },
              {
                type: "list",
                ordered: false,
                start: 1,
                items: [
                  { checked: true, children: [{ type: "paragraph", children: [{ type: "text", text: "done" }] }] },
                  { checked: false, children: [{ type: "paragraph", children: [{ type: "text", text: "todo" }] }] },
                ],
              },
            ],
          },
          { checked: null, children: [{ type: "paragraph", children: [{ type: "text", text: "second" }] }] },
        ],
      },
    ]);
  });

  test("lets a list interrupt a paragraph and keeps loose list items together", () => {
    const blocks = parseMarkdown("Steps:\n- a\n\n- b\n\nDone");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
    expect(blocks[1].type === "list" && blocks[1].items.length).toBe(2);
  });

  test("parses tables with alignment and escaped pipes", () => {
    expect(parseMarkdown("| a | b |\n|:--|--:|\n| 1 | x \\| y |\n| 2 |")).toEqual([
      {
        type: "table",
        align: ["left", "right"],
        header: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
        rows: [
          [[{ type: "text", text: "1" }], [{ type: "text", text: "x | y" }]],
          [[{ type: "text", text: "2" }], []],
        ],
      },
    ]);
  });

  test("treats an unclosed fence as code until the end", () => {
    expect(parseMarkdown("```\nstill streaming")).toEqual([{ type: "code", lang: "", text: "still streaming" }]);
  });
});
