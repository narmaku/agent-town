import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionModeSelect } from "./PermissionModeSelect";

describe("permission mode radio choices", () => {
  test("uses a native group with separate per-mode explanations and disabled choices", () => {
    const html = renderToStaticMarkup(
      <PermissionModeSelect id="test-mode" agentType="opencode" value="yolo" onChange={() => {}} />,
    );
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).not.toContain("<select");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('aria-label="About Auto mode for OpenCode"');
    expect(html.match(/role="tooltip"/g)).toHaveLength(3);
    expect(html).toContain("no equivalent automatic safety-review");
    expect(html).toContain("OPENCODE_PERMISSION");
    expect(html).toMatch(/type="radio"[^>]*disabled=""[^>]*value="auto"/);
    expect(html).not.toContain("aria-expanded");
  });

  test("Pi retains accessible information for both disabled modes", () => {
    const html = renderToStaticMarkup(
      <PermissionModeSelect id="pi-mode" agentType="pi" value="auto" onChange={() => {}} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("without per-tool approvals or a built-in sandbox");
    expect(html).toContain('aria-label="About YOLO mode for Pi"');
  });

  test("separate selector instances never share radio group names or tooltip IDs", () => {
    const html = renderToStaticMarkup(
      <>
        <PermissionModeSelect id="same-mode" agentType="codex" value="auto" onChange={() => {}} />
        <PermissionModeSelect id="same-mode" agentType="codex" value="yolo" onChange={() => {}} />
      </>,
    );
    const names = [...html.matchAll(/ name="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(2);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
