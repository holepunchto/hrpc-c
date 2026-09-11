# Spec: hrpc-c

## Objective

A Node.js npm package that generates C source files from HRPC definitions,
following the same pattern as `hrpc-swift`. RPC authors define types with
`hyperschema` and commands with `hrpc`, then run the generator to produce `.h`
and `.c` files that encode, decode, and dispatch those commands over the
`bare-rpc` wire protocol using `librpc` and `libcompact`.

The generated C is **sans-io**: pure functions with no event loop, no imposed
allocation policy, and no per-schema runtime state. It is the C analog of what
`hrpc-swift` produces for Swift, but lowered to match how C libraries in this
ecosystem are written (`libhc`, `libcompact`, `hyperschema-c`).

First reference consumer: a small `greeter` example in the test suite. The
intended real consumers are C services that already use `hyperschema-c` for
their types and want typed RPC on top.

## Decisions

These were settled during brainstorming and a compile-and-run spike against the
real `librpc` + `libcompact`. They are recorded here so the implementation does
not relitigate them.

> A later source review (against `librpc`, `libcompact`, and `hyperschema-c`)
> found gaps in v1 and refined two of these decisions. Those changes live in
> "Spec review: amendments" near the end; where an amendment touches a decision
> or a generated-code example below, the amendment wins. The sans-io core is
> unchanged.

1. **Runtime model: sans-io codec + dispatch.** Generated code turns a typed
   call into framed request bytes, and turns a decoded message + a handler
   table into framed reply bytes. The caller owns the socket, the read loop,
   request-id allocation, and reply routing. A stateful client (id allocation,
   pending-request table, stream lifecycle) is deliberately **not** generated:
   that machinery is identical across every schema, so if it is ever wanted it
   belongs once, hand-written, in `librpc`, not re-emitted per schema. The spike
   showed the stateful variant was 68% larger for unary alone and grows fast
   with streams.

2. **Depend on `librpc`, and fix `librpc`.** Generated code calls
   `rpc_encode_message` / `rpc_decode_message`. `librpc` is the one canonical C
   definition of the `bare-rpc` wire protocol; fixing it benefits every future C
   consumer and keeps C aligned with the JS (`bare-rpc`) and Swift
   (`bare-rpc-swift`) stacks. The alternative - re-emitting framing per schema
   over `libcompact` only - was rejected as duplication and divergence. See
   "Upstream librpc work".

3. **Reuse `hyperschema-c` output for struct codecs.** The consumer generates
   `<ns>_schema.{h,c}` with `hyperschema-c` separately (as `libhc` already
   does). hrpc-c emits only the RPC layer and `#include`s the schema header,
   referencing `<ns>_<type>_t` and `<ns>_<type>_{preencode,encode,decode}`. This
   mirrors the `hrpc-swift` / `hyperschema-swift` split exactly. Field-type
   support is therefore whatever `hyperschema-c` supports; hrpc-c never
   regenerates a field codec.

4. **v1 covers all five handler kinds:** unary request/response, send-only
   event, response-stream, request-stream, and duplex. Streaming requires the
   `librpc` stream-decode fix (PR B below) before its hrpc-c PRs.

## Tech Stack

- Generator: Node.js, CommonJS, `CHRPC extends HRPCBuilder` from the `hrpc`
  package (same pattern as `SwiftHRPC`).
- Generated runtime deps: `librpc` (wire protocol) and `libcompact` (codecs),
  plus the `hyperschema-c`-generated schema target for the struct codecs.
- Build system for generated output: CMake via `bare-make`; `cmake-fetch`
  resolved from `node_modules/cmake-fetch` (same as `libhc`).
- C standard: C99.
- Test framework: `brittle`.

## Commands

```sh
npm test          # generate -> compile against librpc + libcompact + schema -> round-trip
npm run lint      # prettier --check . && lunte
npm run format    # prettier --write . && lunte --fix
```

## Project Structure

```
hrpc-c/
  index.js          # CHRPC class - extends HRPCBuilder, adds toCode() and toDisk()
  lib/
    codegen.js      # generateC(hrpc) -> { header, source }; pure functions, no classes
    cmake.js        # generateCMake(hrpc, opts) and targetName(hrpc)
    write.js        # writeToDisk(hrpc, dir, opts)
    errors.js       # factory error methods
  package.json
  SPEC.md
  README.md
  test.js           # requires the files in test/
  test/
    helpers/c.js    # generate + compile + run a C round-trip in a temp dir
    *.test.js
```

