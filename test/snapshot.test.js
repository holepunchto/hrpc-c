const test = require('brittle')
const Hyperschema = require('hyperschema')
const CHRPC = require('..')

// A schema exercising the generator's breadth: two namespaces (so the target
// name joins them and command ids are global), several unary commands, one
// send-only event, and request/response structs over different field types.
// The snapshot captures the exact generated C, so any codegen change shows up
// as a reviewable diff. Unlike the e2e test it needs no C toolchain, so it
// guards the generator anywhere bare-make can't run.
// Refresh with `rm test/fixtures/snapshot.test.snapshot.cjs` and re-run.
function buildHRPC() {
  const schema = new Hyperschema()

  const greeter = schema.namespace('greeter')
  greeter.register({
    name: 'hello-request',
    fields: [{ name: 'id', type: 'uint', required: true }]
  })
  greeter.register({
    name: 'hello-response',
    fields: [{ name: 'greeting', type: 'string', required: true }]
  })
  greeter.register({
    name: 'echo',
    fields: [{ name: 'text', type: 'string', required: true }]
  })
  greeter.register({
    name: 'ping',
    fields: [{ name: 'seq', type: 'uint', required: true }]
  })
  greeter.register({
    name: 'watch-request',
    fields: [{ name: 'since', type: 'uint', required: true }]
  })
  greeter.register({
    name: 'log-event',
    fields: [{ name: 'seq', type: 'uint', required: true }]
  })

  const admin = schema.namespace('admin')
  admin.register({
    name: 'ban-request',
    fields: [
      { name: 'user', type: 'uint', required: true },
      { name: 'reason', type: 'string' }
    ]
  })
  admin.register({
    name: 'ban-response',
    fields: [{ name: 'ok', type: 'bool', required: true }]
  })

  const hrpc = new CHRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  hrpc.namespace('greeter').register({
    name: 'echo',
    request: { name: '@greeter/echo', stream: false },
    response: { name: '@greeter/echo', stream: false }
  })
  hrpc.namespace('greeter').register({
    name: 'ping',
    request: { name: '@greeter/ping', send: true }
  })
  hrpc.namespace('greeter').register({
    name: 'watch',
    request: { name: '@greeter/watch-request', stream: false },
    response: { name: '@greeter/log-event', stream: true }
  })
  hrpc.namespace('admin').register({
    name: 'ban',
    request: { name: '@admin/ban-request', stream: false },
    response: { name: '@admin/ban-response', stream: false }
  })
  return hrpc
}

// CMake output is asserted in disk.test.js, not snapshotted here: its comment
// contains backticks, which brittle's snapshot serializer can't round-trip
// (it emits an invalid multi-line single-quoted string).
test('codegen snapshot', (t) => {
  const { shared, header, source } = buildHRPC().toCode()
  t.snapshot(shared, 'shared hrpc.h')
  t.snapshot(header, 'target header')
  t.snapshot(source, 'target source')
})
