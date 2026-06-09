# Contributing to merchant

Thank you for considering a contribution. This document covers setup, testing, and PR conventions.

## Setup

```bash
git clone https://github.com/armincerf/merchant
cd merchant
npm install
```

Dependencies: Node 22+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

## Development

```bash
npm run dev        # wrangler dev — starts local Worker + DO
```

On first run, generate initial API keys:

```bash
npx tsx scripts/init.ts
```

Optionally seed demo products:

```bash
npx tsx scripts/seed.ts http://localhost:8787 sk_your_admin_key
```

## Testing

```bash
npm test           # run all tests once
npm run test:watch # watch mode
```

Tests run inside a real `workerd` runtime via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/). This means each test exercises the actual Durable Object and SQLite layer — not mocks. A test that passes locally will behave identically on Cloudflare's infrastructure.

Test files live in `test/`. Each file covers one feature area (e.g. `test/cart.test.ts`, `test/idempotency.test.ts`). Add tests for any behavior change.

## Typecheck & Lint

```bash
npm run typecheck  # tsc --noEmit — no errors allowed
npm run lint       # Biome check
npm run lint:fix   # Biome check --write (auto-fix)
npm run format     # Biome format --write
```

CI runs typecheck, lint, and tests on every push. All three must pass before a PR can be merged.

## Architecture Orientation

All database mutations go through `MerchantDO` in `src/do.ts`. Multi-step mutations — cart item reservation, order finalization, inventory deduction, discount application — are implemented as synchronous DO methods using `ctx.storage.transactionSync`. This keeps them atomic without any distributed-transaction machinery.

**Before adding a route handler that does multiple DB writes, implement the mutation as a typed method on `MerchantDO` and call it via the DO stub.** Route handlers should orchestrate (validate input, call DO, return response) rather than contain raw SQL sequences.

See the [README architecture section](README.md#architecture) for the full data-flow diagram.

## Pull Request Conventions

- **Conventional commits.** Use `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`. If you are working from a tracked issue, include the issue id: `feat(merchant-abc): add X`.
- **Keep tests green.** Run `npm run typecheck && npm run lint && npm test` before pushing.
- **One concern per PR.** Mixing a feature and unrelated refactoring makes review harder.
- **Add tests for new behavior.** Bug fixes should come with a test that reproduces the bug.
- **No source-code changes in a docs-only PR** and vice versa.

## Reporting Issues

Open a GitHub issue. Include: what you expected, what you got, reproduction steps, and your Wrangler version (`wrangler --version`).
