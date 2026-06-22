const test = require('brittle')
const path = require('path')
const fs = require('fs')
const c = require('compact-encoding')
const m = require('bare-rpc/messages')
const Hyperschema = require('hyperschema')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runC, toCArray, parseBytes } = require('./helpers/c')

// --- JS-side real generated codecs (generate to disk, require back) ---
// Must live inside the repo module tree so the generated index.js can resolve
// require('hyperschema/runtime').
const JS_SCHEMA_DIR = path.join(__dirname, 'c-workspace', 'js-schema')

function jsCodecs() {
  fs.rmSync(JS_SCHEMA_DIR, { recursive: true, force: true })
  fs.mkdirSync(JS_SCHEMA_DIR, { recursive: true })
  const schema = Hyperschema.from(JS_SCHEMA_DIR)
  const ns = schema.namespace('greeter')
  ns.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
  ns.register({
    name: 'hello-response',
    fields: [{ name: 'greeting', type: 'uint', required: true }]
  })
  ns.register({ name: 'ping', fields: [{ name: 'seq', type: 'uint', required: true }] })
  ns.register({ name: 'watch-request', fields: [{ name: 'since', type: 'uint', required: true }] })
  ns.register({ name: 'log-event', fields: [{ name: 'seq', type: 'uint', required: true }] })
  ns.register({
    name: 'collect-request',
    fields: [{ name: 'value', type: 'uint', required: true }]
  })
  ns.register({
    name: 'collect-response',
    fields: [{ name: 'total', type: 'uint', required: true }]
  })
  Hyperschema.toDisk(schema)
  const mod = require(path.join(JS_SCHEMA_DIR, 'index.js'))
  return {
    helloRequest: mod.getEncoding('@greeter/hello-request'),
    helloResponse: mod.getEncoding('@greeter/hello-response'),
    ping: mod.getEncoding('@greeter/ping'),
    logEvent: mod.getEncoding('@greeter/log-event'),
    collectRequest: mod.getEncoding('@greeter/collect-request'),
    collectResponse: mod.getEncoding('@greeter/collect-response')
  }
}

const codecs = jsCodecs()

