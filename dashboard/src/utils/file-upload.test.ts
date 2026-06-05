import { describe, expect, test } from "bun:test";
import { formatFileRef, getFileRefPrefix } from "./file-upload";

describe("getFileRefPrefix", () => {
  test("returns 'image' for image MIME types", () => {
    expect(getFileRefPrefix("image/png")).toBe("image");
    expect(getFileRefPrefix("image/jpeg")).toBe("image");
    expect(getFileRefPrefix("image/gif")).toBe("image");
    expect(getFileRefPrefix("image/webp")).toBe("image");
    expect(getFileRefPrefix("image/svg+xml")).toBe("image");
  });

  test("returns 'file' for non-image types", () => {
    expect(getFileRefPrefix("application/pdf")).toBe("file");
    expect(getFileRefPrefix("text/plain")).toBe("file");
    expect(getFileRefPrefix("application/json")).toBe("file");
    expect(getFileRefPrefix("video/mp4")).toBe("file");
  });

  test("returns 'file' for empty type", () => {
    expect(getFileRefPrefix("")).toBe("file");
  });
});

describe("formatFileRef", () => {
  test("formats image reference", () => {
    expect(formatFileRef("image", "/tmp/agent-town-uploads/abc-photo.png")).toBe(
      "[image: /tmp/agent-town-uploads/abc-photo.png]",
    );
  });

  test("formats file reference", () => {
    expect(formatFileRef("file", "/tmp/agent-town-uploads/abc-doc.pdf")).toBe(
      "[file: /tmp/agent-town-uploads/abc-doc.pdf]",
    );
  });
});
