#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createCipheriv, hkdfSync, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_HTML_BYTES = 512 * 1024;
const DEPLOY_TIMEOUT_MS = 180_000;
const MAX_ERROR_CHARS = 8_000;
const DEFAULT_API = "https://api.lakebed.dev";
const PASSPHRASE_ITERATIONS = 600_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const KEY_DERIVATION = Object.freeze({
  secret: ({ secret }) => Buffer.from(secret),
  passphrase: ({ secret, passphrase, salt, iterations }) => {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      throw new Error("A non-empty passphrase is required.");
    }
    const p = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
    return Buffer.from(hkdfSync("sha256", Buffer.concat([secret, p]), salt, "lakebed-share v1", 32));
  },
});

function deriveContentKey(secret, config, passphrase) {
  const mode = config === null ? "secret" : "passphrase";
  return KEY_DERIVATION[mode]({
    secret,
    passphrase,
    salt: config ? Buffer.from(config.salt, "base64") : undefined,
    iterations: config?.iterations,
  });
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help" };
  if (command === "publish") {
    const positional = [];
    const options = { allowExternal: false, forceNew: false, json: false };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--new") options.forceNew = true;
      else if (arg === "--allow-external") options.allowExternal = true;
      else if (arg === "--json") options.json = true;
      else if (["--name", "--passphrase-env", "--api"].includes(arg)) {
        const value = args[i + 1];
        if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
        const key = { "--name": "name", "--passphrase-env": "passphraseEnv", "--api": "api" }[arg];
        if (options[key] !== undefined) throw new Error(`${arg} may be specified only once.`);
        options[key] = value;
        i += 1;
      } else if (arg.startsWith("-")) throw new Error(`Unknown publish option: ${arg}`);
      else positional.push(arg);
    }
    if (positional.length !== 1) throw new Error("publish requires exactly one HTML file path.");
    if (!options.name) throw new Error("publish requires --name <slug>.");
    return { command, file: positional[0], options };
  }
  if (command === "list") {
    if (args.some((arg) => arg !== "--json")) throw new Error("list accepts only --json.");
    return { command, json: args.includes("--json") };
  }
  if (command === "url" || command === "forget") {
    if (args.length !== 1) throw new Error(`${command} requires exactly one share name.`);
    return { command, name: args[0] };
  }
  throw new Error(`Unknown command: ${command}`);
}

function validateName(name) {
  if (!NAME_PATTERN.test(name)) throw new Error("Share names must match [a-z0-9][a-z0-9-]{0,62}.");
}

function normalizeApi(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Lakebed API URL.");
  }
  const host = url.hostname.toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.endsWith(".localhost");
  if (
    url.username || url.password || (url.pathname && url.pathname !== "/") ||
    url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) {
    throw new Error("Lakebed API URLs must use HTTPS without credentials, paths, queries, or fragments, except localhost development APIs.");
  }
  return url.origin;
}

function resolveApi(explicit, existing, forceNew) {
  if (existing && !forceNew) {
    if (explicit && normalizeApi(explicit) !== existing.api) {
      throw new Error(`This share is already bound to ${existing.api}. Use --new to publish to a different Lakebed API.`);
    }
    return existing.api;
  }
  return normalizeApi(explicit ?? (existing && forceNew ? existing.api : undefined) ?? process.env.LAKEBED_DEPLOY_API ?? process.env.SPAN_DEPLOY_API ?? DEFAULT_API);
}

function normalizeHostedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Lakebed returned an invalid hosted URL.");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function claimTokenFromUrl(value) {
  if (!value) return undefined;
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  return segments[0] === "claim" && segments.length >= 3 ? segments[2] : undefined;
}

function parseDeployResult(stdout) {
  let output;
  try {
    output = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Lakebed returned invalid JSON.");
  }
  if (
    !output || typeof output !== "object" || typeof output.deployId !== "string" || !output.deployId ||
    typeof output.url !== "string" || !output.url ||
    (output.claimed !== undefined && typeof output.claimed !== "boolean") ||
    (output.claimUrl !== undefined && typeof output.claimUrl !== "string") ||
    (output.expiresAt !== undefined && output.expiresAt !== null && typeof output.expiresAt !== "string")
  ) throw new Error("Lakebed deploy output did not include a valid deploy ID and URL.");
  try {
    return {
      deployId: output.deployId,
      url: normalizeHostedUrl(output.url),
      claimed: output.claimed,
      claimToken: claimTokenFromUrl(output.claimUrl),
      expiresAt: output.expiresAt,
    };
  } catch {
    throw new Error("Lakebed deploy output did not include a valid deploy ID and URL.");
  }
}

