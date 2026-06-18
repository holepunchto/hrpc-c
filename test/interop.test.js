const test = require('brittle')
const path = require('path')
const fs = require('fs')
const os = require('os')
const c = require('compact-encoding')
const m = require('bare-rpc/messages')
const Hyperschema = require('hyperschema')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runC, toCArray, parseBytes } = require('./helpers/c')

const skip = os.platform() === 'win32'

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
  Hyperschema.toDisk(schema)
  const mod = require(path.join(JS_SCHEMA_DIR, 'index.js'))
  return {
    helloRequest: mod.getEncoding('@greeter/hello-request'),
    helloResponse: mod.getEncoding('@greeter/hello-response'),
    ping: mod.getEncoding('@greeter/ping')
  }
}

const codecs = skip ? null : jsCodecs()

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
  const hrpc = new CHRPC(schema, null, {})
  const h = hrpc.namespace('greeter')
  h.register({
    name: 'hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  h.register({ name: 'ping', request: { name: '@greeter/ping', send: true } })
  return { schema, hrpc }
}

// --- bare-rpc framing helpers (header writes the length prefix incl. payload
// size but not the payload bytes, so concat the payload). ---
function encodeRequest(id, command, payload) {
  const header = c.encode(m.header, { type: 1, id, command, stream: 0, data: payload })
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

test('interop: JS unary request -> C dispatch -> C response -> JS decode', { skip }, (t) => {
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

test('interop: JS unary request -> C error response -> JS decode', { skip }, (t) => {
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
