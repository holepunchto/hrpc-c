// Cross-language conformance: decode hrpc-test's schema-free wire vectors in
// C via librpc, and assert the decoded rpc_message_t matches the fixture
// descriptor exactly. This proves a second, non-JS implementation reads what
// the JS-generated fixtures say the bytes mean, rather than JS echoing itself.
const test = require('brittle')
const { runCRaw, toCArray } = require('./helpers/c')

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
}