function redactOutput(value) {
  return value
    .replace(/((?:["']?(?:claimToken|claimUrl)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s"'<>]*\/claim\/[^/\s"'<>]+\/)[^/?#\s"'<>]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s"'<>#]+)#([^\s"'<>]*)/g, "$1#[redacted]");
}

function safeErrorOutput(stdout, stderr) {
  const text = redactOutput([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"));
  if (!text) return "Lakebed exited without an error message.";
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}\n[output truncated]` : text;
}

function cliCommand() {
  const configured = process.env.LAKEBED_CLI?.trim();
  if (!configured) return { command: "npx", prefix: ["-y", "lakebed@0.0.40"] };
  const [command, ...prefix] = configured.split(" ").filter(Boolean);
  if (!command) throw new Error("LAKEBED_CLI is empty.");
  return { command, prefix };
}

async function runDeploy(capsulePath, api, passphraseEnv) {
  const configured = cliCommand();
  const env = { ...process.env };
  if (passphraseEnv) delete env[passphraseEnv];
  const child = spawn(configured.command, [
    ...configured.prefix, "deploy", ".", "--json", "--api", api,
  ], { cwd: capsulePath, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    killTimer.unref();
  }, DEPLOY_TIMEOUT_MS);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code }));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (timedOut) throw new Error(`Lakebed deploy timed out after 180 seconds.\n${safeErrorOutput(out, err)}`);
  if (result.code !== 0) throw new Error(`Lakebed deploy failed:\n${safeErrorOutput(out, err)}`);
  return parseDeployResult(out);
}

function safeReference(reference) {
  return reference.replace(/https?:\/\/[^\s"'<>]+|\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "/" : "/[path redacted]"}`;
    } catch {
      return "[external URL redacted]";
    }
  });
}

function collectExternalReferences(html) {
  const patterns = [
    /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
    /@import\s+(?:url\s*\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s);]+))/gi,
  ];
  const found = new Map();
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!/^(?:https?:\/\/|\/\/)/i.test(value)) continue;
      const offset = match.index + match[0].indexOf(value);
      found.set(offset, {
        line: html.slice(0, offset).split("\n").length,
        reference: safeReference(match[0].trim()),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function checkExternalReferences(references, allowed) {
  if (references.length === 0) return;
  const detail = references.map(({ line, reference }) => `  line ${line}: ${reference}`).join("\n");
  const message = `External resource references were found:\n${detail}\nThe published page's CSP will block network-loaded resources. Inline or embed every required asset.`;
  if (allowed) {
    process.stderr.write(`Warning: ${message}\n`);
    return;
  }
  throw new Error(`Publishing stopped because the HTML is not self-contained.\n${message}`);
}

function stateDirectory() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(path.resolve(base), "lakebed-share");
}

async function ensureStateDirectory() {
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

function recordPath(directory, name) {
  validateName(name);
  return path.join(directory, `${name}.json`);
}

function validateRecord(record, name) {
  if (
    !record || record.version !== 1 || record.name !== name || !NAME_PATTERN.test(name) ||
    typeof record.api !== "string" || typeof record.deployId !== "string" ||
    typeof record.hostedUrl !== "string" ||
    !(record.claimToken === null || typeof record.claimToken === "string") ||
    typeof record.secret !== "string" || typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !(record.expiresAt === null || typeof record.expiresAt === "string") ||
    !(record.passphrase === null || typeof record.passphrase === "object")
  ) throw new Error(`The local record for ${name} is invalid.`);
  const secret = Buffer.from(record.secret, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== record.secret) {
    throw new Error(`The local record for ${name} has an invalid key.`);
  }
  if (record.passphrase !== null) {
    if (
      Array.isArray(record.passphrase) ||
      typeof record.passphrase.salt !== "string" ||
      record.passphrase.iterations !== PASSPHRASE_ITERATIONS
    ) throw new Error(`The local record for ${name} is invalid.`);
    const salt = Buffer.from(record.passphrase.salt, "base64");
    if (
      salt.length !== 16 ||
      salt.toString("base64") !== record.passphrase.salt ||
      record.passphrase.iterations !== PASSPHRASE_ITERATIONS
    ) throw new Error(`The local record for ${name} is invalid.`);
  }
  if (normalizeApi(record.api) !== record.api || normalizeHostedUrl(record.hostedUrl) !== record.hostedUrl) {
    throw new Error(`The local record for ${name} is invalid.`);
  }
  return record;
}

async function readRecord(name) {
  const directory = await ensureStateDirectory();
  let text;
  try {
    text = await readFile(recordPath(directory, name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`The local record for ${name} is not valid JSON.`);
  }
  return validateRecord(record, name);
}

async function saveRecord(record) {
  const directory = await ensureStateDirectory();
  const target = recordPath(directory, record.name);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function getPassphrase(envName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error("--passphrase-env must name a valid environment variable.");
  }
  const value = process.env[envName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Passphrase environment variable ${envName} is not set.`);
  }
  return value;
}

function encryptHtml(html, secret, config, passphrase) {
  const key = deriveContentKey(secret, config, passphrase);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(html), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64") };
}

function createEncryptedClient(encrypted, passphraseConfig) {
  return `import { useEffect, useState } from "preact/hooks";

const CIPHERTEXT = ${JSON.stringify(encrypted.ciphertext)};
const IV = ${JSON.stringify(encrypted.iv)};
const PASSPHRASE = ${JSON.stringify(passphraseConfig)};
const CSP = ${JSON.stringify("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'")};

const KEY_DERIVATION = {
  secret: async ({ secretBytes }) => secretBytes,
  passphrase: async ({ secretBytes, password, config }) => {
    const salt = decodeBase64(config.salt);
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
    );
    const passwordKey = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: config.iterations }, material, 256,
    ));
    const inputKey = new Uint8Array(secretBytes.length + passwordKey.length);
    inputKey.set(secretBytes);
    inputKey.set(passwordKey, secretBytes.length);
    const hkdfMaterial = await crypto.subtle.importKey("raw", inputKey, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: "HKDF", hash: "SHA-256", salt,
      info: new TextEncoder().encode("lakebed-share v1"),
    }, hkdfMaterial, 256));
  },
};

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return decodeBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

