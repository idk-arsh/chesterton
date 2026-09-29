import { describe, expect, it } from "vitest";
import { isTrivial, normalizeLine } from "../src/normalize.js";

const trivial = (raw: string) => isTrivial(normalizeLine(raw));

describe("isTrivial", () => {
  it("keeps the old rules: braces, keywords, short lines, imports", () => {
    for (const l of ["}", "  } else {", "end", "ab", "import x from 'y'", "from a import b", "use std::io;"]) expect(trivial(l), l).toBe(true);
  });

  it("treats require() assignments as imports", () => {
    for (const l of [
      "var debug = require('debug')('express:router');",
      "const { join } = require(\"node:path\");",
      "let fs = require('fs')",
      "var parseUrl = require('parseurl');",
    ]) {
      expect(trivial(l), l).toBe(true);
    }
    expect(trivial("var body = require('body-parser').json(opts) || fallback(req);"), "not only a require").toBe(false);
  });

  it("treats version pins as trivial", () => {
    for (const l of [
      '"debug": "^4.3.4",',
      '"merge-descriptors": "1.0.3"',
      'version = "2.31.0"',
      '__version__ = "2.32.3"',
      'serde = "1.0.197"',
      "pytest>=2.8.0,<9",
      "urllib3>=1.21.1,<3",
      "chardet==5.2.0",
      "idna[all]>=2.5; python_version >= '3.8'",
      "- uses: actions/checkout@v4",
      "uses: actions/setup-python@0a5c61591373683505ea898e09a3ea4f39ef2b9c # v5.0.0",
      "rev: v4.4.0",
    ]) {
      expect(trivial(l), l).toBe(true);
    }
  });

  it("treats a lone quoted string plus comma as trivial", () => {
    for (const l of ['"urllib3>=1.21.1,<1.27",', "'Content-Length',", '"a \\" quote",']) expect(trivial(l), l).toBe(true);
  });

  it("does not swallow real code", () => {
    for (const l of [
      "if retries >= max_retries:",
      "timeout = 30",
      "return \"done\"",
      '"a", "b",',
      "count == 1.5 and other()",
      "self.max_redirects = DEFAULT_REDIRECT_LIMIT",
      "raise InvalidURL(\"Invalid URL %r: No host supplied\" % url)",
      'headers["Content-Length"] = str(length)',
    ]) {
      expect(trivial(l), l).toBe(false);
    }
  });
});
