"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const tokens = fs.readFileSync(path.join(root, "vendor/furioursus-ui/tokens.css"), "utf8");
const defined = (css) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test("every CSS variable the page uses is defined by the shared tokens or the page", () => {
	const available = new Set([...defined(tokens), ...defined(page)]);
	const used = new Set([...page.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
	const missing = [...used].filter((name) => !available.has(name));
	assert.deepEqual(missing, [], "rename these after updating vendor/furioursus-ui");
});

test("the vendored theme script and tokens load before the page's own styles", () => {
	const script = page.indexOf('src="vendor/furioursus-ui/theme.js"');
	const sheet = page.indexOf('href="vendor/furioursus-ui/tokens.css"');
	const meta = page.indexOf('name="theme-color"');
	const style = page.indexOf("<style>");
	assert.ok(meta !== -1 && meta < script, "theme-color meta must come before theme.js");
	assert.ok(script !== -1 && sheet !== -1 && sheet < style, "tokens.css must load before <style>");
});
