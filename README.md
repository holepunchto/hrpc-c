# hrpc-c

C code generation for [HRPC](https://github.com/holepunchto/hrpc). Generates sans-io C that encodes, decodes, and dispatches RPC commands over the bare-rpc wire protocol using [librpc](https://github.com/holepunchto/librpc) and [libcompact](https://github.com/holepunchto/libcompact), reusing struct codecs from [hyperschema-c](https://github.com/holepunchto/hyperschema-c).

Sans-io means the generated code is pure functions: it never owns a socket, an event loop, or stream state. You call the typed encoders to produce frames, hand inbound frames to the dispatcher, and do the actual I/O and stream lifecycle yourself.

## Install

```sh
npm install hrpc-c
```

## Usage

`CHRPC` extends the JS [`hrpc`](https://github.com/holepunchto/hrpc) builder. Define a schema with [`hyperschema-c`](https://github.com/holepunchto/hyperschema-c), register handlers, then write the C to disk (or get it as strings).

```js
const CHyperschema = require('hyperschema-c')
const CHRPC = require('hrpc-c')

const schema = CHyperschema.from('./spec')
const greeter = schema.namespace('greeter')
greeter.register({ name: 'hello-request', fields: [{ name: 'id', type: 'uint', required: true }] })
greeter.register({
  name: 'hello-response',
  fields: [{ name: 'greeting', type: 'uint', required: true }]
})

const hrpc = new CHRPC(schema, './spec')
hrpc.namespace('greeter').register({
  name: 'hello',
  request: { name: '@greeter/hello-request', stream: false },
  response: { name: '@greeter/hello-response', stream: false }
})

CHyperschema.toDisk(schema)
CHRPC.toDisk(hrpc) // writes to hrpc.hrpcDir, or pass an explicit dir
```

`CHRPC.toDisk(hrpc, dir, opts)` writes five files into `dir`: `hrpc.json` (the schema), `hrpc.h` (the shared, schema-independent runtime types and enums), `<target>.h` and `<target>.c` (the generated per-schema header and source), and `CMakeLists.txt`. `<target>` is the namespaces joined with `_` plus `_hrpc` (e.g. `greeter_hrpc`, or `greeter_admin_hrpc` for several namespaces). `opts.schemaTarget` overrides the CMake target name the generated `CMakeLists.txt` expects for the hyperschema-c structs (default `<namespaces>_schema`). `CHRPC.toCode(opts)` returns `{ shared, header, source }` as strings instead of writing.

The generated `CMakeLists.txt` expects the consumer to provide `compact`, `rpc`, and the schema target as CMake targets.

## Generated surface

Identifiers are namespaced `<ns>_...` and command ids are the global, append-only ids from the schema. Each handler is one of five kinds, by its `request`/`response` shape:

- **unary** (`request` + `response`, neither streaming): `<ns>_encode_<name>` (client request), `<ns>_encode_<name>_error`, `<ns>_decode_<name>_response`, and a handler `int (*<ns>_on_<name>)(void *ctx, const <req>_t *req, <res>_t *res, hrpc_error_t *error)`.
- **event** (`request.send: true`, no `response`): `<ns>_encode_<name>` (fire-and-forget, id 0) and a `void (*<ns>_on_<name>)(void *ctx, const <req>_t *req)`.
- **response-stream** (`response.stream: true`): the client request encoder plus server frame encoders `_open` / `_chunk` / `_end` / `_error`, a client `_stream_open` echo, a `_decode_<name>_chunk`, and `int (*on)(ctx, req, uint64_t stream_id)`.
- **request-stream** (`request.stream: true`): client `_open` / `_chunk` / `_end`, server `_stream_open` echo + `_decode_<name>_chunk`, a single unary-style reply (`_response` / `_error` encoders + `_decode_<name>_response`), and `int (*on)(ctx, uint64_t stream_id)`.
- **duplex** (both streaming): the union of the two stream directions, fully `request_`/`response_` qualified (`_request_open`, `_request_chunk`, `_request_end`, `_response_open`, `_response_chunk`, `_response_end`, `_response_error`, the two `_stream_open` echoes, and both `_decode_*_chunk`), with `int (*on)(ctx, uint64_t stream_id)`.

Every `*_encode_*` heap-allocates `*out` (the caller frees). Decoded views (`hrpc_error_t` strings, chunk payloads) point into the inbound frame buffer, so copy out anything kept past the read loop.

## Dispatch

`<target>_dispatch(const <target>_handlers_t *handlers, const rpc_message_t *msg, uint8_t **reply_out, size_t *reply_len)` routes one decoded inbound `rpc_request` by command id to the matching handler, and returns one of:

- `hrpc_dispatch_reply` - a unary reply was written to `*reply_out` / `*reply_len`; send it, then free it.
- `hrpc_dispatch_no_reply` - an event was handled; nothing to send.
- `hrpc_dispatch_stream` - a stream was opened; the handler drives the frames over `msg->id` via its own transport. No reply buffer is written.
- `< 0` - an error code (`hrpc_err_unknown`, `hrpc_err_decode`, `hrpc_err_alloc`).

Dispatch only sees the inbound request that opens a conversation. Subsequent stream frames carry only a stream id (not a command), so routing them by id - and the open handshake, flow control, and lifecycle - is the caller's responsibility (a job for a stateful client runtime such as `librpc`'s `rpc_client_t`).

See [`SPEC.md`](./SPEC.md) for the full design.

## License

Apache-2.0
