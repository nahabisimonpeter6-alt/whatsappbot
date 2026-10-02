const test = require("node:test");
const assert = require("node:assert/strict");
const { containsLink } = require("../src/links");

for (const text of [
  "https://example.com", "HTTP://EXAMPLE.COM/a", "www.example.com",
  "Visit (example.com)", "[example.com]", "<example.com>", "example.com.",
  "example.co.ug/path", "join https://chat.whatsapp.com/invite",
  "example.com:8080/path", "https://127.0.0.1/path", "https://localhost",
  "例子.中国", "xn--fsqu00a.xn--fiqs8s", "user.github.io", "See\nexample.com"
]) {
  test(`detects link: ${text}`, () => assert.equal(containsLink(text), true));
}
for (const text of [
  "hello", "Please read report.pdf", "photo.jpg", "notes.txt",
  "john.smith@example.com", "contact alice@example.com", "version 1.34.7",
  "console.log()", "https://", "not..example.com", "", undefined
]) {
  test(`allows non-link: ${text}`, () => assert.equal(containsLink(text), false));
}
