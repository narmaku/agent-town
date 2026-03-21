import { describe, expect, test } from "bun:test";
import { parseNumstat, parseUnifiedDiff, validateDiffDir } from "./git-diff";

describe("validateDiffDir", () => {
  test("accepts valid absolute paths", () => {
    expect(validateDiffDir("/home/user/project")).toBeNull();
    expect(validateDiffDir("/tmp/test")).toBeNull();
    expect(validateDiffDir("/")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateDiffDir("")).not.toBeNull();
  });

  test("rejects relative paths", () => {
    expect(validateDiffDir("relative/path")).not.toBeNull();
    expect(validateDiffDir("./local")).not.toBeNull();
  });

  test("rejects paths with directory traversal", () => {
    expect(validateDiffDir("/home/user/../etc/passwd")).not.toBeNull();
    expect(validateDiffDir("/tmp/../../etc")).not.toBeNull();
  });

  test("rejects paths with redundant slashes or dot segments", () => {
    expect(validateDiffDir("/home/user/./project")).not.toBeNull();
    expect(validateDiffDir("/home//user/project")).not.toBeNull();
    expect(validateDiffDir("/home/user/project/")).not.toBeNull();
  });
});

describe("parseUnifiedDiff", () => {
  test("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("  \n  ")).toEqual([]);
  });

  test("parses a single modified file", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,6 +10,8 @@ function foo() {
   const existing = true;
+  const x = 1;
+  const y = 2;
   return existing;
 }`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
    expect(files[0].status).toBe("modified");
    expect(files[0].insertions).toBe(2);
    expect(files[0].deletions).toBe(0);
  });

  test("parses a new file", () => {
    const diff = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return "world";
+}`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/new-file.ts");
    expect(files[0].status).toBe("added");
    expect(files[0].insertions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  test("parses a deleted file", () => {
    const diff = `diff --git a/src/old-file.ts b/src/old-file.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old-file.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-export function old() {
-  return "gone";
-}
-`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/old-file.ts");
    expect(files[0].status).toBe("deleted");
    expect(files[0].insertions).toBe(0);
    expect(files[0].deletions).toBe(4);
  });

  test("parses multiple files in one diff", () => {
    const diff = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/file2.ts b/file2.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/file2.ts
@@ -0,0 +1,2 @@
+new content
+more content
diff --git a/file3.ts b/file3.ts
deleted file mode 100644
index abc1234..0000000
--- a/file3.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-removed`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(3);

    expect(files[0].path).toBe("file1.ts");
    expect(files[0].status).toBe("modified");
    expect(files[0].insertions).toBe(1);
    expect(files[0].deletions).toBe(0);

    expect(files[1].path).toBe("file2.ts");
    expect(files[1].status).toBe("added");
    expect(files[1].insertions).toBe(2);
    expect(files[1].deletions).toBe(0);

    expect(files[2].path).toBe("file3.ts");
    expect(files[2].status).toBe("deleted");
    expect(files[2].insertions).toBe(0);
    expect(files[2].deletions).toBe(1);
  });

  test("detects renamed files", () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
-old line
+new line
 unchanged`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new-name.ts");
    expect(files[0].status).toBe("renamed");
    expect(files[0].insertions).toBe(1);
    expect(files[0].deletions).toBe(1);
  });

  test("handles mixed additions and deletions", () => {
    const diff = `diff --git a/config.ts b/config.ts
index abc..def 100644
--- a/config.ts
+++ b/config.ts
@@ -5,7 +5,8 @@
 const PORT = 3000;
-const HOST = "localhost";
-const DEBUG = false;
+const HOST = "0.0.0.0";
+const DEBUG = true;
+const VERBOSE = false;
 const TIMEOUT = 30;`;

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].insertions).toBe(3);
    expect(files[0].deletions).toBe(2);
  });

  test("preserves full diff content in the diff field", () => {
    const diff = `diff --git a/test.ts b/test.ts
index abc..def 100644
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-old
+new`;

    const files = parseUnifiedDiff(diff);
    expect(files[0].diff).toContain("diff --git a/test.ts b/test.ts");
    expect(files[0].diff).toContain("-old");
    expect(files[0].diff).toContain("+new");
  });
});

describe("parseNumstat", () => {
  test("returns empty map for empty input", () => {
    const result = parseNumstat("");
    expect(result.size).toBe(0);
  });

  test("parses basic numstat output", () => {
    const output = `3\t1\tsrc/app.ts
10\t0\tsrc/new.ts
0\t5\tsrc/old.ts`;

    const result = parseNumstat(output);
    expect(result.size).toBe(3);
    expect(result.get("src/app.ts")).toEqual({ insertions: 3, deletions: 1 });
    expect(result.get("src/new.ts")).toEqual({ insertions: 10, deletions: 0 });
    expect(result.get("src/old.ts")).toEqual({ insertions: 0, deletions: 5 });
  });

  test("handles binary files (shown as dashes)", () => {
    const output = `-\t-\timage.png`;

    const result = parseNumstat(output);
    expect(result.get("image.png")).toEqual({ insertions: 0, deletions: 0 });
  });

  test("handles files with tabs in names", () => {
    const output = `2\t1\tpath/to\tfile.ts`;

    const result = parseNumstat(output);
    // The path includes the tab since we join on tab from index 2
    expect(result.has("path/to\tfile.ts")).toBe(true);
  });

  test("skips empty lines", () => {
    const output = `1\t0\tfile.ts\n\n2\t1\tother.ts\n`;

    const result = parseNumstat(output);
    expect(result.size).toBe(2);
  });
});
