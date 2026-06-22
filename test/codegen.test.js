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

test('response-stream: classify and generated declarations', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'watch-request', fields: [{ name: 'since', type: 'uint', required: true }] })
  ns.register({ name: 'log-event', fields: [{ name: 'seq', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'watch',
    request: { name: '@greeter/watch-request', stream: false },
    response: { name: '@greeter/log-event', stream: true }
  })

  const { shared, header, source } = generateC(hrpc, { schemaTarget: 'greeter_schema' })

  t.ok(shared.includes('hrpc_dispatch_stream = 2'), 'shared header adds stream dispatch code')
  t.ok(
    header.includes('greeter_encode_watch (uint64_t id, const greeter_watch_request_t *args'),
    'request encoder declared'
  )
  t.ok(header.includes('greeter_encode_watch_open (uint64_t id'), 'open encoder declared')
  t.ok(
    header.includes('greeter_encode_watch_stream_open (uint64_t id'),
    'open-echo encoder declared'
  )
  t.ok(
    header.includes('greeter_encode_watch_chunk (uint64_t id, const greeter_log_event_t *chunk'),
    'chunk encoder declared'
  )
  t.ok(header.includes('greeter_encode_watch_end (uint64_t id'), 'end encoder declared')
  t.ok(
    header.includes('greeter_encode_watch_error (uint64_t id, hrpc_error_t error'),
    'error encoder declared'
  )
  t.ok(
    header.includes(
      'greeter_decode_watch_chunk (const rpc_message_t *msg, greeter_log_event_t *out'
    ),
    'chunk decoder declared'
  )
  t.ok(
    header.includes(
      '(*greeter_on_watch) (void *ctx, const greeter_watch_request_t *req, uint64_t stream_id)'
    ),
    'handler typedef'
  )
  t.ok(source.includes('msg.stream = rpc_stream_open;'), 'open uses OPEN')
  t.ok(
    source.includes('msg.stream = rpc_stream_response | rpc_stream_open;'),
    'open echo uses RESPONSE|OPEN'
  )
  t.ok(source.includes('rpc_stream_response | rpc_stream_data'), 'chunk uses RESPONSE|DATA')
  t.ok(source.includes('rpc_stream_response | rpc_stream_end'), 'end uses RESPONSE|END')
  t.ok(
    source.includes('rpc_stream_response | rpc_stream_close | rpc_stream_error'),
    'error uses RESPONSE|CLOSE|ERROR'
  )
  t.ok(source.includes('return hrpc_dispatch_stream;'), 'dispatch returns stream code')
})

test('request-stream: classify and generated declarations', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({
    name: 'collect-request',
    fields: [{ name: 'value', type: 'uint', required: true }]
  })
  ns.register({
    name: 'collect-response',
    fields: [{ name: 'total', type: 'uint', required: true }]
  })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'collect',
    request: { name: '@greeter/collect-request', stream: true },
    response: { name: '@greeter/collect-response', stream: false }
  })

  const { header, source } = generateC(hrpc, { schemaTarget: 'greeter_schema' })

  t.ok(header.includes('greeter_encode_collect_open (uint64_t id'), 'client open declared')
  t.ok(
    header.includes(
      'greeter_encode_collect_chunk (uint64_t id, const greeter_collect_request_t *chunk'
    ),
    'client chunk declared'
  )
  t.ok(header.includes('greeter_encode_collect_end (uint64_t id'), 'client end declared')
  t.ok(
    header.includes('greeter_encode_collect_stream_open (uint64_t id'),
    'server open-echo declared'
  )
  t.ok(
    header.includes(
      'greeter_encode_collect_response (uint64_t id, const greeter_collect_response_t *res'
    ),
    'server response declared'
  )
  t.ok(
    header.includes('greeter_encode_collect_error (uint64_t id, hrpc_error_t error'),
    'server error declared'
  )
  t.ok(
    header.includes(
      'greeter_decode_collect_chunk (const rpc_message_t *msg, greeter_collect_request_t *out'
    ),
    'server chunk decoder declared'
  )
  t.ok(
    header.includes(
      'greeter_decode_collect_response (const rpc_message_t *msg, greeter_collect_response_t *result'
    ),
    'client response decoder declared'
  )
  t.ok(header.includes('(*greeter_on_collect) (void *ctx, uint64_t stream_id)'), 'handler typedef')
  t.absent(header.includes('greeter_on_collect) (void *ctx, const'), 'no req arg in handler')
  t.ok(source.includes('rpc_stream_request | rpc_stream_data'), 'chunk uses REQUEST|DATA')
  t.ok(source.includes('rpc_stream_request | rpc_stream_open'), 'echo uses REQUEST|OPEN')
  t.ok(source.includes('rpc_stream_request | rpc_stream_end'), 'end uses REQUEST|END')
  t.ok(
    source.includes('if (!(msg->stream & rpc_stream_open)) return hrpc_err_decode;'),
    'dispatch checks open flag'
  )
  t.ok(
    source.includes('handlers->on_collect(handlers->ctx, msg->id)'),
    'dispatch calls handler with stream id only'
  )
})

