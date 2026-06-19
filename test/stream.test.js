const test = require('brittle')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runC } = require('./helpers/c')

function buildWatch() {
  const schema = CHyperschema.from(null)
  const ns = schema.namespace('greeter')
  ns.register({ name: 'watch-request', fields: [{ name: 'since', type: 'uint', required: true }] })
  ns.register({ name: 'log-event', fields: [{ name: 'seq', type: 'uint', required: true }] })
  const hrpc = new CHRPC(schema, null, {})
  hrpc.namespace('greeter').register({
    name: 'watch',
    request: { name: '@greeter/watch-request', stream: false },
    response: { name: '@greeter/log-event', stream: true }
  })
  return { schema, hrpc }
}

const MAIN_C = `
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "greeter_hrpc.h"

static uint64_t g_stream_id = 0;
static uint64_t g_since = 0;

static int
on_watch (void *ctx, const greeter_watch_request_t *req, uint64_t stream_id) {
  (void) ctx;
  g_stream_id = stream_id;
  g_since = req->since;
  return 0;
}

static void
roundtrip (uint8_t *buf, size_t len, rpc_message_t *out) {
  compact_state_t in = {0, len, buf};
  memset(out, 0, sizeof(*out));
  assert(rpc_decode_message(&in, out) == 0);
}

int
main (void) {
  uint8_t *buf = NULL;
  size_t len = 0;

  // dispatch: a watch request hands on_watch the stream id and returns hrpc_dispatch_stream
  greeter_watch_request_t args = { .since = 5 };
  assert(greeter_encode_watch(9, &args, &buf, &len) == 0);
  compact_state_t rin = {0, len, buf};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&rin, &reqmsg) == 0);

  // reqmsg.data is a view into buf; keep buf alive until dispatch has decoded it.
  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_watch = on_watch };
  uint8_t *reply = NULL; size_t reply_len = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &reply, &reply_len) == hrpc_dispatch_stream);
  // sans-io: a stream dispatch writes no reply buffer
  assert(reply == NULL);
  assert(reply_len == 0);
  assert(g_stream_id == 9);
  assert(g_since == 5);
  free(buf); buf = NULL;

  rpc_message_t m;

  // open: rpc_response, stream=open
  assert(greeter_encode_watch_open(9, &buf, &len) == 0);
  roundtrip(buf, len, &m); free(buf); buf = NULL;
  assert(m.type == rpc_response);
  assert(m.id == 9);
  assert(m.stream == rpc_stream_open);

  // open echo: rpc_stream, stream=response|open
  assert(greeter_encode_watch_stream_open(9, &buf, &len) == 0);
  roundtrip(buf, len, &m); free(buf); buf = NULL;
  assert(m.type == rpc_stream);
  assert(m.stream == (rpc_stream_response | rpc_stream_open));

  // chunk: rpc_stream, stream=response|data, payload decodes
  greeter_log_event_t chunk = { .seq = 77 };
  assert(greeter_encode_watch_chunk(9, &chunk, &buf, &len) == 0);
  roundtrip(buf, len, &m);
  assert(m.type == rpc_stream);
  assert(m.stream == (rpc_stream_response | rpc_stream_data));
  greeter_log_event_t got = {0};
  assert(greeter_decode_watch_chunk(&m, &got) == 0);
  assert(got.seq == 77);
  free(buf); buf = NULL;

  // end: rpc_stream, stream=response|end
  assert(greeter_encode_watch_end(9, &buf, &len) == 0);
  roundtrip(buf, len, &m); free(buf); buf = NULL;
  assert(m.type == rpc_stream);
  assert(m.stream == (rpc_stream_response | rpc_stream_end));

  // error: rpc_stream, stream=response|close|error, fields survive
  hrpc_error_t error = {0};
  error.message = (utf8_string_view_t){ (const utf8_t *) "boom", 4 };
  error.code = (utf8_string_view_t){ (const utf8_t *) "ERR", 3 };
  error.status = 500;
  assert(greeter_encode_watch_error(9, error, &buf, &len) == 0);
  roundtrip(buf, len, &m);
  assert(m.type == rpc_stream);
  assert(m.stream == (rpc_stream_response | rpc_stream_close | rpc_stream_error));
  assert(m.status == 500);
  assert(m.message.len == 4 && memcmp(m.message.data, "boom", 4) == 0);
  assert(m.code.len == 3 && memcmp(m.code.data, "ERR", 3) == 0);
  free(buf); buf = NULL;

  return 0;
}
`

test('response-stream compiles and round-trips through generated C', { timeout: 200000 }, (t) => {
  const { schema, hrpc } = buildWatch()
  const res = runC(schema, hrpc, MAIN_C)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
})