Generated output (written to a consumer-specified directory):

```
<output-dir>/
  <target>_hrpc.h    # command-id enum, client encoders, response decoders,
                     #   handler typedefs, handler table, dispatch declarations
  <target>_hrpc.c    # implementations; #include "<schema-target>.h"
  hrpc.json          # append-only command-id map (passthrough from HRPCBuilder)
  CMakeLists.txt     # OBJECT lib linking compact + rpc + the schema target
```

`<target>` is derived from the command namespaces the same way `hyperschema-c`
derives its schema target: `<ns>_hrpc` for a single namespace,
`<ns1>_<ns2>_hrpc` for multiple. The CMake target name follows the same
derivation.

## toDisk options

Mirrors `hrpc-swift`'s `writeToDisk` opts:

```js
CHRPC.toDisk(hrpc, './spec/hrpc', {
  schemaTarget: 'greeter_schema' // hyperschema-c target to #include and link
}) // defaults to the derived <ns>_schema
```

## Naming conventions

Identifiers are namespaced to avoid colliding with the `hyperschema-c` struct
codecs that share the same translation unit's headers.

| HRPC                                  | C                                              |
| ------------------------------------- | ---------------------------------------------- |
| namespace `greeter`                   | prefix `greeter_`                              |
| command `hello`                       | enum `greeter_command_hello`                   |
| command `hello` client encoder        | `greeter_encode_hello`                         |
| command `hello` response decoder      | `greeter_decode_hello_response`                |
| command `hello` server handler type   | `greeter_on_hello`                             |
| request type `@greeter/hello-request` | `greeter_hello_request_t` (from hyperschema-c) |
| handler table                         | `<target>_handlers_t`                          |
| dispatch entry point                  | `<target>_dispatch`                            |
| command `some-command` (kebab)        | `some_command` (hyphens -> underscores)        |

A command whose C name would collide with another command's, or which maps to a
C reserved word, is a generation error (see Boundaries).

## Wire protocol notes

These are the `bare-rpc` facts the generator depends on, confirmed against
`bare-rpc` and `librpc` source:

- **Framing:** each message is length-prefixed with a `uint32` written by
  `compact_encode_uint32`. `librpc` and `bare-rpc` agree on this.
- **Message types:** `rpc_request = 1`, `rpc_response = 2`, `rpc_stream = 3`.
- **Event = request with `id == 0`.** `bare-rpc` allocates request ids starting
  at 1 (`++this._id`) and reserves `id == 0` for fire-and-forget events; the
  receiver produces no reply for `id == 0`. So the C event encoder emits a
  `rpc_request` with `id = 0`, and dispatch produces no reply for an event
  command.
- **Stream flags** (`rpc.h`): `open 0x1`, `close 0x2`, `pause 0x4`,
  `resume 0x8`, `data 0x10`, `end 0x20`, `destroy 0x40`, `error 0x80`,
  `request 0x100`, `response 0x200`. Stream messages share the originating
  request's `id`.

## Generated Code Shape

### Unary request/response

For `greeter/hello` with request `@greeter/hello-request` and response
`@greeter/hello-response`:

`greeter_hrpc.h`

```c
// This file is autogenerated by hrpc-c
// !!DO NOT EDIT!!
#ifndef GREETER_HRPC_H
#define GREETER_HRPC_H

#include "greeter_schema.h"
#include <rpc.h>
#include <stddef.h>
#include <stdint.h>

enum {
  greeter_command_hello = 0,
};

// --- client ---
// Caller picks `id` (>= 1) and remembers it to route the matching response.
int
greeter_encode_hello (uint64_t id, const greeter_hello_request_t *args, uint8_t **out, size_t *out_len);

int
greeter_decode_hello_response (const rpc_message_t *msg, greeter_hello_response_t *result);

// --- server ---
typedef int (*greeter_on_hello) (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res);

typedef struct {
  void *ctx;
  greeter_on_hello on_hello;
} greeter_hrpc_handlers_t;

// Dispatch one decoded request to its handler and produce framed reply bytes.
// Caller sends *reply_out then frees it.
int
greeter_hrpc_dispatch (const greeter_hrpc_handlers_t *handlers, const rpc_message_t *msg, uint8_t **reply_out, size_t *reply_len);

#endif // GREETER_HRPC_H
```