async function decryptHtml(password = "") {
  const fragment = window.location.hash.slice(1);
  const encodedSecret = fragment.startsWith("key=") ? fragment.slice(4) : fragment;
  const secretBytes = decodeBase64Url(encodedSecret);
  if (secretBytes.byteLength !== 32) throw new Error("The URL does not contain a valid decryption key.");
  const mode = PASSPHRASE === null ? "secret" : "passphrase";
  const keyBytes = await KEY_DERIVATION[mode]({ secretBytes, password, config: PASSPHRASE });
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(IV), tagLength: 128 }, key, decodeBase64(CIPHERTEXT),
  );
  return new TextDecoder().decode(plaintext);
}

function withCsp(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = doc.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = CSP;
  doc.head.prepend(meta);
  const doctype = doc.doctype ? "<!doctype " + doc.doctype.name + ">" : "";
  return doctype + doc.documentElement.outerHTML;
}

function showHtml(html) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-modals allow-downloads");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", "Encrypted web app");
  iframe.style.border = "0";
  iframe.style.height = "100dvh";
  iframe.style.width = "100%";
  iframe.srcdoc = withCsp(html);
  document.body.style.margin = "0";
  document.body.replaceChildren(iframe);
}

export function App() {
  const [error, setError] = useState("");
  async function openApp(password = "") {
    setError("");
    try {
      showHtml(await decryptHtml(password));
    } catch (cause) {
      setError(PASSPHRASE === null
        ? cause instanceof Error ? cause.message : "Unable to decrypt this page."
        : "Wrong passphrase. Check it and try again.");
    }
  }
  useEffect(() => {
    if (PASSPHRASE === null) void openApp();
  }, []);
  return (
    <main className="grid min-h-screen place-items-center bg-neutral-950 p-6 text-neutral-100">
      <section className="max-w-lg rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">End-to-end encrypted</p>
        <h1 className="mt-3 text-2xl font-semibold">
          {PASSPHRASE !== null ? "Enter passphrase" : error ? "Unable to open app" : "Decrypting app…"}
        </h1>
        {PASSPHRASE !== null ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.querySelector("input");
            if (input) void openApp(input.value);
          }}>
            <input aria-label="Passphrase" autoComplete="current-password" className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100" required type="password" />
            <button className="rounded bg-cyan-700 px-4 py-2 font-semibold" type="submit">Open page</button>
          </form>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-300" role="alert">{error}</p> : null}
        <p className="mt-4 text-sm text-neutral-400">The decryption key stays in the URL fragment and is not sent to Lakebed.</p>
      </section>
    </main>
  );
}
`;
}

function createServer() {
  return `import { capsule } from "lakebed/server";

