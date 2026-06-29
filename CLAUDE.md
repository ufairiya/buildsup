# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies
pnpm install

# Run all apps in dev mode
pnpm dev

# Run a single app
pnpm --filter web dev        # Next.js web app on http://localhost:3000
pnpm --filter mobile start   # Expo mobile app

# Build all
pnpm build

# Lint all
pnpm lint

# Type check all
pnpm type-check

# Run a command in a specific package
pnpm --filter web <command>
pnpm --filter mobile <command>
pnpm --filter @buildsup/shared <command>
```

## Architecture

Turborepo monorepo with two apps and one shared package:

```
apps/
  web/      Next.js 16 (App Router, Tailwind CSS, TypeScript)
  mobile/   Expo (React Native, TypeScript)
packages/
  shared/   Shared TypeScript types (@buildsup/shared)
```

**Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime) — cloud only. No custom API server.

**Supabase clients:**
- `apps/web/lib/supabase/client.ts` — browser client (use in Client Components)
- `apps/web/lib/supabase/server.ts` — server client (use in Server Components, Route Handlers)
- `apps/mobile/lib/supabase.ts` — singleton client for React Native

**Shared types** (`packages/shared/src/types.ts`) define the four core domains: `materials`, `chemicals`, `services`, `labour` — each listing has a `type` of either `availability` or `requirement`.

**Environment variables:** Copy `.env.example` to `.env.local` (web) and `.env` (mobile) and fill in Supabase credentials from https://supabase.com/dashboard. Never commit `.env*` files.

## MCP Tools: code-review-graph

**IMPORTANT: Always use code-review-graph MCP tools BEFORE Grep/Glob/Read to explore the codebase.**

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |

## Change Log

All changes to files must be documented in `CHANGELOG.md` at the project root. Each entry must include the file modified, line numbers affected, and the code added, changed, or deleted.
