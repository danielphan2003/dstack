# dstack

The agent skills and global instructions I use every day with Claude Code,
Codex and OpenCode, mostly through [T3 Code](https://t3.codes).

This repository is a mirror. The files live in my private infrastructure
repository and are copied here after each change, so pull requests cannot be
merged here; issues are welcome.

## Contents

| Path | What it is |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | My global instructions, read by every harness. They name my own models, providers and habits, so read them as an example rather than copying them. |
| [`CLAUDE.md`](CLAUDE.md) | Imports `AGENTS.md` for Claude Code. |
| [`skills/`](skills) | One folder per skill, each with a `SKILL.md`. |

Each `SKILL.md` carries a `metadata` block: `harness` lists the agents it is
meant for, `requires` what must exist for it to work, and `origin` where it
came from.

## Using a skill

Copy or link a skill folder into your harness's skills directory:

```sh
ln -s "$PWD/skills/council" ~/.claude/skills/council   # Claude Code
ln -s "$PWD/skills/council" ~/.agents/skills/council   # Codex, OpenCode
```

## Credits

Some skills are copies of other people's work, kept with their licenses:

| Skills | Source | License |
| --- | --- | --- |
| `babysit-pr`, `council`, `file-pr`, `full-send`, `full-stop`, `leaving-pr-comments`, `modernize`, `sol-loop`, `takeover` | Theo Browne's [tstack](https://github.com/t3dotgg/tstack) | MIT, in each folder |
| `pstack-*` | Lauren Tan's pstack, via [t3-pstack](https://github.com/chhoumann/t3-pstack) | MIT, in each folder |

The rest (`effect`, `lakebed-share`) are mine. Every skill is under the MIT license; each folder carries its own `LICENSE`.
