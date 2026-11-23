import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { unescapeChars } from "../src/unescape.ts";

describe("unescapeChars", () => {
	it("passes plain ASCII through untouched (fast path)", () => {
		assert.equal(unescapeChars("hello world"), "hello world");
	});

	it("decodes simple one-char escapes", () => {
		assert.equal(unescapeChars("a\\nb"), "a\nb");
		assert.equal(unescapeChars("a\\rb"), "a\rb");
		assert.equal(unescapeChars("a\\tb"), "a\tb");
		assert.equal(unescapeChars("a\\bb"), "a\bb");
		assert.equal(unescapeChars("a\\fb"), "a\fb");
		assert.equal(unescapeChars("a\\vb"), "a\vb");
		assert.equal(unescapeChars("a\\0b"), "a\0b");
		assert.equal(unescapeChars("a\\ab"), "a\x07b");
		assert.equal(unescapeChars("a\\eb"), "a\x1bb");
		assert.equal(unescapeChars("a\\\\b"), "a\\b");
		assert.equal(unescapeChars('a\\"b'), 'a"b');
		assert.equal(unescapeChars("a\\'b"), "a'b");
	});

	it("decodes \\xHH", () => {
		assert.equal(unescapeChars("\\x00"), "\0");
		assert.equal(unescapeChars("\\x03"), "\x03");
		assert.equal(unescapeChars("\\x1b"), "\x1b");
		assert.equal(unescapeChars("\\x7f"), "\x7f");
		assert.equal(unescapeChars("\\xFF"), "\xff");
		assert.equal(unescapeChars("a\\x09b"), "a\tb");
	});

	it("rejects short or non-hex \\x — leaves \\x literal + rescans rest", () => {
		assert.equal(unescapeChars("\\x1"), "\\x1");
		assert.equal(unescapeChars("\\xZZ"), "\\xZZ");
		assert.equal(unescapeChars("foo\\x"), "foo\\x");
	});

	it("decodes \\uHHHH", () => {
		assert.equal(unescapeChars("\\u001b"), "\x1b");
		assert.equal(unescapeChars("\\u0041"), "A");
		assert.equal(unescapeChars("\\u00e9"), "é");
		assert.equal(unescapeChars("\\u41"), "\\u41");
	});

	it("decodes \\u{H...H} with 1-6 hex digits", () => {
		assert.equal(unescapeChars("\\u{1}"), "\x01");
		assert.equal(unescapeChars("\\u{1b}"), "\x1b");
		assert.equal(unescapeChars("\\u{1F389}"), "🎉");
		assert.equal(unescapeChars("\\u{10FFFF}"), "\u{10FFFF}");
		assert.equal(unescapeChars("\\u{110000}"), "\\u{110000}");
		assert.equal(unescapeChars("\\u{1234567}"), "\\u{1234567}");
		assert.equal(unescapeChars("\\u{}"), "\\u{}");
		assert.equal(unescapeChars("\\u{1b"), "\\u{1b");
	});

	it("preserves unknown escapes verbatim (backslash + char both kept)", () => {
		assert.equal(unescapeChars("\\q"), "\\q");
		assert.equal(unescapeChars("regex:\\."), "regex:\\.");
		assert.equal(unescapeChars("\\-"), "\\-");
		assert.equal(unescapeChars("C:\\Users\\Documents"), "C:\\Users\\Documents");
	});

	it("known-escape letters IN unescaped paths get decoded (use \\\\ to preserve)", () => {
		assert.equal(unescapeChars("C:\\foo"), "C:\x0Coo");
		assert.equal(unescapeChars("C:\\\\foo"), "C:\\foo"); // correctly escaped
		assert.equal(unescapeChars("C:\\temp"), "C:\temp");
		assert.equal(unescapeChars("C:\\\\temp"), "C:\\temp"); // correctly escaped
	});

	it("preserves trailing backslash at end of string", () => {
		assert.equal(unescapeChars("foo\\"), "foo\\");
		assert.equal(unescapeChars("\\"), "\\");
	});

	it("raw control chars pass through untouched", () => {
		assert.equal(unescapeChars("a\nb"), "a\nb"); // real LF
		assert.equal(unescapeChars("a\x1bb"), "a\x1bb"); // real ESC
		assert.equal(unescapeChars("a\x03b"), "a\x03b"); // real 0x03
	});

	it("UTF-8 characters are preserved across the decoder", () => {
		assert.equal(unescapeChars("🎉"), "🎉");
		assert.equal(unescapeChars("前\\n后"), "前\n后");
	});

	it("\\\\ does not eat the next char (greedy-escape regression)", () => {
		assert.equal(unescapeChars("\\\\n"), "\\n");
		assert.equal(unescapeChars("\\\\\\\\"), "\\\\");
	});

	it("real-world sequences: vim :wq and Ctrl-C", () => {
		assert.equal(unescapeChars("\\x1b:wq\\n"), "\x1b:wq\n");
		assert.equal(unescapeChars("\\x03"), "\x03");
		assert.equal(unescapeChars("\\x04"), "\x04");
	});

	it("mixed escapes in one string", () => {
		assert.equal(unescapeChars("\\x1b[A\\u001b[B\\n"), "\x1b[A\x1b[B\n");
		assert.equal(unescapeChars("a\\tb\\nc\\\\d"), "a\tb\nc\\d");
	});
});