`greeter_hrpc.c` (the encoder encodes the args struct into a payload buffer,
wraps it in a request message, and frames it; dispatch follows the same
preencode -> malloc -> encode pattern as `hyperschema-c`):

```c
#include "greeter_hrpc.h"
#include <compact.h>
#include <stdlib.h>

// Frame + encode one rpc_message into a freshly malloc'd buffer. One such
// static helper is emitted per generated source file.
static int
greeter__frame_message (const rpc_message_t *msg, uint8_t **out, size_t *out_len) {
  compact_state_t state = {0, 0, NULL};
  int err = rpc_preencode_message(&state, msg);
  if (err < 0) return err;
  state.buffer = malloc(state.end);
  if (state.buffer == NULL) return -1;
  err = rpc_encode_message(&state, msg);
  if (err < 0) { free(state.buffer); return err; }
  *out = state.buffer;
  *out_len = state.end;
  return 0;
}

int
greeter_encode_hello (uint64_t id, const greeter_hello_request_t *args, uint8_t **out, size_t *out_len) {
  compact_state_t payload = {0, 0, NULL};
  int err = greeter_hello_request_preencode(&payload, args);
  if (err < 0) return err;
  payload.buffer = malloc(payload.end);
  if (payload.buffer == NULL) return -1;
  err = greeter_hello_request_encode(&payload, args);
  if (err < 0) { free(payload.buffer); return err; }

  rpc_message_t msg = {0};
  msg.type = rpc_request;
  msg.id = id;
  msg.command = greeter_command_hello;
  msg.stream = 0;
  msg.data = payload.buffer;
  msg.len = payload.end;

  err = greeter__frame_message(&msg, out, out_len);
  free(payload.buffer);
  return err;
}
```

This is the working shape from the spike (`util.c` + `sansio.c`), compiled and
round-tripped against `librpc` + `libcompact`.

### Send-only event

For an event command `log` (`request.send: true`, no response). The encoder
emits a request with `id = 0`; there is no response decoder; dispatch invokes
the handler and returns no reply.

```c
// client
int
greeter_encode_log (const greeter_log_event_t *args, uint8_t **out, size_t *out_len); // id = 0 internally

// server
typedef void (*greeter_on_log) (void *ctx, const greeter_log_event_t *req);
// on_log lives in the same greeter_hrpc_handlers_t table; dispatch routes
// commands registered as events to it and produces no reply.
```

### Streaming (response-stream, request-stream, duplex)

Streaming stays sans-io: the generator emits typed encoders for each stream
frame and a dispatch that hands the handler the decoded head plus the stream
`id`. The caller owns the stream's lifecycle, buffering, flow control, and
transport - the generator never tracks open streams. This is lower-level than
Swift's async streams, and that is the intended trade for C.

Representative shape for a response-stream command `watch` (client sends one
request, server emits many chunks then ends):

```c
// client
int greeter_encode_watch (uint64_t id, const greeter_watch_request_t *args, uint8_t **out, size_t *out_len);
int greeter_decode_watch_chunk (const rpc_message_t *msg, greeter_log_event_t *out); // one rpc_stream_data frame

// server-side frame encoders (handler calls these, sends via its own transport)
int greeter_encode_watch_chunk (uint64_t id, const greeter_log_event_t *chunk, uint8_t **out, size_t *out_len); // rpc_stream | data
int greeter_encode_watch_end   (uint64_t id, uint8_t **out, size_t *out_len);                                   // rpc_stream | end
int greeter_encode_watch_error (uint64_t id, utf8_string_view_t message, utf8_string_view_t code, intmax_t status, uint8_t **out, size_t *out_len);

typedef int (*greeter_on_watch) (void *ctx, const greeter_watch_request_t *req, uint64_t stream_id);
```

Request-stream and duplex follow the same principle (typed frame encoders +
decoders keyed by the stream `id`, dispatch handing the handler the stream id);
their exact signatures are finalized in their PRs. Duplex generates no payload
type coupling beyond the per-direction chunk codecs.

### Generated `CMakeLists.txt`

```cmake
# This file is autogenerated by hrpc-c
# !!DO NOT EDIT!!
#
# Expects: `compact`, `rpc`, and `<schema-target>` CMake targets provided by the consumer.

cmake_minimum_required(VERSION 4.0)

project(greeter_hrpc C)

add_library(greeter_hrpc OBJECT greeter_hrpc.c)

set_target_properties(greeter_hrpc PROPERTIES C_STANDARD 99)

target_include_directories(greeter_hrpc PUBLIC .)

target_link_libraries(greeter_hrpc PUBLIC compact rpc greeter_schema)
```