test('duplex: classify and generated declarations', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'pipe-request', fields: [{ name: 'value', type: 'uint', required: true }] })
  ns.register({ name: 'pipe-response', fields: [{ name: 'token', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'pipe',
    request: { name: '@greeter/pipe-request', stream: true },
    response: { name: '@greeter/pipe-response', stream: true }
  })

  const { header, source } = generateC(hrpc, { schemaTarget: 'greeter_schema' })

  for (const decl of [
    'greeter_encode_pipe_request_open (uint64_t id',
    'greeter_encode_pipe_request_chunk (uint64_t id, const greeter_pipe_request_t *chunk',
    'greeter_encode_pipe_request_end (uint64_t id',
    'greeter_encode_pipe_response_stream_open (uint64_t id',
    'greeter_decode_pipe_response_chunk (const rpc_message_t *msg, greeter_pipe_response_t *out',
    'greeter_encode_pipe_request_stream_open (uint64_t id',
    'greeter_decode_pipe_request_chunk (const rpc_message_t *msg, greeter_pipe_request_t *out',
    'greeter_encode_pipe_response_open (uint64_t id',
    'greeter_encode_pipe_response_chunk (uint64_t id, const greeter_pipe_response_t *chunk',
    'greeter_encode_pipe_response_end (uint64_t id',
    'greeter_encode_pipe_response_error (uint64_t id, hrpc_error_t error'
  ]) {
    t.ok(header.includes(decl), decl)
  }
  t.ok(header.includes('(*greeter_on_pipe) (void *ctx, uint64_t stream_id)'), 'handler typedef')
  t.ok(source.includes('msg.type = rpc_request'), 'request open is a request frame')
  t.ok(source.includes('msg.type = rpc_response'), 'response open is a response frame')
  t.ok(source.includes('rpc_stream_request | rpc_stream_data'), 'request chunk REQUEST|DATA')
  t.ok(source.includes('rpc_stream_response | rpc_stream_data'), 'response chunk RESPONSE|DATA')
  t.ok(source.includes('rpc_stream_request | rpc_stream_open'), 'request echo REQUEST|OPEN')
  t.ok(source.includes('rpc_stream_response | rpc_stream_open'), 'response echo RESPONSE|OPEN')
  t.ok(
    source.includes('rpc_stream_response | rpc_stream_close | rpc_stream_error'),
    'response error RESPONSE|CLOSE|ERROR'
  )
  t.ok(
    source.includes('handlers->on_pipe(handlers->ctx, msg->id)'),
    'dispatch calls handler with stream id only'
  )
})

test('event handler does not throw', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'ping', fields: [{ name: 'seq', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'ping',
    request: { name: '@greeter/ping', send: true }
  })
  t.execution(() => generateC(hrpc, { schemaTarget: 'greeter_schema' }))
})

test('event handler emits void typedef and no response decoder', (t) => {
  const schema = new Hyperschema()
  const ns = schema.namespace('greeter')
  ns.register({ name: 'ping', fields: [{ name: 'seq', type: 'uint', required: true }] })

  const hrpc = new HRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'ping',
    request: { name: '@greeter/ping', send: true }
  })
  const { header, source } = generateC(hrpc, { schemaTarget: 'greeter_schema' })

  // typedef is void return, no response/error params
  t.ok(header.includes('typedef void (*greeter_on_ping)'), 'void handler typedef')
  // no response decoder
  t.absent(header.includes('greeter_decode_ping_response'), 'no response decoder')
  // dispatch returns no_reply for events
  t.ok(source.includes('hrpc_dispatch_no_reply'), 'dispatch returns no_reply')
})
