# hrpc-c

C code generation for [HRPC](https://github.com/holepunchto/hrpc). Generates sans-io C
that encodes, decodes, and dispatches RPC commands over the bare-rpc wire protocol using
[librpc](https://github.com/holepunchto/librpc) and
[libcompact](https://github.com/holepunchto/libcompact), reusing struct codecs from
[hyperschema-c](https://github.com/holepunchto/hyperschema-c).

See `SPEC.md` for the design.

## License

Apache-2.0
