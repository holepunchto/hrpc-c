const test = require('brittle')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('..')
const { runC } = require('./helpers/c')

const MAIN_C = `
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "greeter_hrpc.h"

// id == 0 is rejected with an error reply; otherwise greeting = id + 100.
static int
on_hello (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error) {
  (void) ctx;
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
roundtrip_success (void) {
  greeter_hello_request_t args = { .id = 42 };

  uint8_t *reqbuf = NULL;
  size_t reqlen = 0;
  assert(greeter_encode_hello(7, &args, &reqbuf, &reqlen) == 0);

  compact_state_t in = {0, reqlen, reqbuf};
  rpc_message_t reqmsg;
  memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);
  assert(reqmsg.type == rpc_request);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello };
  uint8_t *replybuf = NULL;
  size_t replylen = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &replybuf, &replylen) == hrpc_dispatch_reply);

  compact_state_t rin = {0, replylen, replybuf};
  rpc_message_t respmsg;
  memset(&respmsg, 0, sizeof(respmsg));
  assert(rpc_decode_message(&rin, &respmsg) == 0);
  assert(respmsg.type == rpc_response);
  assert(respmsg.id == 7);

  greeter_hello_response_t res;
  memset(&res, 0, sizeof(res));
  hrpc_error_t error;
  memset(&error, 0, sizeof(error));
  assert(greeter_decode_hello_response(&respmsg, &res, &error) == hrpc_ok);
  assert(res.greeting == 142);

  free(reqbuf);
  free(replybuf);
}

static void
roundtrip_error (void) {
  greeter_hello_request_t args = { .id = 0 };

  uint8_t *reqbuf = NULL;
  size_t reqlen = 0;
  assert(greeter_encode_hello(9, &args, &reqbuf, &reqlen) == 0);

  compact_state_t in = {0, reqlen, reqbuf};
  rpc_message_t reqmsg;
  memset(&reqmsg, 0, sizeof(reqmsg));
  assert(rpc_decode_message(&in, &reqmsg) == 0);

  greeter_hrpc_handlers_t handlers = { .ctx = NULL, .on_hello = on_hello };
  uint8_t *replybuf = NULL;
  size_t replylen = 0;
  assert(greeter_hrpc_dispatch(&handlers, &reqmsg, &replybuf, &replylen) == hrpc_dispatch_reply);

  compact_state_t rin = {0, replylen, replybuf};
  rpc_message_t respmsg;
  memset(&respmsg, 0, sizeof(respmsg));
  assert(rpc_decode_message(&rin, &respmsg) == 0);
  assert(respmsg.type == rpc_response);

  greeter_hello_response_t res;
  memset(&res, 0, sizeof(res));
  hrpc_error_t error;
  memset(&error, 0, sizeof(error));
  assert(greeter_decode_hello_response(&respmsg, &res, &error) == hrpc_error_response);
  assert(error.status == 400);
  assert(error.code.len == 6);
  assert(memcmp(error.code.data, "BAD_ID", 6) == 0);

  free(reqbuf);
  free(replybuf);
}

int
main (void) {
  roundtrip_success();
  roundtrip_error();
  return 0;
}
`

test(
  'unary hello compiles and round-trips (success + error) through generated C',
  { timeout: 200000 },
  (t) => {
    const schema = CHyperschema.from(null)
    const ns = schema.namespace('greeter')
    ns.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
    ns.register({
      name: 'hello-response',
      fields: [{ name: 'greeting', type: 'uint', required: true }]
    })

    const hrpc = new CHRPC(schema, null, {})
    hrpc.namespace('greeter').register({
      name: 'hello',
      request: { name: '@greeter/hello-request', stream: false },
      response: { name: '@greeter/hello-response', stream: false }
    })

    const result = runC(schema, hrpc, MAIN_C)
    t.ok(result.ok, result.ok ? 'compiled and ran' : `failed:\n${result.stderr}`)
  }
)
