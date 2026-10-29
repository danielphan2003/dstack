import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const script = fileURLToPath(new URL("./share.mjs", import.meta.url));
const MAX_HTML_BYTES = 512 * 1024;

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lakebed-share-test-"));
  const state = path.join(root, "state");
  const captures = path.join(root, "captures");
  await mkdir(captures);
  const fakeCli = path.join(root, "fake-cli.mjs");
  await writeFile(fakeCli, `import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const cwd = process.cwd();
const statePath = process.env.FAKE_STATE_FILE;
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { next: 1, calls: 0, deployments: {} };
state.calls += 1;
const deployBinding = path.join(cwd, ".lakebed", "deploy.json");
const rootBinding = path.join(cwd, "lakebed.json");
const binding = existsSync(deployBinding) ? JSON.parse(readFileSync(deployBinding, "utf8")) : existsSync(rootBinding) ? JSON.parse(readFileSync(rootBinding, "utf8")) : null;
let deployId = binding?.deployId ?? \`deploy-\${state.next++}\`;
deployId = process.env.FAKE_DEPLOY_ID ?? deployId;
let url = process.env.FAKE_DEPLOY_URL ?? state.deployments[binding?.deployId ?? deployId]?.url ?? \`https://share.example.test/\${deployId}\`;
state.deployments[deployId] ??= { url };
writeFileSync(statePath, JSON.stringify(state));
const capture = path.join(process.env.FAKE_CAPTURE_DIR, \`call-\${state.calls}\`);
mkdirSync(capture, { recursive: true });
copyFileSync(path.join(cwd, "client", "index.tsx"), path.join(capture, "client.tsx"));
copyFileSync(path.join(cwd, "server", "index.ts"), path.join(capture, "server.ts"));
writeFileSync(path.join(capture, "passphrase-env-missing.txt"), String(process.env.SHARE_TEST_PASSWORD === undefined));
if (existsSync(deployBinding)) copyFileSync(deployBinding, path.join(capture, "deploy.json"));
if (existsSync(rootBinding)) copyFileSync(rootBinding, path.join(capture, "lakebed.json"));
const claimed = process.env.FAKE_CLAIMED === "true";
const output = { deployId, url, claimed, expiresAt: process.env.FAKE_EXPIRES_AT ?? "2030-01-01T00:00:00.000Z" };
if (process.env.FAKE_NO_CLAIM_TOKEN !== "true") output.claimUrl = \`https://api.example.test/claim/\${deployId}/fake-claim-token\`;
process.stdout.write(JSON.stringify(output));
`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseEnv = {
    ...process.env,
    XDG_STATE_HOME: state,
    LAKEBED_CLI: `${process.execPath} ${fakeCli}`,
    FAKE_STATE_FILE: path.join(root, "fake-state.json"),
    FAKE_CAPTURE_DIR: captures,
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...baseEnv, ...extraEnv },
    timeout: 30_000,
  });
  const htmlPath = path.join(root, "page.html");
  const writeHtml = (contents) => writeFile(htmlPath, contents);
  const capturesList = async () => (await readdir(captures)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  return { root, state, captures, run, htmlPath, writeHtml, capturesList };
}

function receipt(result) {
  assert.equal(result.status, 0, "publish succeeds");
  return JSON.parse(result.stdout);
}

async function readRecord(state, name) {
  return JSON.parse(await readFile(path.join(state, "lakebed-share", `${name}.json`), "utf8"));
}

function decryptWithGeneratedShell(client, secret, hashPrefix, passphrase) {
  const start = client.indexOf("const CIPHERTEXT = ");
  const end = client.indexOf("function showHtml(html)");
  assert.ok(start >= 0 && end > start, "published capsule contains decrypting shell code");
  const source = `${client.slice(start, end)}\nglobalThis.testDecrypt = decryptHtml;`;
  const context = vm.createContext({
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    window: { location: { hash: `#${hashPrefix}${secret}` } },
  });
  vm.runInContext(source, context);
  return context.testDecrypt(passphrase);
}

