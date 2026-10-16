// The hosted verify page offers one-click samples (docs/samples). They must stay byte-identical to the
// documents registered on Base mainnet, and the tampered copy must differ from the original in one place only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha = (p) => "0x" + createHash("sha256").update(readFileSync(p)).digest("hex");
// docHash values of the mainnet demo records (README, "Live on Base").
const ACT_01 = "0x5ce4d8327a23f4fa5c5e0bcc551f22ecc9285b36b5aab25eb4b9093ac92db006";
const MANIFEST = "0x60728c3f97e3fee712732ad2f3d9cf5d6741a61b3d3fe97908d52514407b8bc8";

test("signed act sample equals the example registered on mainnet", () => {
  assert.equal(sha("docs/samples/act_01.pdf"), ACT_01);
  assert.equal(sha("examples/pdf/act_01.pdf"), ACT_01);
});

test("AI review manifest sample equals the manifest registered on mainnet", () => {
  assert.equal(sha("docs/samples/ai_review_manifest.json"), MANIFEST);
  assert.equal(sha("examples/legal/ai_review_manifest.json"), MANIFEST);
});

test("tampered act differs only in the changed amount and hashes differently", () => {
  const a = readFileSync("docs/samples/act_01.pdf");
  const b = readFileSync("docs/samples/act_01_tampered.pdf");
  assert.equal(a.length, b.length);
  const diff = [...a].map((x, i) => (x !== b[i] ? i : -1)).filter((i) => i >= 0);
  assert.equal(diff.length, 1, "exactly one byte differs");
  assert.equal(b.subarray(diff[0] - 1, diff[0] + 7).toString("latin1"), "28600.00");
  assert.equal(a.subarray(diff[0] - 1, diff[0] + 7).toString("latin1"), "23600.00");
  assert.notEqual(sha("docs/samples/act_01_tampered.pdf"), ACT_01);
});

test("verify page lists the mainnet demo signers for the samples", () => {
  const js = readFileSync("docs/app.js", "utf8");
  for (const addr of ["0xC628715a1ed46eb555B088e3d43dc61AE0134F33", "0x7590D6cc6D35B0798916638725CBc0DBA4777e8F"]) {
    assert.ok(js.includes(addr), addr);
    assert.ok(readFileSync("docs/networks.json", "utf8").includes(addr), addr);
  }
  const html = readFileSync("docs/index.html", "utf8");
  for (const s of ["act_01.pdf", "act_01_tampered.pdf", "ai_review_manifest.json"]) assert.ok(html.includes(`data-sample="${s}"`), s);
});
