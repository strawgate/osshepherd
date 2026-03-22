const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDiff } = require('../../utils/diff-parser');

const SIMPLE_DIFF = `diff --git a/foo.go b/foo.go
index abc..def 100644
--- a/foo.go
+++ b/foo.go
@@ -1,3 +1,4 @@
 package main
+
+// new comment
 func main() {}
`;

const TWO_FILE_DIFF = SIMPLE_DIFF + `diff --git a/bar.go b/bar.go
index 111..222 100644
--- a/bar.go
+++ b/bar.go
@@ -1 +1,2 @@
 package main
+// bar
`;

const NEW_FILE_DIFF = `diff --git a/new.go b/new.go
new file mode 100644
index 000..abc
--- /dev/null
+++ b/new.go
@@ -0,0 +1 @@
+package main
`;

const DELETED_FILE_DIFF = `diff --git a/old.go b/old.go
deleted file mode 100644
index abc..000
--- a/old.go
+++ /dev/null
@@ -1 +0,0 @@
-package main
`;

const RENAME_DIFF = `diff --git a/old-name.go b/new-name.go
similarity index 100%
rename from old-name.go
rename to new-name.go
`;

describe('parseDiff', () => {
  it('parses a single-file diff', () => {
    const files = parseDiff(SIMPLE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'foo.go');
  });

  it('parses a two-file diff', () => {
    const files = parseDiff(TWO_FILE_DIFF);
    assert.equal(files.length, 2);
    assert.equal(files[0].filename, 'foo.go');
    assert.equal(files[1].filename, 'bar.go');
  });

  it('preserves full diff content per file', () => {
    const files = parseDiff(SIMPLE_DIFF);
    assert.ok(files[0].diff.includes('diff --git'));
    assert.ok(files[0].diff.includes('foo.go'));
  });

  it('sets newFile: true for new file mode diffs', () => {
    const files = parseDiff(NEW_FILE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].newFile, true);
    assert.equal(files[0].deletedFile, false);
  });

  it('sets deletedFile: true for deleted file mode diffs', () => {
    const files = parseDiff(DELETED_FILE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].deletedFile, true);
    assert.equal(files[0].newFile, false);
  });

  it('uses the new path (b/) as filename for renames', () => {
    const files = parseDiff(RENAME_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'new-name.go');
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseDiff(''), []);
  });

  it('returns empty array for null/undefined', () => {
    assert.deepEqual(parseDiff(null), []);
    assert.deepEqual(parseDiff(undefined), []);
  });

  it('returns empty array for whitespace-only string', () => {
    assert.deepEqual(parseDiff('   \n  '), []);
  });

  it('sets newFile and deletedFile to false for a regular diff', () => {
    const files = parseDiff(SIMPLE_DIFF);
    assert.equal(files[0].newFile, false);
    assert.equal(files[0].deletedFile, false);
  });
});