// --- C-side schema + hrpc (mirrors the JS definitions and test/c.test.js) ---
function buildGreeter() {
  const schema = CHyperschema.from(null)
  const ns = schema.namespace('greeter')
  ns.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
  ns.register({
    name: 'hello-response',
    fields: [{ name: 'greeting', type: 'uint', required: true }]
  })
  ns.register({ name: 'ping', fields: [{ name: 'seq', type: 'uint', required: true }] })
  ns.register({ name: 'watch-request', fields: [{ name: 'since', type: 'uint', required: true }] })
  ns.register({ name: 'log-event', fields: [{ name: 'seq', type: 'uint', required: true }] })
  ns.register({
    name: 'collect-request',
    fields: [{ name: 'value', type: 'uint', required: true }]
  })
  ns.register({
    name: 'collect-response',
    fields: [{ name: 'total', type: 'uint', required: true }]
  })
  const hrpc = new CHRPC(schema, null, {})
  const h = hrpc.namespace('greeter')
  h.register({
    name: 'hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  h.register({ name: 'ping', request: { name: '@greeter/ping', send: true } })
  h.register({
    name: 'watch',
    request: { name: '@greeter/watch-request', stream: false },
    response: { name: '@greeter/log-event', stream: true }
  })
  h.register({
    name: 'collect',
    request: { name: '@greeter/collect-request', stream: true },
    response: { name: '@greeter/collect-response', stream: false }
  })
  return { schema, hrpc }
}

// --- bare-rpc framing helpers (header writes the length prefix incl. payload
// size but not the payload bytes, so concat the payload). ---
function encodeRequest(id, command, payload) {
  const header = c.encode(m.header, { type: 1, id, command, stream: 0, data: payload })
  return payload ? Buffer.concat([header, payload]) : Buffer.from(header)
}

function encodeEvent(command, payload) {
  return encodeRequest(0, command, payload)
}

function encodeResponse(id, payload) {
  const header = c.encode(m.header, { type: 2, id, error: null, stream: 0, data: payload })
  return payload ? Buffer.concat([header, payload]) : Buffer.from(header)
}

function decodeFrame(buf) {
  return m.message.decode(c.state(0, buf.length, buf))
}

// Shared driver preamble: includes + a byte printer.
const PREAMBLE = `
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "greeter_hrpc.h"

static void print_bytes (const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) printf("%s%u", i ? " " : "", buf[i]);
  printf("\\n");
}
`

test('interop: JS unary request -> C dispatch -> C response -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const payload = Buffer.from(c.encode(codecs.helloRequest, { id: 42 }))
  const frame = encodeRequest(7, 0, payload) // id 7, command greeter_command_hello = 0

  const main = `${PREAMBLE}
static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx; (void) error;
  res->greeting = req->id + 100;
  return hrpc_ok;
}

static void
on_ping (void *ctx, const greeter_ping_t *req) { (void) ctx; (void) req; }

int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};

  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);
  assert(reqmsg.type == rpc_request);
  assert(reqmsg.command == greeter_command_hello);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello, .on_ping = on_ping };
  uint8_t *reply = NULL; size_t reply_len = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &reply, &reply_len) == hrpc_dispatch_reply);

  print_bytes(reply, reply_len);
  free(reply);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const msg = decodeFrame(parseBytes(res.stdout))
  t.is(msg.type, 2, 'response type')
  t.is(msg.id, 7, 'response id matches request id')
  t.is(c.decode(codecs.helloResponse, msg.data).greeting, 142, 'greeting = 42 + 100')
})

test('interop: JS unary request -> C error response -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const payload = Buffer.from(c.encode(codecs.helloRequest, { id: 0 })) // 0 triggers error
  const frame = encodeRequest(5, 0, payload)

  const main = `${PREAMBLE}
static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx; (void) res;
  if (req->id == 0) {
    error->message = (utf8_string_view_t){ (const utf8_t *) "bad id", 6 };
    error->code = (utf8_string_view_t){ (const utf8_t *) "BAD_ID", 6 };
    error->status = 400;
    return hrpc_error_response;
  }
  res->greeting = req->id + 100;
  return hrpc_ok;
}

static void
on_ping (void *ctx, const greeter_ping_t *req) { (void) ctx; (void) req; }

int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};

  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello, .on_ping = on_ping };
  uint8_t *reply = NULL; size_t reply_len = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &reply, &reply_len) == hrpc_dispatch_reply);

  print_bytes(reply, reply_len);
  free(reply);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const msg = decodeFrame(parseBytes(res.stdout))
  t.is(msg.type, 2, 'response type')
  t.is(msg.id, 5, 'error response id matches request id')
  t.ok(msg.error instanceof Error, 'decoded as an error')
  t.is(msg.error.message, 'bad id', 'error message crosses the boundary')
  t.is(msg.error.code, 'BAD_ID', 'error code crosses the boundary')
  t.is(msg.error.errno, 400, 'C status maps to JS errno')
})

