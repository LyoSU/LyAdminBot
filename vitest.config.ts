import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tsc --build emits compiled tests into dist/ — never run those.
    // .worktrees holds detached git worktrees (v1 snapshots) with their own
    // unrelated suites — exclude so `npm test` stays green and v2-only.
    exclude: ['**/node_modules/**', '**/dist/**', '.worktrees/**']
  }
})
