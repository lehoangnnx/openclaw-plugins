# Contributing

Thanks for helping grow the OpenClaw plugin & skill ecosystem.

## Layout

- `plugins/<id>/` — one npm package per plugin. Must have `package.json`
  (with an `openclaw` field) and `openclaw.plugin.json` (the manifest).
  Runtime entry points at built JS in `dist/` (`pnpm build`).
- `skills/<name>/SKILL.md` — a skill: YAML frontmatter (`name`, `description`)
  plus markdown instructions. No build step.

## Authoring a plugin

1. `pnpm install`
2. Copy an existing plugin under `plugins/` as a starting point.
3. Import the SDK from focused subpaths only:
   `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";`
4. Declare every registered tool in `openclaw.plugin.json` `contracts.tools`.
5. Pin `openclaw.compat` / `openclaw.build` versions to the OpenClaw release you target.
6. `pnpm -r build && pnpm -r typecheck`, then test locally:
   `openclaw plugins install ./plugins/<id> && openclaw gateway restart`
7. Ship a lockfile for publishable packages: `cd plugins/<id> && npm shrinkwrap`.

## Publishing

```bash
clawhub package publish lehoangnnx/<id> --dry-run
clawhub package publish lehoangnnx/<id>
```

## References

- https://docs.openclaw.ai/plugins/building-plugins
- https://docs.openclaw.ai/plugins/manifest
- https://docs.openclaw.ai/tools/creating-skills
- https://docs.openclaw.ai/clawhub
