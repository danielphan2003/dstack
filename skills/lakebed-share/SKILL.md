---
name: lakebed-share
description: Use only to share an HTML page outside the current T3 thread, privately with end-to-end encryption. For a visual inside a T3 thread, use T3's html_render instead.
metadata:
  harness: [claude, codex, opencode]
  platform: [linux]
  scope: fleet
  origin: "local"
  requires: "Node 20+ and npx (lakebed@0.0.40)"
---

# Lakebed Share

Use this skill only when the user wants a private HTML share outside the current T3 thread. Use T3's `html_render` to show a visual inside the thread.

Publish one self-contained HTML file:

```sh
node <skill-dir>/scripts/share.mjs publish ./page.html --name my-share
```

Replace `<skill-dir>` with this skill's installed directory.

Use `--new` to rotate the key and create a new deployment. Pass `--passphrase-env NAME` to read a passphrase from the named environment variable. Never put a passphrase in command arguments. Use `--api https://api.example` only for an explicit Lakebed API origin. `--allow-external` warns and continues, but external resources will not work under the page CSP. Add `--json` for a machine-readable receipt.

Run `list` to view saved share names, hosted URLs, claim status, and expiry. Run `url <name>` to print its complete share URL. Run `forget <name>` to remove only the local record. The remote deployment continues serving until it expires or is terminated with `lakebed deploy terminate`.

The complete share URL is a secret. Anyone with it can decrypt the page unless a passphrase is set. Send a passphrase over a different channel. The encryption key stays in the URL fragment and is not sent to Lakebed.

Pages must be self-contained. Inline or embed CSS, JavaScript, and images. Do not use third-party scripts. Decrypted pages run in a sandbox and cannot make network requests. The plaintext source file stays in place after publishing.

Anonymous, unclaimed deployments expire. Run `npx -y lakebed@0.0.40 auth login` before publishing to make deployments permanent.

## Normal Lakebed capsule deploys

Normal capsule deploys are not end-to-end encrypted. Run `npx -y lakebed@0.0.40 deploy <dir> --json` only from a trusted project because the build imports and executes `server/index.ts`. Keep `.env.lakebed.server` and `.lakebed/` out of git. Use `--public-inspect` only when the user explicitly asks to make hosted data and logs public.