export default capsule({
  name: "Encrypted HTML",
  schema: {},
  queries: {},
  mutations: {},
});
`;
}

async function writeExclusive(file, text) {
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
  await chmod(file, 0o600);
}

async function writeUpdateBinding(capsulePath, record) {
  if (record.claimToken) {
    const directory = path.join(capsulePath, ".lakebed");
    await mkdir(directory, { mode: 0o700 });
    await writeExclusive(path.join(directory, "deploy.json"), `${JSON.stringify({
      api: record.api,
      claimToken: record.claimToken,
      deployId: record.deployId,
      updatedAt: record.updatedAt,
      url: record.hostedUrl,
    })}\n`);
    return;
  }
  await writeExclusive(path.join(capsulePath, "lakebed.json"), `${JSON.stringify({ deployId: record.deployId })}\n`);
}

async function createCapsule(encrypted, passphraseConfig, previous) {
  const capsulePath = await mkdtemp(path.join(os.tmpdir(), "lakebed-share-"));
  try {
    await chmod(capsulePath, 0o700);
    await mkdir(path.join(capsulePath, "client"), { mode: 0o700 });
    await mkdir(path.join(capsulePath, "server"), { mode: 0o700 });
    await writeExclusive(path.join(capsulePath, "client", "index.tsx"), createEncryptedClient(encrypted, passphraseConfig));
    await writeExclusive(path.join(capsulePath, "server", "index.ts"), createServer());
    if (previous) await writeUpdateBinding(capsulePath, previous);
    return capsulePath;
  } catch (error) {
    await rm(capsulePath, { recursive: true, force: true });
    throw error;
  }
}

async function readHtml(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`Unable to inspect HTML file: ${filePath}`);
  }
  if (!info.isFile()) throw new Error(`HTML path is not a file: ${filePath}`);
  if (info.size > MAX_HTML_BYTES) throw new Error(`HTML file exceeds the ${MAX_HTML_BYTES}-byte limit. Use one self-contained HTML file and remove unnecessary assets or generated data.`);
  const html = await readFile(filePath);
  if (html.byteLength > MAX_HTML_BYTES) throw new Error(`HTML file exceeds the ${MAX_HTML_BYTES}-byte limit. Use one self-contained HTML file and remove unnecessary assets or generated data.`);
  return html;
}

async function publish(file, options) {
  validateName(options.name);
  const sourcePath = path.resolve(file);
  const html = await readHtml(sourcePath);
  checkExternalReferences(collectExternalReferences(html.toString("utf8")), options.allowExternal);

  const found = await readRecord(options.name);
  const previous = options.forceNew ? undefined : found;
  if (found && !found.passphrase && options.passphraseEnv && !options.forceNew) {
    throw new Error("This share has no passphrase. Use --new to add passphrase protection.");
  }
  const passphrase = options.passphraseEnv ? getPassphrase(options.passphraseEnv) : undefined;
  if (found?.passphrase && !passphrase) throw new Error("This share uses a passphrase. Supply --passphrase-env with that passphrase before publishing.");

  const api = resolveApi(options.api, found, options.forceNew);
  const secret = previous ? Buffer.from(previous.secret, "base64url") : randomBytes(32);
  const passphraseConfig = previous
    ? previous.passphrase
    : passphrase
      ? { salt: randomBytes(16).toString("base64"), iterations: PASSPHRASE_ITERATIONS }
      : null;
  if (passphraseConfig && !passphrase) throw new Error("A passphrase is required to publish this share.");
  const encrypted = encryptHtml(html, secret, passphraseConfig, passphrase);
  const now = new Date().toISOString();
  const binding = previous ? { ...previous, updatedAt: now } : undefined;
  const capsulePath = await createCapsule(encrypted, passphraseConfig, binding);
  try {
    const deploy = await runDeploy(capsulePath, api, options.passphraseEnv);
    if (previous && deploy.deployId !== previous.deployId) {
      throw new Error(`Lakebed updated an unexpected deployment (${deploy.deployId}); expected ${previous.deployId}.`);
    }
    if (previous && deploy.url !== previous.hostedUrl) {
      throw new Error("Lakebed changed the hosted URL while updating this share. The stored URL was left unchanged to prevent an accidental secret rotation.");
    }
    if (!previous && !deploy.claimed && !deploy.claimToken) {
      throw new Error("Lakebed created an anonymous deployment without a claim token, so this share cannot be safely republished.");
    }
    const record = {
      version: 1,
      name: options.name,
      api,
      deployId: deploy.deployId,
      hostedUrl: previous?.hostedUrl ?? deploy.url,
      claimToken: deploy.claimed === true ? null : deploy.claimToken ?? previous?.claimToken ?? null,
      secret: secret.toString("base64url"),
      passphrase: passphraseConfig,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      expiresAt: deploy.expiresAt !== undefined ? deploy.expiresAt : previous?.expiresAt ?? null,
    };
    await saveRecord(record);
    const receipt = {
      name: record.name,
      url: `${record.hostedUrl}#${record.secret}`,
      deployId: record.deployId,
      reused: previous !== undefined,
      claimed: deploy.claimed ?? record.claimToken === null,
      expiresAt: record.expiresAt,
      passphrase: record.passphrase !== null,
      bytes: html.byteLength,
    };
    process.stdout.write(`${options.json ? JSON.stringify(receipt) : receipt.url}\n`);
    if (!receipt.claimed) {
      process.stderr.write(`This deploy is unclaimed and expires at ${record.expiresAt ?? "an unknown time"}. Run \`npx -y lakebed@0.0.40 auth login\` before publishing to make deploys permanent.\n`);
    }
  } finally {
    await rm(capsulePath, { recursive: true, force: true });
  }
}

