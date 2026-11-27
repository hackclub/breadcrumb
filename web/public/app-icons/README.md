# Application icons

These 64px PNGs were extracted from locally installed application bundles for identifying those applications in Breadcrumb's activity dashboard. Application names, logos, and trademarks belong to their respective owners; they are not relicensed under Breadcrumb's AGPL license. Official project links and bundle/name aliases are recorded in `web/lib/app-seed.json`.

Add a PNG and a catalog entry there, then run `bun --env-file=.env.local scripts/app-catalog.ts` from `web/` to update the PostgreSQL catalog. Icons are served from this website; viewing your activity does not request images from third-party icon services.

## Coding agents and model makers

The coding-agent usage view marks each agent and model family with its maker's icon, resized to 64px from the official site's icon: `claude.png` (the orange spark from claude.com, without its tile), `openai.png` (openai.com, for GPT models), `grok.png` (grok.com), `opencode.png` (opencode.ai), `antigravity.png` (antigravity.google), `gemini.png` (gemini.google.com), `zai.png` (z.ai, for GLM models) and `inception.png` (inceptionlabs.ai, for Mercury models). Codex reuses `codex.png`. The mapping lives in `web/lib/agent-icons.ts`.
