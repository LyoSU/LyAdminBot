import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tsc --build emits compiled tests into dist/ — never run those.
    exclude: ['**/node_modules/**', '**/dist/**']
  }
})