async function listRecords(json) {
  const directory = await ensureStateDirectory();
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -5);
    if (!NAME_PATTERN.test(name)) continue;
    const record = await readRecord(name);
    if (!record) continue;
    records.push({
      name: record.name,
      hostedUrl: record.hostedUrl,
      claimed: record.claimToken === null,
      expiresAt: record.expiresAt,
      updatedAt: record.updatedAt,
    });
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  if (json) process.stdout.write(`${JSON.stringify(records)}\n`);
  else if (records.length === 0) process.stdout.write("No Lakebed shares.\n");
  else for (const record of records) {
    process.stdout.write(`${record.name}  ${record.hostedUrl}  claimed=${record.claimed}  expiresAt=${record.expiresAt ?? "none"}  updatedAt=${record.updatedAt}\n`);
  }
}

async function printUrl(name) {
  const record = await readRecord(name);
  if (!record) throw new Error(`No local record exists for ${name}.`);
  process.stdout.write(`${record.hostedUrl}#${record.secret}\n`);
}

async function forget(name) {
  const directory = await ensureStateDirectory();
  try {
    await unlink(recordPath(directory, name));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No local record exists for ${name}.`);
    throw error;
  }
  process.stdout.write(`Forgot local record ${name}. The remote deploy keeps serving until it expires or is terminated with lakebed deploy terminate.\n`);
}

function printHelp() {
  process.stdout.write(`lakebed-share\n\n  publish <file.html> --name <slug> [--new] [--passphrase-env VAR] [--api <origin>] [--allow-external] [--json]\n  list [--json]\n  url <name>\n  forget <name>\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") printHelp();
  else if (parsed.command === "publish") await publish(parsed.file, parsed.options);
  else if (parsed.command === "list") await listRecords(parsed.json);
  else if (parsed.command === "url") await printUrl(parsed.name);
  else if (parsed.command === "forget") await forget(parsed.name);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to complete Lakebed share operation."}\n`);
    process.exitCode = 1;
  });
}
