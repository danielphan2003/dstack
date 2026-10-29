---
name: wattpad-archiver
description: |
  Use when the user wants to download, archive, back up, or export their Wattpad library or Bookshelf as EPUB files. Runs Daniel's wattpad-archiver CLI or its MCP server: token handling, a safe first run, and incremental updates.
license: MIT
compatibility: Needs Node 24, pnpm, network access to wattpad.com, and the user's Wattpad username and `token` cookie.
metadata:
  harness: [claude, codex, opencode]
  platform: [linux]
  scope: fleet
  origin: "local"
  requires: "Node 24, pnpm, a Wattpad username and token cookie (stored by `login`)"
---

# Wattpad Archiver

Archives the library of one Wattpad account as one EPUB per story. The tool is [danielphan2003/wattpad-archiver](https://github.com/danielphan2003/wattpad-archiver) (MIT), a TypeScript rewrite of MRtecno98/wattpad-archiver. Its README has the full reference.

```bash
git clone https://github.com/danielphan2003/wattpad-archiver.git ~/src/github.com/danielphan2003/wattpad-archiver   # once
cd ~/src/github.com/danielphan2003/wattpad-archiver
pnpm install && pnpm build          # once, and after pulling changes
node dist/bin.mjs --help
```

The upstream Python tool is not used: it read a `total` field that comes back as 0 and archived one default page of 9 stories from a library of 629.

## Token

The tool authenticates with the `token` cookie of a logged-in Wattpad session. Treat it as a password.

- It is an `HttpOnly` cookie, so neither page scripts nor the T3 browser tools can read it, even in a logged-in tab. The username is available from the profile link in the account dropdown of that tab; the token is not.
- Daniel's account and token are stored in `~/.config/wattpad-archiver` (`username` and `token`, mode 0600), which the tool reads when no flag or environment variable is set. Check for those files before asking for anything.
- If they are missing or Wattpad rejects the token, never ask for it in chat. Call T3's `request_secret` with `delivery: "file"`, tell the user to copy `token` from DevTools, Application, Cookies, then run `node dist/bin.mjs login -u <username> --token-file <returned-path>` and delete the returned file. The tool refuses a stored token that other accounts can read.
- The tool never takes the token as a flag or an MCP argument and never prints it. It sends it to `https://www.wattpad.com`, and to another `wattpad.com` host only as a retry after a 401 or 403. Public chapters and images need no token.
- If Wattpad rejects it, the message says so; the user logs in again for a fresh one.

## Running it

```bash
node dist/bin.mjs list --pending                  # also checks the token
node dist/bin.mjs archive -o <output-dir> --max-stories 5
node dist/bin.mjs archive -o <output-dir>         # everything new or changed
node dist/bin.mjs archive -o <output-dir> --story <id>
```

Pass `-u` or `--token-file` (or the matching `WATTPAD_*` variables) only to override the stored login.

1. Start with `list --pending` to see the size, then a small `--max-stories` run to prove the token and output work.
2. A full first run costs about one request per chapter plus images: a 629-story, 29,891-chapter library is roughly 30,000 requests, about 35 minutes at the default 15 requests per second. Confirm with the user before starting one, and run it in the background.
3. Do not raise `--rate` without being asked. The tool slows itself down on `429`, but a ban affects the user's account IP.
4. `archive` prints one summary line, plus a line per failed story, and exits non-zero if a story failed. Images it could not download are counted in the summary. Chapters that could not be downloaded leave the story marked partial and it is retried on the next run.
5. Reruns are cheap: stories whose modification date and chapter count match the state log in `<output>/.wattpad-archiver/state.jsonl` are skipped.

## MCP

`node dist/bin.mjs mcp` serves `wattpad_library` and `wattpad_archive` over stdio. Credentials come from the config directory (or `WATTPAD_USERNAME` and `WATTPAD_TOKEN_FILE`), and the output directory from `WATTPAD_OUTPUT`; none come from tool arguments. An archive call with no `storyIds` is capped at 10 stories. Registering the server in a harness is a config change; do it only when asked.

## After the run

Tell the user the output path, the summary line, and any failed or partial stories. The EPUBs are personal copies of the user's own library: do not upload, share, or publish them unless asked.
