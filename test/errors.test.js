const test = require('brittle')
const errors = require('../lib/errors')

test('error factory sets code and message', (t) => {
  const e = errors.UNSUPPORTED_TYPE('bad type')
  t.is(e.code, 'UNSUPPORTED_TYPE')
  t.is(e.name, 'CodegenError')
  t.ok(e.message.includes('bad type'))
})
