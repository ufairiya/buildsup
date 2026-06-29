# Changelog

## 2026-06-29 — Monorepo scaffold

### Summary
Initialized Turborepo monorepo with Next.js web app, Expo mobile app, and shared types package.

### Files generated (scaffold-level summary)

| Path | Tool | Purpose |
|------|------|---------|
| `package.json` | hand-written | Root workspace config, Turborepo scripts |
| `pnpm-workspace.yaml` | hand-written | pnpm workspace definitions |
| `turbo.json` | hand-written | Turborepo pipeline (dev, build, lint, type-check) |
| `.npmrc` | hand-written | `node-linker=hoisted` for Expo/Metro compatibility |
| `.gitignore` | hand-written | Updated with node_modules, .next, .expo, .env*, .turbo |
| `.env.example` | hand-written | Supabase env var template |
| `apps/web/` | `pnpm create next-app` | Next.js 16, App Router, TypeScript, Tailwind CSS, ESLint |
| `apps/mobile/` | `pnpm create expo-app` | Expo blank-typescript template |
| `apps/web/lib/supabase/client.ts` | hand-written | Supabase browser client for Next.js Client Components |
| `apps/web/lib/supabase/server.ts` | hand-written | Supabase server client for Next.js Server Components |
| `apps/mobile/lib/supabase.ts` | hand-written | Supabase singleton client for React Native |
| `packages/shared/src/types.ts` | hand-written | Shared domain types: Listing, User, ListingCategory, ListingType |
| `packages/shared/src/index.ts` | hand-written | Package exports |
| `packages/shared/package.json` | hand-written | Package config for @buildsup/shared |
| `packages/shared/tsconfig.json` | hand-written | TypeScript config for shared package |
| `CLAUDE.md` | hand-written | Updated with commands and architecture |
