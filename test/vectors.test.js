// Cross-language conformance: decode hrpc-test's schema-free wire vectors in
// C via librpc, and assert the decoded rpc_message_t matches the fixture
// descriptor exactly. This proves a second, non-JS implementation reads what
// the JS-generated fixtures say the bytes mean, rather than JS echoing itself.
const test = require('brittle')
const path = require('path')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runCRaw, runC, toCArray } = require('./helpers/c')

// hrpc-test is a Node-only tooling/fixtures package (plain require('fs'), no
// Bare imports map), so it cannot load under brittle-bare. Skip the whole
// file there rather than only the individual tests, since the require()
// itself throws. Guard the process.platform read too: process is a Node
// global hrpc-c doesn't polyfill for Bare.
const isBare = typeof Bare !== 'undefined'
const isWindows = !isBare && process.platform === 'win32'

const PREAMBLE = `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <rpc.h>
`

// Emit C asserting msg.data/msg.len match a descriptor's data field. The
// wire (and libcompact's compact_decode_uint8array) has no way to represent
// "no buffer" separately from "zero-length buffer": both null and "" encode
// as dataLen 0 and decode with msg.data pointing into the input and
// msg.len == 0. The JS null/empty-Buffer distinction is a JS-side API
// artifact with no wire representation, so both fixture shapes assert the
// same thing in C: msg.len == 0.
function assertData(data) {
  if (data === null || data.length === 0) {
    return 'assert(msg.len == 0);'
  }
  const bytes = Buffer.from(data, 'hex')
  return [
    `uint8_t expected[] = {${toCArray(bytes)}};`,
    `assert(msg.len == ${bytes.length});`,
    'assert(msg.data != NULL);',
    `assert(memcmp(msg.data, expected, ${bytes.length}) == 0);`
  ].join('\n  ')
}

// Emit C asserting msg.message/msg.code/msg.status match a descriptor's
// error field: { message, code, errno }.
function assertError(error) {
  const message = Buffer.from(error.message, 'utf8')
  const code = Buffer.from(error.code, 'utf8')
  return [
    `assert(msg.message.len == ${message.length});`,
    message.length > 0
      ? `assert(memcmp(msg.message.data, (const uint8_t[]){${toCArray(message)}}, ${message.length}) == 0);`
      : '',
    `assert(msg.code.len == ${code.length});`,
    code.length > 0
      ? `assert(memcmp(msg.code.data, (const uint8_t[]){${toCArray(code)}}, ${code.length}) == 0);`
      : '',
    `assert(msg.status == ${error.errno});`
  ]
    .filter(Boolean)
    .join('\n  ')
}

// Build a C driver that decodes one frame and asserts every field the
// descriptor pins down, per the union rules in hrpc-test/WIRE.md:
//   request         (type 1): command always set; data iff stream == 0
//   response        (type 2): error union - either the error struct, or
//                              (data iff stream == 0)
//   stream          (type 3): error union - either the error struct, or
//                              (data iff stream has the DATA bit set)
function decodeDriver(hex, descriptor) {
  const frame = Buffer.from(hex, 'hex')
  const lines = [
    `uint8_t input[] = {${toCArray(frame)}};`,
    'compact_state_t in = {0, sizeof(input), input};',
    'rpc_message_t msg; memset(&msg, 0, sizeof(msg));',
    'assert(rpc_decode_message(&in, &msg) == 0);',
    `assert(msg.type == ${descriptor.type});`,
    `assert(msg.id == ${descriptor.id});`
  ]

  if (descriptor.type === 1) {
    lines.push(`assert(msg.command == ${descriptor.command});`)
    lines.push(`assert(msg.stream == ${descriptor.stream});`)
    if (descriptor.stream === 0) lines.push(assertData(descriptor.data))
  } else if (descriptor.type === 2) {
    lines.push(`assert(msg.stream == ${descriptor.stream});`)
    if (descriptor.error) {
      lines.push('assert(msg.error == true);')
      lines.push(assertError(descriptor.error))
    } else {
      lines.push('assert(msg.error == false);')
      if (descriptor.stream === 0) lines.push(assertData(descriptor.data))
    }
  } else if (descriptor.type === 3) {
    lines.push(`assert(msg.stream == ${descriptor.stream});`)
    if (descriptor.error) {
      lines.push(assertError(descriptor.error))
    } else if (descriptor.stream & 0x10) {
      lines.push(assertData(descriptor.data))
    }
  }

  lines.push('printf("ok\\n");')

  return `${PREAMBLE}
int
main (void) {
  ${lines.join('\n  ')}
  return 0;
}
`
}