## Upstream librpc work

The spike found real defects in `librpc`, confirmed from `librpc/src/rpc.c`.
These are fixed upstream so every C consumer benefits and C stays aligned with
`bare-rpc` / `bare-rpc-swift`.

**PR A (now - unblocks unary and event):**

- Change `rpc_message_t` fields `command`, `id`, `stream` to `uint64_t` and
  `status` to `int64_t`, and align all `compact_decode_*` calls accordingly.
  Today they are `uintmax_t` / `intmax_t`, which mismatch `libcompact`'s
  `uint64_t*` / `int64_t*` decoders - producing incompatible-pointer warnings
  and undefined behavior on platforms where the widths differ.
- Add round-trip tests for request and response messages.
- Add a `bare-rpc` interop fixture that exchanges base64 payloads to lock the
  wire format across JS and C.
- Optional: remove the dead `rpc_t` / `struct rps_s` typedef in `rpc.h`.

**PR B (before hrpc-c streaming PRs):**

- Fix `rpc_decode__stream` (rpc.c:266-295): it currently decodes the `stream`
  field twice (consuming an extra varint and corrupting every following field)
  and stamps the message `rpc_response` instead of `rpc_stream`. All stream
  decoding is broken until this lands.
- Add round-trip + interop tests for `rpc_stream` messages across all flag
  combinations (open, data, end, close, error).

Neither `librpc` nor `libcompact` publishes a version or git tag; consumers
`fetch_package` them by default branch (as `libhc` does), so hrpc-c does the
same. A note to tag releases upstream is filed but not blocking.

## PR sequence

Each hrpc-c PR is one vertical slice: generate -> compile -> round-trip test.

| PR    | Scope                                                                | Depends on |
| ----- | -------------------------------------------------------------------- | ---------- |
| lib A | librpc: fixed-width types + request/response tests + interop fixture | -          |
| lib B | librpc: fix rpc_decode\_\_stream + stream tests                      | lib A      |
| 1     | hrpc-c scaffold + unary codegen + CMake gen + brittle harness        | lib A      |
| 2     | event (send-only) codegen + test                                     | 1          |
| 3     | C <-> JS interop test harness (lock wire format vs bare-rpc)         | 1          |
| 4     | response-stream codegen + test                                       | 1, lib B   |
| 5     | request-stream codegen + test                                        | 4, lib B   |
| 6     | duplex codegen + test                                                | 5, lib B   |
| 7     | polish: multi-namespace naming, reserved-word/collision validation,  | 6          |
|       | error messages, README/docs                                          |            |

Critical path: lib A -> PRs 1-3; lib B -> PRs 4-6.

## Testing Strategy

- Framework: `brittle`, `test.js` requiring `test/*.test.js`.
- Per fixture: generate the C files to a temp dir, generate the matching
  `hyperschema-c` schema, write a small driver `main.c`, compile with CMake (or
  `cc` directly for unit speed) against `librpc` + `libcompact` + the schema,
  run, assert exit code 0. The binary does a round-trip: encode a request,
  dispatch it through a handler, encode the reply, decode it, assert values.
- Interop (PR 3): a JS process using `bare-rpc` and the generated C exchange
  base64-encoded framed messages and each decodes what the other encoded,
  proving wire compatibility - the C analog of `hrpc-swift`'s `test:interop`.
- Codegen unit tests: assert the generated source contains the expected
  declarations and that duplicate / reserved-word command names throw.

## Boundaries

- **Always:** validate that every request/response type resolves in the schema
  before generating; namespace every generated identifier; produce a clear
  error for an unsupported handler shape.
- **Ask first:** building a stateful C client runtime (id allocation, pending
  table, stream lifecycle) - that is a separate `librpc` effort, not generated
  code; changing the generated `CMakeLists.txt` structure; changing the
  identifier naming scheme.
- **Never:** regenerate field codecs that `hyperschema-c` already produces;
  emit per-schema runtime state; impose an event loop or threading model on the
  caller; add a handler kind beyond the five in v1 without updating this spec.

## Spec review: amendments

A source review against `librpc` (`include/rpc.h`, `src/rpc.c`), `libcompact`
(`include/compact.h`), and `hyperschema-c` (`lib/codegen.js`) found gaps in v1.
These amendments resolve them. They refine the decisions above without changing
the sans-io core; each item names the decision or section it touches and the
source fact behind it.

