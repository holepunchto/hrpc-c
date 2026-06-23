const test = require('brittle')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runC } = require('./helpers/c')

function buildE2E() {
  const schema = CHyperschema.from(null)
  const ns = schema.namespace('greeter')
  ns.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
  ns.register({
    name: 'hello-response',
    fields: [{ name: 'greeting', type: 'uint', required: true }]
  })
  ns.register({ name: 'watch-request', fields: [{ name: 'since', type: 'uint', required: true }] })
  ns.register({ name: 'log-event', fields: [{ name: 'seq', type: 'uint', required: true }] })

  const hrpc = new CHRPC(schema, null, {})
  const h = hrpc.namespace('greeter')
  h.register({
    name: 'hello',
    request: { name: '@greeter/hello-request', stream: false },
    response: { name: '@greeter/hello-response', stream: false }
  })
  h.register({
    name: 'watch',
    request: { name: '@greeter/watch-request', stream: false },
    response: { name: '@greeter/log-event', stream: true }
  })
  return { schema, hrpc }
}

const UNARY_MAIN_C = `
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "greeter_hrpc.h"
#include <rpc/client.h>

// server: handle a hello request
static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx; (void) error;
  res->greeting = req->id + 100;
  return hrpc_ok;
}

// client: pending reply callback (decodes inside the callback)
typedef struct { int count; uint64_t greeting; } reply_ctx_t;

static void
on_hello_reply (void *data, const rpc_message_t *msg) {
  reply_ctx_t *r = data;
  r->count++;
  greeter_hello_response_t result = {0};
  hrpc_error_t error = {0};
  assert(greeter_decode_hello_response(msg, &result, &error) == hrpc_ok);
  r->greeting = result.greeting;
}

int
main (void) {
  reply_ctx_t reply = {0};
  rpc_client_t client;
  assert(rpc_client_init(&client, NULL, NULL) == 0); // no fallthrough; only the tracked reply is read

  uint64_t id = rpc_client_next_id(&client);
  assert(id == 1);

  // client encodes the request and tracks the reply
  greeter_hello_request_t args = { .id = 42 };
  uint8_t *reqbuf = NULL; size_t reqlen = 0;
  assert(greeter_encode_hello(id, &args, &reqbuf, &reqlen) == 0);
  assert(rpc_client_track(&client, id, on_hello_reply, &reply) == 0);

  // server decodes + dispatches (reqmsg.data views reqbuf; free reqbuf AFTER dispatch)
  compact_state_t in = {0, reqlen, reqbuf};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);

  // on_watch is not dispatched in the unary case; dispatch only routes hello here
  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello, .on_watch = NULL };
  uint8_t *replybuf = NULL; size_t replylen = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &replybuf, &replylen) == hrpc_dispatch_reply);
  free(reqbuf);

  // client feeds the reply back; resolution fires on_hello_reply once
  assert(rpc_client_read(&client, replybuf, replylen) == 0);
  free(replybuf);

  assert(reply.count == 1);
  assert(reply.greeting == 142);

  rpc_client_destroy(&client);
  return 0;
}
`

test('e2e: unary round-trip through rpc_client_t + dispatch', { timeout: 200000 }, (t) => {
  const { schema, hrpc } = buildE2E()
  const res = runC(schema, hrpc, UNARY_MAIN_C)
  t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
})

const STREAM_MAIN_C = `
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "greeter_hrpc.h"
#include <rpc/client.h>

// server-out accumulator: on_watch appends its frames here via the handler ctx
typedef struct { uint8_t *buf; size_t len; } outbuf_t;

static void
outbuf_append (outbuf_t *o, const uint8_t *frame, size_t n) {
  uint8_t *next = realloc(o->buf, o->len + n);
  assert(next != NULL);
  o->buf = next;
  memcpy(o->buf + o->len, frame, n);
  o->len += n;
}

// server: emit open + 3 chunks + end for the watch stream
static int
on_watch (void *ctx, const greeter_watch_request_t *req, uint64_t stream_id) {
  (void) req;
  outbuf_t *o = ctx;
  uint8_t *f = NULL; size_t n = 0;

  assert(greeter_encode_watch_open(stream_id, &f, &n) == 0);
  outbuf_append(o, f, n); free(f); f = NULL;

  for (uint64_t seq = 0; seq < 3; seq++) {
    greeter_log_event_t chunk = { .seq = seq };
    assert(greeter_encode_watch_chunk(stream_id, &chunk, &f, &n) == 0);
    outbuf_append(o, f, n); free(f); f = NULL;
  }

  assert(greeter_encode_watch_end(stream_id, &f, &n) == 0);
  outbuf_append(o, f, n); free(f); f = NULL;

  return 0;
}

// client fallthrough: branch on stream flags, NOT on msg->type (the open is a
// rpc_response frame with stream=open; chunks/end are rpc_stream frames).
// decode the chunk inside the callback - its view is valid only here. This test
// has one stream, so any DATA frame is a watch chunk (a real consumer keys id).
typedef struct { int open_seen; int end_seen; int chunk_count; uint64_t seqs[8]; } stream_ctx_t;

static void
on_stream (void *data, const rpc_message_t *msg) {
  stream_ctx_t *s = data;
  if (msg->stream & rpc_stream_data) {
    greeter_log_event_t ev = {0};
    assert(greeter_decode_watch_chunk(msg, &ev) == 0);
    assert(s->chunk_count < 8);
    s->seqs[s->chunk_count++] = ev.seq;
  } else if (msg->stream & rpc_stream_end) {
    s->end_seen = 1;
  } else {
    s->open_seen = 1; // the response-stream open
  }
}

int
main (void) {
  stream_ctx_t sc = {0};
  rpc_client_t client;
  assert(rpc_client_init(&client, on_stream, &sc) == 0);

  uint64_t id = rpc_client_next_id(&client);

  greeter_watch_request_t args = { .since = 5 };
  uint8_t *reqbuf = NULL; size_t reqlen = 0;
  assert(greeter_encode_watch(id, &args, &reqbuf, &reqlen) == 0);

  // server decodes + dispatches; on_watch batches all frames (free reqbuf after)
  compact_state_t in = {0, reqlen, reqbuf};
  rpc_message_t reqmsg; memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);

  outbuf_t out = {0}; // ctx for on_watch to append its frames into
  greeter_hrpc_handlers_t handlers = { .ctx = &out, .on_hello = NULL, .on_watch = on_watch };
  uint8_t *replybuf = NULL; size_t replylen = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &replybuf, &replylen) == hrpc_dispatch_stream);
  free(reqbuf);
  assert(replybuf == NULL); // a stream dispatch writes no reply buffer

  // client feeds ALL server frames in one read (callbacks never call read)
  assert(rpc_client_read(&client, out.buf, out.len) == 0);
  free(out.buf);

  assert(sc.open_seen == 1);
  assert(sc.end_seen == 1);
  assert(sc.chunk_count == 3);
  assert(sc.seqs[0] == 0 && sc.seqs[1] == 1 && sc.seqs[2] == 2);

  rpc_client_destroy(&client);
  return 0;
}
`

test(
  'e2e: response-stream through rpc_client_t fallthrough + dispatch',
  { timeout: 200000 },
  (t) => {
    const { schema, hrpc } = buildE2E()
    const res = runC(schema, hrpc, STREAM_MAIN_C)
    t.ok(res.ok, res.ok ? 'compiled and ran' : res.stderr)
  }
)