function showPublishedHtml(client, html) {
  const start = client.indexOf("const CIPHERTEXT = ");
  const end = client.indexOf("export function App()");
  assert.ok(start >= 0 && end > start, "published capsule contains its sandboxed page shell");
  const iframe = { attributes: new Map(), style: {}, setAttribute(name, value) { this.attributes.set(name, value); } };
  const body = { style: {}, children: [], replaceChildren(child) { this.children = [child]; } };
  const context = vm.createContext({
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    document: { createElement: () => iframe, body },
    DOMParser: class {
      parseFromString(source) {
        const head = { prepended: [], prepend(node) { this.prepended.push(node); } };
        iframe.parsedHead = head;
        return {
          doctype: source.toLowerCase().startsWith("<!doctype html") ? { name: "html" } : null,
          head,
          createElement: () => ({}),
          documentElement: { outerHTML: source.replace(/^<!doctype html>/i, "") },
        };
      }
    },
  });
  vm.runInContext(`${client.slice(start, end)}\nglobalThis.showPublishedHtml = showHtml;`, context);
  context.showPublishedHtml(html);
  return iframe;
}

async function capturedClient(h, call) {
  return readFile(path.join(h.captures, call, "client.tsx"), "utf8");
}

test("Node encryption round-trips through the generated WebCrypto shell in both modes", async (t) => {
  const h = await harness(t);
  const html = "<!doctype html><html><body><h1>round trip</h1></body></html>";
  await h.writeHtml(html);
  const plain = receipt(h.run(["publish", h.htmlPath, "--name", "round-trip", "--json"]));
  const plainRecord = await readRecord(h.state, "round-trip");
  const plainClient = await capturedClient(h, "call-1");
  assert.equal(await decryptWithGeneratedShell(plainClient, plainRecord.secret, "", ""), html);
  const iframe = showPublishedHtml(plainClient, html);
  assert.equal(iframe.attributes.get("sandbox"), "allow-scripts allow-modals allow-downloads");
  assert.ok(!iframe.attributes.get("sandbox").includes("allow-same-origin"));
  assert.equal(iframe.attributes.get("referrerpolicy"), "no-referrer");
  const [csp] = iframe.parsedHead.prepended;
  assert.equal(csp.httpEquiv, "Content-Security-Policy", "CSP meta goes first in the page head");
  assert.ok(csp.content.includes("connect-src 'none'") && csp.content.startsWith("default-src 'none'"));
  assert.ok(iframe.srcdoc.startsWith("<!doctype html>"), "doctype stays first so the page renders in standards mode");

  const protectedReceipt = receipt(h.run(
    ["publish", h.htmlPath, "--name", "round-trip-pass", "--passphrase-env", "SHARE_TEST_PASSWORD", "--json"],
    { SHARE_TEST_PASSWORD: "correct horse" },
  ));
  const protectedRecord = await readRecord(h.state, "round-trip-pass");
  const protectedClient = await capturedClient(h, "call-2");
  assert.equal(await readFile(path.join(h.captures, "call-2", "passphrase-env-missing.txt"), "utf8"), "true");
  assert.equal(await decryptWithGeneratedShell(protectedClient, protectedRecord.secret, "key=", "correct horse"), html);
  await assert.rejects(() => decryptWithGeneratedShell(protectedClient, protectedRecord.secret, "", "wrong"));
  assert.equal(plain.passphrase, false);
  assert.equal(protectedReceipt.passphrase, true);
});

test("republish preserves the share URL and deployment binding; --new rotates them", async (t) => {
  const h = await harness(t);
  await h.writeHtml("<h1>stable</h1>");
  const first = receipt(h.run(["publish", h.htmlPath, "--name", "stable", "--json"]));
  const second = receipt(h.run(["publish", h.htmlPath, "--name", "stable", "--json"]));
  assert.ok(first.url === second.url, "republish keeps the complete share URL stable");
  assert.ok(first.deployId === second.deployId, "republish updates the same deployment");
  assert.equal(second.reused, true);
  const binding = JSON.parse(await readFile(path.join(h.captures, "call-2", "deploy.json"), "utf8"));
  assert.equal(binding.deployId, first.deployId);
  assert.equal(binding.url, new URL(first.url).origin + new URL(first.url).pathname);
  assert.equal(binding.api, "https://api.lakebed.dev");

  const rotated = receipt(h.run(["publish", h.htmlPath, "--name", "stable", "--new", "--json"]));
  assert.ok(rotated.url !== second.url, "--new changes the share URL");
  assert.ok(rotated.deployId !== second.deployId, "--new creates another deployment");
  assert.equal(rotated.reused, false);
});