test('interop: JS event frame -> C dispatch', (t) => {
  const { schema, hrpc } = buildGreeter()

  const payload = Buffer.from(c.encode(codecs.ping, { seq: 77 }))
  const frame = encodeEvent(1, payload) // id 0, command greeter_command_ping = 1

  const main = `${PREAMBLE}
static unsigned long long g_seq = 0;
static int g_called = 0;

static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx; (void) req; (void) res; (void) error; return hrpc_ok;
}

static void
on_ping (void *ctx, const greeter_ping_t *req) { (void) ctx; g_called = 1; g_seq = req->seq; }

int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};

  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);
  assert(reqmsg.type == rpc_request);
  assert(reqmsg.id == 0);
  assert(reqmsg.command == greeter_command_ping);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello, .on_ping = on_ping };
  uint8_t *reply = NULL; size_t reply_len = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &reply, &reply_len) == hrpc_dispatch_no_reply);
  assert(g_called == 1);

  printf("%llu\\n", g_seq);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
  t.is(res.stdout.trim(), '77', 'C event handler received seq = 77')
})

test('interop: C event frame -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const main = `${PREAMBLE}
int
main (void) {
  greeter_ping_t args = { .seq = 55 };
  uint8_t *buf = NULL; size_t len = 0;
  assert(greeter_encode_ping(&args, &buf, &len) == 0);
  print_bytes(buf, len);
  free(buf);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const msg = decodeFrame(parseBytes(res.stdout))
  t.is(msg.type, 1, 'event is a request frame')
  t.is(msg.id, 0, 'event id is 0')
  t.is(msg.command, 1, 'command is greeter_command_ping')
  t.is(c.decode(codecs.ping, msg.data).seq, 55, 'C-encoded event payload decoded in JS')
})

test('interop: C unary request frame -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const main = `${PREAMBLE}
int
main (void) {
  greeter_hello_request_t args = { .id = 33 };
  uint8_t *buf = NULL; size_t len = 0;
  assert(greeter_encode_hello(9, &args, &buf, &len) == 0);
  print_bytes(buf, len);
  free(buf);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const msg = decodeFrame(parseBytes(res.stdout))
  t.is(msg.type, 1, 'request type')
  t.is(msg.id, 9, 'request id')
  t.is(msg.command, 0, 'command is greeter_command_hello')
  t.is(c.decode(codecs.helloRequest, msg.data).id, 33, 'C-encoded request payload decoded in JS')
})

test('interop: JS success response -> C decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const payload = Buffer.from(c.encode(codecs.helloResponse, { greeting: 777 }))
  const frame = encodeResponse(11, payload)

  const main = `${PREAMBLE}
int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};

  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t respmsg; memset(&respmsg, 0, sizeof(respmsg));
  assert(rpc_decode_message(&in, &respmsg) == 0);
  assert(respmsg.type == rpc_response);
  assert(respmsg.id == 11);

  greeter_hello_response_t result; memset(&result, 0, sizeof(result));
  hrpc_error_t error; memset(&error, 0, sizeof(error));
  assert(greeter_decode_hello_response(&respmsg, &result, &error) == hrpc_ok);
  assert(result.greeting == 777);

  printf("%llu\\n", (unsigned long long) result.greeting);
  return 0;
}
`

  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
  t.is(res.stdout.trim(), '777', 'JS-encoded response decoded by C')
})