### A. Error responses are first-class (amends Decisions, Generated Code Shape)

`rpc_message_s` is a union (`rpc.h:45-73`): a `rpc_response` with `error == true`
carries `message` / `code` / `status`, **not** `data` (encoded at
`rpc.c:131-139`). v1 generated only the success direction, so a unary handler
could not fail, and `greeter_decode_hello_response` would decode the struct from
the wrong union arm on an error reply (undefined behavior). `bare-rpc` and
`hrpc-swift` both support error responses; hrpc-c must too.

Generated header gains a shared error type, a result enum, an error encoder, and
a revised decoder and handler signature:

```c
// Shared by every error reply and every error stream frame.
typedef struct {
  utf8_string_view_t message;
  utf8_string_view_t code;
  int64_t status; // int64_t to match librpc after lib A
} hrpc_error_t;

enum {
  hrpc_ok = 0,             // typed result filled
  hrpc_error_response = 1, // error filled; the reply is an error
};

// client: decode either a typed response or an error reply. Inspects
// msg->error internally so the caller does not. Returns hrpc_ok (fills
// *result), hrpc_error_response (fills *error), or < 0 (see E).
int
greeter_decode_hello_response (const rpc_message_t *msg, greeter_hello_response_t *result, hrpc_error_t *error);

// client/server: build an error reply for a request id.
int
greeter_encode_hello_error (uint64_t id, hrpc_error_t error, uint8_t **out, size_t *out_len);

// server: return hrpc_ok after filling *res, or hrpc_error_response after
// filling *error. dispatch frames whichever the handler chose.
typedef int (*greeter_on_hello) (void *ctx, const greeter_hello_request_t *req, greeter_hello_response_t *res, hrpc_error_t *error);
```

The streaming `*_error` encoders take the same `hrpc_error_t` instead of the
ad-hoc `message, code, status` argument triple, for one error shape everywhere.

### B. Memory and ownership (new; amends Decision 3)

The decode side aliases the source buffer, so the contract has to be explicit:

- **Encoded buffers are caller-owned.** Every `*_encode_*` / `*_dispatch` output
  is written to a buffer the caller sends and then frees (or owns directly under
  C).
- **Decoded values are non-owning views into the source frame.**
  `compact_decode_utf8` yields `utf8_string_view_t` (a pointer + len into the
  buffer), and `hyperschema-c` maps `string` / `json` to `utf8_string_view_t`
  (`codegen.js:34`). A decoded struct, and any decoded `hrpc_error_t`, point into
  `msg->data` / the inbound frame. They are valid only while that buffer lives;
  copy out anything kept past the read-loop iteration. (Switch demo: `info`'s
  `publicKey` / `topic` must be copied before the frame is freed.)
- **Decoded structs own nested heap members.** `hyperschema-c` emits
  `<type>_destroy(<type>_t *)` (`codegen.js:232`) for array / nested fields; the
  caller calls it when done with such a decoded struct. hrpc-c does not wrap or
  hide it.
- **Structs are versioned.** `hyperschema-c` structs are
  `{ uint64_t version; union { ... } }` (`codegen.js:219`). Generated encoders
  set `.version` to the type version they were generated against; handlers read
  it.

### C. Allocation-agnostic encoders (amends Decision 1)

Decision 1 says "no imposed allocation policy," but the v1 encoders call `malloc`
directly, which is a policy. Mirror `hyperschema-c`'s own split - one sizing
function, one encode-into-caller-buffer function, and a `malloc` convenience
wrapper for callers that want the v1 shape:

```c
int greeter_preencode_hello (uint64_t id, const greeter_hello_request_t *args, size_t *len);
int greeter_encode_hello_into (uint8_t *buffer, uint64_t id, const greeter_hello_request_t *args);
int greeter_encode_hello (uint64_t id, const greeter_hello_request_t *args, uint8_t **out, size_t *out_len);
```

A UI loop or arena reuses one buffer instead of taking a heap allocation per
message; non-`malloc` consumers never touch the allocator. The wrapper treats a
zero-length payload (a request type with no fields) as a valid empty buffer, not
a `malloc(0)` failure - the v1 frame helper's `return -1` conflated the two.

### D. Dispatch contract (new)

`<target>_dispatch` returns a defined result and sets the reply only when there
is one:

