const test = require('brittle')
const Hyperschema = require('hyperschema')
const HRPC = require('hrpc')
const generateC = require('../lib/codegen')

function unaryHRPC() {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({
    name: 'hello-request',
    fields: [{ name: 'id', type: 'uint', required: true }]
  })
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
  return hrpc
}

test('shared header declares the common error type and result enums', (t) => {
  const { shared } = generateC(unaryHRPC(), { schemaTarget: 'greeter_schema' })
  t.ok(shared.includes('#ifndef HRPC_H'))
  t.ok(shared.includes('typedef struct {'))
  t.ok(shared.includes('utf8_string_view_t message;'))
  t.ok(shared.includes('int64_t status;'))
  t.ok(shared.includes('} hrpc_error_t;'))
  t.ok(shared.includes('hrpc_ok = 0'))
  t.ok(shared.includes('hrpc_error_response = 1'))
  t.ok(shared.includes('hrpc_dispatch_reply = 0'))
  t.ok(shared.includes('hrpc_dispatch_no_reply = 1'))
  t.ok(shared.includes('hrpc_err_alloc = -1'))
  t.ok(shared.includes('hrpc_err_decode = -2'))
  t.ok(shared.includes('hrpc_err_unknown = -3'))
})

test('unary header declares encoder, error encoder, decoder, handler, dispatch', (t) => {
  const { header } = generateC(unaryHRPC(), { schemaTarget: 'greeter_schema' })
  t.ok(header.includes('#include "greeter_schema.h"'))
  t.ok(header.includes('#include "hrpc.h"'))
  t.ok(header.includes('#include <rpc.h>'))
  t.ok(header.includes('greeter_command_hello = 0'))
  t.ok(
    header.includes(
      'greeter_encode_hello (uint64_t id, const greeter_hello_request_t *args, uint8_t **out, size_t *out_len);'
    )
  )
  t.ok(
    header.includes(
      'greeter_encode_hello_error (uint64_t id, hrpc_error_t error, uint8_t **out, size_t *out_len);'
    )
  )
  t.ok(
    header.includes(
      'greeter_decode_hello_response (const rpc_message_t *msg, greeter_hello_response_t *result, hrpc_error_t *error);'
    )
  )
  t.ok(
    header.includes(
      'typedef int (*greeter_on_hello) (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error);'
    )
  )
  t.ok(header.includes('greeter_on_hello on_hello;'))
  t.ok(header.includes('} greeter_hrpc_handlers_t;'))
  t.ok(header.includes('greeter_hrpc_dispatch (const greeter_hrpc_handlers_t *handlers'))
})

test('unary source defines framing, encoders, decoder, dispatch', (t) => {
  const { source } = generateC(unaryHRPC(), { schemaTarget: 'greeter_schema' })
  t.ok(source.includes('#include "greeter_hrpc.h"'))
  t.ok(source.includes('greeter_hrpc__frame ('))
  t.ok(source.includes('int\ngreeter_encode_hello ('))
  t.ok(source.includes('greeter_hello_request_preencode'))
  t.ok(source.includes('msg.type = rpc_request;'))
  t.ok(source.includes('int\ngreeter_encode_hello_error ('))
  t.ok(source.includes('msg.error = true;'))
  t.ok(source.includes('int\ngreeter_hrpc_dispatch ('))
  t.ok(source.includes('case greeter_command_hello:'))
  t.ok(source.includes('greeter_hello_request_destroy(&req);'))
  t.ok(source.includes('greeter_hello_response_destroy(&res);'))
  t.ok(source.includes('hrpc_dispatch_reply'))
  t.ok(source.includes('return hrpc_err_unknown;'))
})

test('command ids come from hrpc.json (global, append-only)', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'a-req', fields: [{ name: 'id', type: 'uint', required: true }] })
  ns.register({ name: 'b-req', fields: [{ name: 'id', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  const rpc = hrpc.namespace('greeter')
  rpc.register({
    name: 'first',
    request: { name: '@greeter/a-req', stream: false },
    response: { name: '@greeter/b-req', stream: false }
  })
  rpc.register({
    name: 'second',
    request: { name: '@greeter/b-req', stream: false },
    response: { name: '@greeter/a-req', stream: false }
  })

  const { header } = generateC(hrpc, { schemaTarget: 'greeter_schema' })
  t.ok(header.includes('greeter_command_first = 0'))
  t.ok(header.includes('greeter_command_second = 1'))
})

test('duplicate command short-name throws', (t) => {
  const hrpc = unaryHRPC()
  // Force a second handler whose short name collides with the first.
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
