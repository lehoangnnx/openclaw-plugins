# OpenClaw Plugins & Skills

> Community **plugins** and **skills** for [OpenClaw](https://github.com/openclaw/openclaw) — extend your AI agent with new tools, channels, and capabilities. Install via [ClawHub](https://docs.openclaw.ai/clawhub).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A monorepo of OpenClaw extensions. Everything here is an **external plugin** or
**skill** — it never patches OpenClaw core, so it survives upstream updates.

## Catalog

### Plugins

| Plugin | What it does | Install |
| ------ | ------------ | ------- |
| [`googlechat-history`](./plugins/googlechat-history) | Read past messages from a Google Chat space (`spaces.messages.list`) — history the bot never received via @mention. | `openclaw plugins install clawhub:lehoangnnx/googlechat-history` |

### Skills

| Skill | What it does |
| ----- | ------------ |
| [`space-context`](./skills/space-context) | Teaches the agent to pull Google Chat space history before answering questions about a space. |

## Quick start

```bash
# From ClawHub (recommended)
openclaw plugins install clawhub:lehoangnnx/googlechat-history

# Or from a local checkout (development)
pnpm install && pnpm -r build
openclaw plugins install ./plugins/googlechat-history
openclaw gateway restart
```

Then allow the tool (optional tools require opt-in) in `openclaw.json`:

```json5
{
  plugins: { allow: ["googlechat-history"] },
  tools: { allow: ["googlechat_history"] }
}
```

## Develop

```bash
pnpm install
pnpm -r build       # build all packages to dist/
pnpm -r typecheck
```

Each plugin is an independent npm package under [`plugins/`](./plugins). Skills are
plain `SKILL.md` directories under [`skills/`](./skills).

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the OpenClaw docs:
[Building plugins](https://docs.openclaw.ai/plugins/building-plugins) ·
[Creating skills](https://docs.openclaw.ai/tools/creating-skills) ·
[ClawHub](https://docs.openclaw.ai/clawhub).

## License

[MIT](./LICENSE) © Nguyen Le Hoang
