# Global agent instructions

Shared by every harness: Claude Code imports this file from `~/.claude/CLAUDE.md`,
Codex reads it as `$CODEX_HOME/AGENTS.md`, and OpenCode lists it in
`opencode.json` `instructions`. Shared skills live in `~/.agents/skills`.

When working in typescript:

- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid explicit return types unless absolutely needed
- `as any` should be an absolute last resort. always use real type safety. lean on type inference instead of manually writing new types over and over again

When working in svelte(kit):

- use modern svelte practices (Svelte 5 runes)

When publishing web apps:

- to show a diagram, table, or mockup inside a T3 thread, use T3's `html_render`
- to share an HTML page privately outside the thread, load the `lakebed-share` skill; it encrypts locally and the full URL is a secret
- when the user explicitly authorizes secrets in an encrypted share, secrets may be included only in the self-contained HTML passed to `lakebed-share`; never in an ordinary Lakebed capsule, a commit, logs, or tool output

When delegating to subagents:

- prefer the T3 Code orchestrator: call `orchestrator_capabilities` first and delegate with `delegate_task`
- targets below read `<providerInstanceId>/<model> <option>=<value>`; split at the first `/`, and pass the options as `target.options`
- default child target: `opencode/skid/opencode-go/deepseek-v4.1-flash variant=high`; this model offers `low`, `high` and `max` only, so `high` is the ceiling here
- on OpenCode, use `skid/opencode-go/*` for OpenCode Go and `skid/refuseless/*` for Refuseless; never `opencode/*` (Zen), which fails with insufficient funds
- never pick a Gemini model; run Claude children on T3's `claudeAgent` provider only, because other Claude routes bill paid extra usage
- Claude Fable is allowed when the user asks for it or the task needs its depth; otherwise prefer Opus, which costs less
- use the harness's native subagent tool only when T3 is unavailable; state the reason when you fall back
- never request `max` effort, and never enable fast mode or a priority service tier, unless the user instructs it; `xhigh` is the ceiling
- check every target above against `orchestrator_capabilities` at call time; if one is missing, report it instead of guessing another

When using tstack skills (`council`, `sol-loop`, `full-send`, and the rest):

- the council, and the `pstack-interrogate` reviewers, are `claudeAgent/claude-opus-5-5 effort=xhigh`, `codex/gpt-6.1-sol reasoningEffort=xhigh`, and `opencode/skid/opencode-go/mimo-v2.6-pro`; only frontier-class models sit on it, so never seat DeepSeek V4.1 Flash, GPT-6 Luna, GLM-5.3-Flash or another budget model
- never add a Gemini model to the council, not even as a jester
- `sol-loop` reviews with `codex/gpt-6.1-sol reasoningEffort=xhigh`, and `full-send` calls it as written; if `orchestrator_capabilities` lacks that target, `sol-loop` reports the blocker, and in `full-send`, run `council` where it says `sol-loop`

When running shell commands:

- these are Daniel's preferences: `rg` over `grep` and `fd` over `find`; where a newer replacement for a classic tool is installed (check with `command -v`), use it, and fall back to the classic tool when it is not
- keep scripts committed to a repository on tools every machine has
- avoid passing `-a`/`--binary` to `rg` unless the search term is in binary files; with it, rg reads disk images and other large binaries as text, and holds each run without a line break in memory, which can be gigabytes

In general:

- when asking questions, ask them one at a time
- never write em dashes (`—`) in chat replies, commit messages, pull request text, docs, code comments or any other output; use a comma, colon, parentheses or a new sentence instead

When a task needs root:

- where `sudo` is passwordless for your account, use it for the task at hand without asking
- on an interactive desktop, use `sudo` only through its visible authorization prompt, and say what each command is for
- never feed a password to `sudo` or `run0`, including one from a secret store, and never bypass the prompt

When you need temporary files:

- keep them in your harness's scratch space: Claude Code's session scratchpad, or your own subdirectory of `/tmp/opencode` in OpenCode; never loose in `/tmp`
- delete what you created before handing back, unless the user needs it; then say where it is
- files there untouched for 3 days are deleted automatically, so never keep anything there that must last

When committing:

- commit unsigned, and never trigger a signing prompt; Daniel's signing key is a YubiKey that needs a touch for every signature
- in a repository with a GitHub remote, work on a branch and land it through a pull request; Daniel's squash merge on GitHub produces a GitHub-signed commit on the default branch
- write every commit message and pull request title as a Conventional Commit (`type(scope): summary`, e.g. `feat(services): …`, `fix(ci): …`, `docs: …`); the squash merge uses the PR title as the commit on the default branch
- check the current branch before committing, and never commit or push to the default branch