test('interop: C response-stream frames -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const main = `${PREAMBLE}
int
main (void) {
  uint8_t *b = NULL; size_t n = 0;

  greeter_log_event_t chunk = { .seq = 77 };
  assert(greeter_encode_watch_chunk(9, &chunk, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  assert(greeter_encode_watch_end(9, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  assert(greeter_encode_watch_open(9, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  return 0;
}
`
  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const lines = res.stdout.trim().split('\n')
  const chunk = decodeFrame(parseBytes(lines[0]))
  t.is(chunk.type, 3, 'chunk is a stream frame')
  t.is(chunk.stream, 0x210, 'chunk stream = RESPONSE|DATA')
  t.is(c.decode(codecs.logEvent, chunk.data).seq, 77, 'chunk payload decoded in JS')

  const end = decodeFrame(parseBytes(lines[1]))
  t.is(end.type, 3, 'end is a stream frame')
  t.is(end.id, 9, 'end frame id')
  t.is(end.stream, 0x220, 'end stream = RESPONSE|END')
  t.is(end.data, null, 'end frame has no payload')

  const open = decodeFrame(parseBytes(lines[2]))
  t.is(open.type, 2, 'open is a response frame')
  t.is(open.id, 9, 'open frame id')
  t.is(open.stream, 0x1, 'open stream = OPEN')
})

test('interop: JS response-stream chunk -> C decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const payload = Buffer.from(c.encode(codecs.logEvent, { seq: 88 }))
  const header = c.encode(m.header, { type: 3, id: 9, stream: 0x210, error: null, data: payload })
  const frame = Buffer.concat([header, payload])

  const main = `${PREAMBLE}
int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};
  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  assert(rpc_decode_message(&in, &msg) == 0);
  assert(msg.type == rpc_stream);
  assert(msg.stream == (rpc_stream_response | rpc_stream_data));
  greeter_log_event_t out = {0};
  assert(greeter_decode_watch_chunk(&msg, &out) == 0);
  printf("%llu\\n", (unsigned long long) out.seq);
  return 0;
}
`
  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
  t.is(res.stdout.trim(), '88', 'JS-encoded chunk decoded by C')
})

test('interop: C request-stream frames -> JS decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  const main = `${PREAMBLE}
int
main (void) {
  uint8_t *b = NULL; size_t n = 0;

  greeter_collect_request_t chunk = { .value = 12 };
  assert(greeter_encode_collect_chunk(9, &chunk, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  assert(greeter_encode_collect_end(9, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  greeter_collect_response_t res = { .total = 30 };
  assert(greeter_encode_collect_response(9, &res, &b, &n) == 0);
  print_bytes(b, n); free(b); b = NULL;

  return 0;
}
`
  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)

  const lines = res.stdout.trim().split('\n')

  const chunk = decodeFrame(parseBytes(lines[0]))
  t.is(chunk.type, 3, 'chunk is a stream frame')
  t.is(chunk.id, 9, 'chunk id')
  t.is(chunk.stream, 0x110, 'chunk stream = REQUEST|DATA')
  t.is(c.decode(codecs.collectRequest, chunk.data).value, 12, 'chunk payload decoded in JS')

  const end = decodeFrame(parseBytes(lines[1]))
  t.is(end.type, 3, 'end is a stream frame')
  t.is(end.id, 9, 'end frame id')
  t.is(end.stream, 0x120, 'end stream = REQUEST|END')
  t.is(end.data, null, 'end frame has no payload')

  const reply = decodeFrame(parseBytes(lines[2]))
  t.is(reply.type, 2, 'reply is a response frame')
  t.is(reply.id, 9, 'reply id')
  t.is(reply.stream, 0, 'reply stream = 0')
  t.is(c.decode(codecs.collectResponse, reply.data).total, 30, 'reply payload decoded in JS')
})

test('interop: JS request-stream frames -> C decode', (t) => {
  const { schema, hrpc } = buildGreeter()

  // OPEN: type 1 request, command = greeter_command_collect (3), stream = OPEN
  const openFrame = Buffer.from(
    c.encode(m.header, { type: 1, id: 9, command: 3, stream: 0x1, data: null })
  )

  const chunkPayload = Buffer.from(c.encode(codecs.collectRequest, { value: 21 }))
  const chunkHeader = c.encode(m.header, {
    type: 3,
    id: 9,
    stream: 0x110,
    error: null,
    data: chunkPayload
  })
  const chunkFrame = Buffer.concat([chunkHeader, chunkPayload])

  const main = `${PREAMBLE}
int
main (void) {
  uint8_t open_in[] = {${toCArray(openFrame)}};
  compact_state_t oin = {0, sizeof(open_in), open_in};
  rpc_message_t om; memset(&om, 0, sizeof(om));
  assert(rpc_decode_message(&oin, &om) == 0);
  assert(om.type == rpc_request);
  assert(om.id == 9);
  assert(om.command == greeter_command_collect);
  assert(om.stream == rpc_stream_open);

  uint8_t chunk_in[] = {${toCArray(chunkFrame)}};
  compact_state_t cin = {0, sizeof(chunk_in), chunk_in};
  rpc_message_t cm; memset(&cm, 0, sizeof(cm));
  assert(rpc_decode_message(&cin, &cm) == 0);
  assert(cm.type == rpc_stream);
  assert(cm.stream == (rpc_stream_request | rpc_stream_data));
  greeter_collect_request_t out = {0};
  assert(greeter_decode_collect_chunk(&cm, &out) == 0);
  printf("%llu\\n", (unsigned long long) out.value);
  return 0;
}
`
  const res = runC(schema, hrpc, main)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
  t.is(res.stdout.trim(), '21', 'JS-encoded chunk decoded by C')
})
