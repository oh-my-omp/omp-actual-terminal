const SIMPLE_ESCAPES: Record<string, string> = {
	"\\": "\\",
	'"': '"',
	"'": "'",
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
	a: "\x07",
	e: "\x1b",
};

export function unescapeChars(input: string): string {
	if (!input.includes("\\")) return input; // fast path
	let out = "";
	let i = 0;
	const len = input.length;
	while (i < len) {
		const ch = input[i]!;
		if (ch !== "\\") {
			out += ch;
			i++;
			continue;
		}
		if (i + 1 >= len) {
			out += "\\";
			break;
		}
		const next = input[i + 1]!;

		if (next === "x") {
			const hex = input.slice(i + 2, i + 4);
			if (hex.length === 2 && isHex(hex)) {
				out += String.fromCharCode(parseInt(hex, 16));
				i += 4;
				continue;
			}
			out += "\\x";
			i += 2;
			continue;
		}

		if (next === "u" && input[i + 2] === "{") {
			const close = input.indexOf("}", i + 3);
			if (close > i + 2 && close - (i + 3) >= 1 && close - (i + 3) <= 6) {
				const hex = input.slice(i + 3, close);
				if (isHex(hex)) {
					const cp = parseInt(hex, 16);
					if (cp <= 0x10ffff) {
						out += String.fromCodePoint(cp);
						i = close + 1;
						continue;
					}
				}
			}
			out += "\\u";
			i += 2;
			continue;
		}

		if (next === "u") {
			const hex = input.slice(i + 2, i + 6);
			if (hex.length === 4 && isHex(hex)) {
				out += String.fromCharCode(parseInt(hex, 16));
				i += 6;
				continue;
			}
			out += "\\u";
			i += 2;
			continue;
		}

		const mapped = SIMPLE_ESCAPES[next];
		if (mapped !== undefined) {
			out += mapped;
			i += 2;
			continue;
		}

		out += "\\" + next;
		i += 2;
	}
	return out;
}

function isHex(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66))) {
			return false;
		}
	}
	return true;
}