test("a failed republish leaves the saved deployment record unchanged", async (t) => {
  for (const [override, expected] of [
    [{ FAKE_DEPLOY_ID: "unexpected-deploy" }, "unexpected deployment"],
    [{ FAKE_DEPLOY_URL: "https://changed.example.test/other" }, "changed the hosted URL"],
  ]) {
    const h = await harness(t);
    await h.writeHtml("<h1>consistency</h1>");
    receipt(h.run(["publish", h.htmlPath, "--name", "consistent", "--json"]));
    const before = await readRecord(h.state, "consistent");
    const failed = h.run(["publish", h.htmlPath, "--name", "consistent", "--json"], override);
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes(expected), "mismatched deployment is rejected");
    const after = await readRecord(h.state, "consistent");
    assert.ok(before.deployId === after.deployId && before.secret === after.secret, "failed update preserves local record");
  }
});

test("unclaimed deployments without a claim token are refused and APIs are normalized", async (t) => {
  const h = await harness(t);
  await h.writeHtml("<h1>claim validation</h1>");
  const noClaimToken = h.run(
    ["publish", h.htmlPath, "--name", "no-claim", "--json"],
    { FAKE_NO_CLAIM_TOKEN: "true" },
  );
  assert.equal(noClaimToken.status, 1);
  assert.ok(noClaimToken.stderr.includes("without a claim token"));
  await assert.rejects(() => readRecord(h.state, "no-claim"));

  const invalidApi = h.run(["publish", h.htmlPath, "--name", "bad-api", "--api", "http://example.test"]);
  assert.equal(invalidApi.status, 1);
  assert.ok(invalidApi.stderr.includes("must use HTTPS"));

  const local = receipt(h.run(["publish", h.htmlPath, "--name", "local-api", "--api", "http://localhost:4010", "--json"]));
  assert.equal(local.name, "local-api");
  assert.equal((await readRecord(h.state, "local-api")).api, "http://localhost:4010");
});

test("self-containment lint identifies remote references and --allow-external warns", async (t) => {
  const h = await harness(t);
  await h.writeHtml(`<!doctype html>
<img src="https://cdn.example.test/image.png">
<style>@import url(//fonts.example.test/site.css); .hero { background: url('https://img.example.test/bg.png') }</style>
<link rel="stylesheet" href="https://styles.example.test/app.css">`);
  const rejected = h.run(["publish", h.htmlPath, "--name", "external", "--json"]);
  assert.equal(rejected.status, 1);
  assert.ok(rejected.stderr.includes("line 2") && rejected.stderr.includes("line 3") && rejected.stderr.includes("line 4"), "each external reference includes its source line");
  assert.ok(rejected.stderr.includes("CSP will block"), "lint explains the published CSP behavior");
  const allowed = h.run(["publish", h.htmlPath, "--name", "external", "--allow-external", "--json"]);
  assert.equal(allowed.status, 0, "explicit override permits publication");
  assert.ok(allowed.stderr.includes("Warning: External resource references"), "explicit override still warns");
});