```c
enum {
  hrpc_dispatch_reply = 0,    // *reply_out / *reply_len set; caller sends then frees
  hrpc_dispatch_no_reply = 1, // event handled; *reply_out = NULL, *reply_len = 0
  // < 0: see E
};
```

- Event command (request `id == 0`, `response: null`) -> `hrpc_dispatch_no_reply`.
- Request handler returning `hrpc_error_response` -> dispatch frames an error
  response (`hrpc_dispatch_reply`).
- Unknown command id, or a registered command whose handler pointer is `NULL` ->
  `hrpc_err_unknown` (< 0), no reply written; the caller decides whether to drop
  or to surface a transport-level error.
- `reply_out` is set only on `hrpc_dispatch_reply`; `NULL` otherwise.

### E. Error codes (new)

One enum, distinct from `librpc`'s `rpc_error` / `rpc_partial`, so callers can
tell failures apart (the v1 frame helper returned a bare `-1` for both OOM and
encode error):

```c
enum {
  hrpc_err_alloc = -1,   // allocation failed
  hrpc_err_decode = -2,  // malformed payload / schema decode failed
  hrpc_err_unknown = -3, // no such command / NULL handler
};
```

`librpc`'s `rpc_error` / `rpc_partial` are surfaced as `hrpc_err_decode`.

### F. Command-id space (amends Naming conventions)

Enum values are the global, append-only ids from `hrpc.json`, not per-namespace
0-based counters. For a multi-namespace target there is one handler table and one
dispatch keyed by the global id. `greeter_command_hello = 0` is simply id 0 from
`hrpc.json`.

### G. The stateful client runtime ships once in librpc (amends Decision 1)

Decision 1 defers a stateful client to "if ever wanted ... in `librpc`." Every C
consumer (bare-linux first) must otherwise hand-write the same request-id
counter, pending-id -> callback table, and read-loop adapter, and each will do it
differently. Promote it to a committed sibling deliverable: ship it once,
hand-written, in `librpc` (lib C below), still not generated.

```c
// librpc, hand-written, schema-independent.
typedef struct rpc_client_s rpc_client_t;

uint64_t rpc_client_next_id (rpc_client_t *);                       // monotonic, starts at 1
int      rpc_client_track (rpc_client_t *, uint64_t id, void *cb, void *data);
// Feed inbound bytes; resolves the pending entry for a response/error by id,
// routes events/streams to a fallthrough handler. Sans-io: caller owns the socket.
int      rpc_client_read (rpc_client_t *, const uint8_t *buf, size_t len);
```

Generated code stays sans-io and plugs its typed `*_encode_*` / `*_decode_*` into
this. It is also where error responses (A) surface: a pending entry resolves with
either a typed response or an `hrpc_error_t`. An optional libuv adapter (`rpc.h`
already includes `uv.h`) can wire `rpc_client_t` to `uv_poll` for bare-kit
consumers; it lives in a separate small target, outside generated code and
outside `librpc`'s core, so non-uv consumers are unaffected.

### Testing additions (amends Testing Strategy)

- Error-response round-trip in PR 1, and a C <-> JS error interop case in PR 3
  (encode an error reply in C, decode with `bare-rpc`, and the reverse).
- A streaming interop fixture against `bare-rpc` for each stream flag in
  PRs 4-6, not round-trip only - streaming is where `librpc` was broken, so it
  needs the cross-impl lock.
- An empty-payload (zero-field type) encode/decode case for the `malloc(0)`
  guard.

### PR sequence additions (amends PR sequence)

- **lib C** (new): `librpc` `rpc_client_t` runtime + tests. Depends on lib A;
  parallel to the hrpc-c PRs. bare-linux depends on lib C.
- **PR 1** scope expands to include error-response encode / decode / dispatch
  (A) and the preencode / encode-into split (C).
- **PR 3** scope expands to include error interop.

## Open Questions

- Exact request-stream and duplex generated signatures are settled in PRs 5-6;
  the response-stream shape above is the template.
- Resolved (see "Spec review: amendments", section D): a single
  `<target>_dispatch` over the whole schema, routing by global command id and
  message shape, with a defined return enum.
- Resolved (section G): the stateful client runtime lives in `librpc` as
  `rpc_client_t`. Open sub-question: whether it stays inside `librpc` or moves to
  a separate `librpc-client` target. Leaning to keep it in `librpc` so there is
  one wire library.
- Per-handler context vs one shared `ctx` on the handler table. Spec assumes one
  shared `ctx`; revisit if a real consumer needs per-handler context.