if (!isBare) {
  const { loadFamily } = require('hrpc-test')

  for (const family of ['envelope', 'error', 'boundary']) {
    const { messages, frames } = loadFamily(family)
    for (let i = 0; i < frames.length; i++) {
      const { note, descriptor } = messages[i]
      test(`C decodes ${family}[${i}] - ${note}`, { skip: isWindows }, (t) => {
        const result = runCRaw(decodeDriver(frames[i], descriptor))
        t.ok(result.ok, result.ok ? 'decoded ok' : result.stderr)
        if (result.ok) t.is(result.stdout.trim(), 'ok', 'driver printed success marker')
      })
    }
  }

  // --- dispatch: real generated struct codecs, not just the schema-free
  // envelope. hrpc-test's fixtures/dispatch/{schema,hrpc} are already the
  // frozen hyperschema/hrpc JSON this generator's own codegen consumes, so
  // load them directly (no hand-copied schema definition to drift).
  const HRPC_TEST_DIR = path.dirname(require.resolve('hrpc-test'))
  const DISPATCH_SCHEMA_DIR = path.join(HRPC_TEST_DIR, 'fixtures', 'dispatch', 'schema')
  const DISPATCH_HRPC_DIR = path.join(HRPC_TEST_DIR, 'fixtures', 'dispatch', 'hrpc')

  function buildDispatchGreeter() {
    const schema = CHyperschema.from(DISPATCH_SCHEMA_DIR)
    const hrpc = CHRPC.from(schema, DISPATCH_HRPC_DIR)
    return { schema, hrpc }
  }

  const DISPATCH_PREAMBLE = `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <rpc.h>
#include "greeter_hrpc.h"

static void print_bytes (const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) printf("%s%02x", i ? "" : "", buf[i]);
  printf("\\n");
}

static int
str_eq (const utf8_string_view_t view, const char *expected) {
  size_t n = strlen(expected);
  return view.len == n && memcmp(view.data, expected, n) == 0;
}
`

  test('C decodes dispatch[0] - hello request payload', { skip: isWindows }, (t) => {
    const { schema, hrpc } = buildDispatchGreeter()
    const { frames } = loadFamily('dispatch')
    const frame = Buffer.from(frames[0], 'hex')

    const main = `${DISPATCH_PREAMBLE}
int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};
  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  assert(rpc_decode_message(&in, &msg) == 0);
  assert(msg.type == rpc_request);
  assert(msg.id == 1);
  assert(msg.command == greeter_command_hello);

  compact_state_t payload = {0, msg.len, msg.data};
  greeter_hello_request_t req; memset(&req, 0, sizeof(req));
  assert(greeter_hello_request_decode(&payload, &req) == 0);
  assert(str_eq(req.name, "ada"));

  printf("ok\\n");
  return 0;
}
`
    const result = runC(schema, hrpc, main)
    t.ok(result.ok, result.ok ? 'decoded ok' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), 'ok', 'driver printed success marker')
  })

  test('C decodes dispatch[1] - hello response payload', { skip: isWindows }, (t) => {
    const { schema, hrpc } = buildDispatchGreeter()
    const { frames } = loadFamily('dispatch')
    const frame = Buffer.from(frames[1], 'hex')

    const main = `${DISPATCH_PREAMBLE}
int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};
  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  assert(rpc_decode_message(&in, &msg) == 0);
  assert(msg.type == rpc_response);
  assert(msg.id == 1);
  assert(msg.error == false);

  compact_state_t payload = {0, msg.len, msg.data};
  greeter_hello_response_t res; memset(&res, 0, sizeof(res));
  assert(greeter_hello_response_decode(&payload, &res) == 0);
  assert(str_eq(res.text, "hi ada"));

  printf("ok\\n");
  return 0;
}
`
    const result = runC(schema, hrpc, main)
    t.ok(result.ok, result.ok ? 'decoded ok' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), 'ok', 'driver printed success marker')
  })

  test('C decodes dispatch[2] - ping event payload', { skip: isWindows }, (t) => {
    const { schema, hrpc } = buildDispatchGreeter()
    const { frames } = loadFamily('dispatch')
    const frame = Buffer.from(frames[2], 'hex')

    const main = `${DISPATCH_PREAMBLE}
int
main (void) {
  uint8_t input[] = {${toCArray(frame)}};
  compact_state_t in = {0, sizeof(input), input};
  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  assert(rpc_decode_message(&in, &msg) == 0);
  assert(msg.type == rpc_request);
  assert(msg.id == 0);
  assert(msg.command == greeter_command_ping);

  compact_state_t payload = {0, msg.len, msg.data};
  greeter_ping_request_t req; memset(&req, 0, sizeof(req));
  assert(greeter_ping_request_decode(&payload, &req) == 0);
  assert(req.seq == 7);

  printf("ok\\n");
  return 0;
}
`
    const result = runC(schema, hrpc, main)
    t.ok(result.ok, result.ok ? 'decoded ok' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), 'ok', 'driver printed success marker')
  })

  // --- Encode-match spot-check: a representative subset (one unary request,
  // one success response, one error response, one stream data frame) where C
  // ENCODES the message and the produced bytes must equal the fixture hex
  // exactly. This is the strongest direction - C writes the same canonical
  // bytes JS wrote - so it is kept to a subset by design rather than run over
  // all ~50 vectors; every vector checked here is logged so the remaining
  // decode-only coverage is an explicit, visible gap rather than a silent one.
  const ENCODE_CHECKED = [
    'dispatch[0] hello request (unary request)',
    'dispatch[1] hello response (success response)',
    'error[0] response error basic (error response)',
    "envelope[9] 'stream request data' (stream data frame)"
  ]
  console.log('encode-match spot-check covers:', ENCODE_CHECKED.join('; '))

  test('C encodes dispatch[0] - hello request matches fixture bytes', { skip: isWindows }, (t) => {
    const { schema, hrpc } = buildDispatchGreeter()
    const { frames } = loadFamily('dispatch')

    const main = `${DISPATCH_PREAMBLE}
int
main (void) {
  greeter_hello_request_t args = { .name = utf8_string_view_init((const utf8_t *) "ada", 3) };
  uint8_t *buf = NULL; size_t len = 0;
  assert(greeter_encode_hello(1, &args, &buf, &len) == 0);
  print_bytes(buf, len);
  free(buf);
  return 0;
}
`
    const result = runC(schema, hrpc, main)
    t.ok(result.ok, result.ok ? 'compiled and ran' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), frames[0], 'C-encoded bytes equal the fixture hex')
  })

  test('C encodes dispatch[1] - hello response matches fixture bytes', { skip: isWindows }, (t) => {
    const { schema, hrpc } = buildDispatchGreeter()
    const { frames } = loadFamily('dispatch')

    const main = `${DISPATCH_PREAMBLE}
static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx; (void) req; (void) error;
  res->text = utf8_string_view_init((const utf8_t *) "hi ada", 6);
  return hrpc_ok;
}

static void
on_ping (void *ctx, const greeter_ping_request_t *req) { (void) ctx; (void) req; }

int
main (void) {
  greeter_hello_request_t req = { .name = utf8_string_view_init((const utf8_t *) "ada", 3) };
  uint8_t *reqbuf = NULL; size_t reqlen = 0;
  assert(greeter_encode_hello(1, &req, &reqbuf, &reqlen) == 0);

  compact_state_t in = {0, reqlen, reqbuf};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello, .on_ping = on_ping };
  uint8_t *reply = NULL; size_t reply_len = 0;
  // reqmsg holds non-owning views into reqbuf; keep reqbuf alive until dispatch has consumed it
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &reply, &reply_len) == hrpc_dispatch_reply);
  free(reqbuf);

  print_bytes(reply, reply_len);
  free(reply);
  return 0;
}
`
    const result = runC(schema, hrpc, main)
    t.ok(result.ok, result.ok ? 'compiled and ran' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), frames[1], 'C-encoded bytes equal the fixture hex')
  })

  test('C encodes error[0] response matches fixture bytes', { skip: isWindows }, (t) => {
    const { messages, frames } = loadFamily('error')
    const { descriptor } = messages[0]

    // librpc's status field is the wire-identical, differently-named
    // counterpart to the canonical/JS "errno": same signed-int wire
    // position, so setting status = descriptor.errno reproduces the exact
    // canonical bytes despite the field-name mismatch.
    const main = `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <rpc.h>

static void print_bytes (const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) printf("%s%02x", i ? "" : "", buf[i]);
  printf("\\n");
}

int
main (void) {
  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  msg.type = rpc_response;
  msg.id = ${descriptor.id};
  msg.error = true;
  msg.stream = ${descriptor.stream};
  msg.message = (utf8_string_view_t){ (const utf8_t *) "${descriptor.error.message}", ${Buffer.byteLength(descriptor.error.message)} };
  msg.code = (utf8_string_view_t){ (const utf8_t *) "${descriptor.error.code}", ${Buffer.byteLength(descriptor.error.code)} };
  msg.status = ${descriptor.error.errno};

  compact_state_t out = {0, 0, NULL};
  assert(rpc_preencode_message(&out, &msg) == 0);
  out.buffer = malloc(out.end);
  assert(out.buffer != NULL);
  assert(rpc_encode_message(&out, &msg) == 0);

  print_bytes(out.buffer, out.end);
  free(out.buffer);
  return 0;
}
`
    const result = runCRaw(`#include <stdlib.h>\n${main}`)
    t.ok(result.ok, result.ok ? 'compiled and ran' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), frames[0], 'C-encoded bytes equal the fixture hex')
  })

  test('C encodes envelope stream-data frame matches fixture bytes', { skip: isWindows }, (t) => {
    const { messages, frames } = loadFamily('envelope')
    const i = messages.findIndex((m) => m.note === 'stream request data')
    const { descriptor } = messages[i]
    const dataBytes = Buffer.from(descriptor.data, 'hex')

    const main = `
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <rpc.h>

static void print_bytes (const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) printf("%s%02x", i ? "" : "", buf[i]);
  printf("\\n");
}

int
main (void) {
  uint8_t data[] = {${toCArray(dataBytes)}};

  rpc_message_t msg; memset(&msg, 0, sizeof(msg));
  msg.type = rpc_stream;
  msg.id = ${descriptor.id};
  msg.stream = ${descriptor.stream};
  msg.data = data;
  msg.len = sizeof(data);

  compact_state_t out = {0, 0, NULL};
  assert(rpc_preencode_message(&out, &msg) == 0);
  out.buffer = malloc(out.end);
  assert(out.buffer != NULL);
  assert(rpc_encode_message(&out, &msg) == 0);

  print_bytes(out.buffer, out.end);
  free(out.buffer);
  return 0;
}
`
    const result = runCRaw(main)
    t.ok(result.ok, result.ok ? 'compiled and ran' : result.stderr)
    if (result.ok) t.is(result.stdout.trim(), frames[i], 'C-encoded bytes equal the fixture hex')
  })
}