test("passphrase environment rules prevent silent key-mode changes", async (t) => {
  const h = await harness(t);
  await h.writeHtml("<h1>passphrase rules</h1>");

  const missing = h.run(["publish", h.htmlPath, "--name", "missing-pass", "--passphrase-env", "ABSENT_SHARE_PASSWORD"]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("is not set"));

  receipt(h.run(
    ["publish", h.htmlPath, "--name", "protected", "--passphrase-env", "SHARE_TEST_PASSWORD", "--json"],
    { SHARE_TEST_PASSWORD: "correct horse" },
  ));
  const protectedBefore = await readRecord(h.state, "protected");
  const protectedRotation = receipt(h.run(
    ["publish", h.htmlPath, "--name", "protected", "--new", "--passphrase-env", "SHARE_TEST_PASSWORD", "--json"],
    { SHARE_TEST_PASSWORD: "correct horse" },
  ));
  const protectedAfter = await readRecord(h.state, "protected");
  assert.ok(protectedBefore.secret !== protectedAfter.secret, "--new rotates the fragment key");
  assert.ok(protectedBefore.passphrase.salt !== protectedAfter.passphrase.salt, "--new rotates the passphrase salt");
  assert.ok(protectedRotation.deployId !== protectedBefore.deployId, "--new creates a fresh passphrase deployment");
  const noPassphrase = h.run(["publish", h.htmlPath, "--name", "protected", "--json"]);
  assert.equal(noPassphrase.status, 1);
  assert.ok(noPassphrase.stderr.includes("uses a passphrase"));

  receipt(h.run(["publish", h.htmlPath, "--name", "plain", "--json"]));
  const passphraseWithoutNew = h.run(
    ["publish", h.htmlPath, "--name", "plain", "--passphrase-env", "SHARE_TEST_PASSWORD"],
    { SHARE_TEST_PASSWORD: "correct horse" },
  );
  assert.equal(passphraseWithoutNew.status, 1);
  assert.ok(passphraseWithoutNew.stderr.includes("Use --new"));
  const passphraseWithNew = receipt(h.run(
    ["publish", h.htmlPath, "--name", "plain", "--new", "--passphrase-env", "SHARE_TEST_PASSWORD", "--json"],
    { SHARE_TEST_PASSWORD: "correct horse" },
  ));
  assert.equal(passphraseWithNew.passphrase, true);
});

test("HTML size is capped and non-file paths are rejected", async (t) => {
  const h = await harness(t);
  await writeFile(h.htmlPath, Buffer.alloc(MAX_HTML_BYTES + 1, 32));
  const tooLarge = h.run(["publish", h.htmlPath, "--name", "too-large"]);
  assert.equal(tooLarge.status, 1);
  assert.ok(tooLarge.stderr.includes("524288-byte limit"));

  const directory = path.join(h.root, "not-a-file");
  await mkdir(directory);
  const nonFile = h.run(["publish", directory, "--name", "not-a-file"]);
  assert.equal(nonFile.status, 1);
  assert.ok(nonFile.stderr.includes("not a file"));
});

test("records are private, list omits keys, and forget only removes local state", async (t) => {
  const h = await harness(t);
  await h.writeHtml("<h1>private record</h1>");
  const published = receipt(h.run(["publish", h.htmlPath, "--name", "private", "--json"]));
  const recordPath = path.join(h.state, "lakebed-share", "private.json");
  const record = await readRecord(h.state, "private");
  const fileMode = (await stat(recordPath)).mode & 0o777;
  const directoryMode = (await stat(path.dirname(recordPath))).mode & 0o777;
  assert.equal(fileMode, 0o600);
  assert.equal(directoryMode, 0o700);

  const listed = h.run(["list", "--json"]);
  assert.equal(listed.status, 0);
  const entries = JSON.parse(listed.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hostedUrl, new URL(published.url).origin + new URL(published.url).pathname);
  assert.equal(entries[0].claimed, false);
  assert.ok(!listed.stdout.includes(record.secret), "list does not expose the fragment key");
  assert.ok(!listed.stdout.includes("fake-claim-token"), "list does not expose claim tokens");
  assert.ok(!listed.stdout.includes("#"), "list URLs have no fragment");

  const url = h.run(["url", "private"]);
  assert.equal(url.status, 0);
  assert.ok(url.stdout.trim() === published.url, "url returns the stored complete share URL");
  const forgotten = h.run(["forget", "private"]);
  assert.equal(forgotten.status, 0);
  assert.ok(forgotten.stdout.includes("remote deploy keeps serving"));
  assert.equal((await h.capturesList()).length, 1, "forget does not issue another Lakebed deployment");
  await assert.rejects(() => readFile(recordPath));
});
