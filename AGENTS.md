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
- default child target: `opencode/opencode-go/gpt-6-luna variant=xhigh`; the Codex quota is exhausted until 2026-11-18 03:51, after which use `codex/gpt-6-luna reasoningEffort=xhigh`
- use `opencode-go/*` models on OpenCode, never `opencode/*` (Zen), which fails with insufficient funds
- never pick a Gemini model or Claude Fable (this plan cannot run Fable); run Claude children on T3's `claudeAgent` provider only, because other Claude routes bill paid extra usage
- use the harness's native subagent tool only when T3 is unavailable; state the reason when you fall back
- never request `max` effort, and never enable fast mode or a priority service tier, unless the user instructs it; `xhigh` is the ceiling
- check every target above against `orchestrator_capabilities` at call time; if one is missing, report it instead of guessing another

When using tstack skills (`council`, `sol-loop`, `full-send`, and the rest):

- the council, and the `pstack-interrogate` reviewers, are `claudeAgent/claude-opus-5-5 effort=xhigh`, `opencode/opencode-go/mimo-v2.6-pro`, and `opencode/opencode-go/glm-5.3-flash`; only frontier-class models sit on it, so never seat GPT-6 Luna or another budget model
- never add a Gemini model to the council, not even as a jester
- this account's plan has no GPT Sol, so `sol-loop` reports that blocker; in `full-send`, run `council` where it says `sol-loop`

In general:

- when asking questions, ask them one at a time

When you need temporary files:

- keep them in your harness's scratch space: Claude Code's session scratchpad, or your own subdirectory of `/tmp/opencode` in OpenCode; never loose in `/tmp`
- delete what you created before handing back, unless the user needs it; then say where it is
- files there untouched for 3 days are deleted automatically, so never keep anything there that must last

When committing:

- commit unsigned, and never trigger a signing prompt; Daniel's signing key is a YubiKey that needs a touch for every signature
- in a repository with a GitHub remote, work on a branch and land it through a pull request; Daniel's squash merge on GitHub produces a GitHub-signed commit on the default branch
- write every commit message and pull request title as a Conventional Commit (`type(scope): summary`, e.g. `feat(services): …`, `fix(ci): …`, `docs: …`); the squash merge uses the PR title as the commit on the default branch
- check the current branch before committing, and never commit or push to the default branch
