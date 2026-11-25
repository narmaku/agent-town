import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionModeSelect } from "./PermissionModeSelect";

describe("permission mode selector", () => {
  test("shows all modes with harness-specific disabled reasons and accessible help", () => {
    const html = renderToStaticMarkup(
      <PermissionModeSelect id="test-mode" agentType="opencode" value="default" onChange={() => {}} />,
    );
    expect(html).toContain('for="test-mode"');
    expect(html).toContain('value="default"');
    expect(html).toContain('value="auto" disabled=""');
    expect(html).toContain('value="yolo"');
    expect(html).toContain("<summary");
    expect(html).toContain("Permission mode information for OpenCode");
    expect(html).toContain("no equivalent automatic safety-review");
    expect(html).toContain("OPENCODE_PERMISSION");
  });

  test("Pi explains its existing unrestricted tools and cannot select Auto or YOLO", () => {
    const html = renderToStaticMarkup(
      <PermissionModeSelect id="pi-mode" agentType="pi" value="default" onChange={() => {}} />,
    );
    expect(html).toContain('value="auto" disabled=""');
    expect(html).toContain('value="yolo" disabled=""');
    expect(html).toContain("without per-tool approvals or a built-in sandbox");
  });
});
