const test = require('brittle')
const Hyperschema = require('hyperschema')
const HRPC = require('hrpc')
const generateC = require('../lib/codegen')

// Generated output is verified by the snapshot test (test/snapshot.test.js).
// These cover the error paths a snapshot can't show.

test('duplicate command short-name throws', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
  ns.register({
    name: 'hello-response',
    fields: [{ name: 'greeting', type: 'uint', required: true }]
  })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  // A second handler whose short name collides with the first.
  hrpc.handlers.push({
    id: 9,
    name: '@other/hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  t.exception(() => generateC(hrpc, { schemaTarget: 'greeter_schema' }), /DUPLICATE_COMMAND_NAME/)
})

test('stream handler is rejected in this version', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'tick', fields: [{ name: 'n', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'watch',
    request: { name: '@greeter/tick', stream: false },
    response: { name: '@greeter/tick', stream: true }
  })
  t.exception(() => generateC(hrpc, { schemaTarget: 'greeter_schema' }), /UNSUPPORTED_HANDLER/)
})
