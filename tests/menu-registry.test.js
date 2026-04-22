const assert = require('assert')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// Reset registry between tests by re-requiring fresh module
const freshRegistry = () => {
  delete require.cache[require.resolve('../helpers/menu/registry')]
  return require('../helpers/menu/registry')
}

test('registerMenu stores screen and getMenu retrieves it', () => {
  const reg = freshRegistry()
  const screen = { id: 's:r', access: 'public', render: () => ({}), handle: () => {} }
  reg.registerMenu(screen)
  assert.strictEqual(reg.getMenu('s:r'), screen)
})

test('registerMenu throws on duplicate id', () => {
  const reg = freshRegistry()
  reg.registerMenu({ id: 'dup', access: 'public', render: () => ({}), handle: () => {} })
  assert.throws(
    () => reg.registerMenu({ id: 'dup', access: 'public', render: () => ({}), handle: () => {} }),
    /already registered/
  )
})

test('registerMenu validates required fields', () => {
  const reg = freshRegistry()
  assert.throws(() => reg.registerMenu({}), /id is required/)
  assert.throws(() => reg.registerMenu({ id: 'x' }), /access is required/)
  assert.throws(() => reg.registerMenu({ id: 'x', access: 'public' }), /render is required/)
  assert.throws(
    () => reg.registerMenu({ id: 'x', access: 'public', render: () => ({}) }),
    /handle is required/
  )
})

test('getMenu returns undefined for unknown id', () => {
  const reg = freshRegistry()
  assert.strictEqual(reg.getMenu('does-not-exist'), undefined)
})

test('listMenus returns ids of all registered screens', () => {
  const reg = freshRegistry()
  reg.registerMenu({ id: 'a', access: 'public', render: () => ({}), handle: () => {} })
  reg.registerMenu({ id: 'b', access: 'public', render: () => ({}), handle: () => {} })
  const ids = reg.listMenus()
  assert.deepStrictEqual(ids.sort(), ['a', 'b'])
})

const run = async () => {
  let passed = 0; let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name) }
    catch (e) { failed++; console.log('  ✗ ' + t.name); console.log('     ' + e.message) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
