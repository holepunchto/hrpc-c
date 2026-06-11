const test = require('brittle')
const { toCName, splitFqn, structFromRef, targetName, schemaTargetName } = require('../lib/naming')

test('toCName converts camelCase and kebab to snake_case', (t) => {
  t.is(toCName('myCount'), 'my_count')
  t.is(toCName('hello-request'), 'hello_request')
  t.is(toCName('id'), 'id')
})

test('splitFqn parses @ns/name', (t) => {
  t.alike(splitFqn('@greeter/hello'), { ns: 'greeter', name: 'hello' })
  t.exception(() => splitFqn('greeter/hello'))
})

test('structFromRef maps a type ref to its hyperschema-c struct base', (t) => {
  t.is(structFromRef('@greeter/hello-request'), 'greeter_hello_request')
  t.exception(() => structFromRef('string'), /UNSUPPORTED_TYPE/)
})

test('target names derive from namespaces', (t) => {
  const hrpc = { handlers: [{ name: '@greeter/hello' }] }
  t.is(targetName(hrpc), 'greeter_hrpc')
  t.is(schemaTargetName(hrpc), 'greeter_schema')
})
