const test = require('brittle')
const fs = require('fs')
const path = require('path')
const createTmp = require('test-tmp')
const Hyperschema = require('hyperschema')
const CHRPC = require('..')

test('toDisk writes the five output files', async (t) => {
  const dir = await createTmp(t)

  const schema = new Hyperschema()
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

  CHRPC.toDisk(hrpc, dir, { schemaTarget: 'greeter_schema' })

  for (const f of ['hrpc.json', 'hrpc.h', 'greeter_hrpc.h', 'greeter_hrpc.c', 'CMakeLists.txt']) {
    t.ok(fs.existsSync(path.join(dir, f)), `wrote ${f}`)
  }

  const cmake = fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8')
  t.ok(cmake.includes('add_library(greeter_hrpc OBJECT greeter_hrpc.c)'))
  t.ok(cmake.includes('target_link_libraries(greeter_hrpc PUBLIC compact rpc greeter_schema)'))

  const hrpcJson = JSON.parse(fs.readFileSync(path.join(dir, 'hrpc.json'), 'utf8'))
  t.is(hrpcJson.schema[0].name, '@greeter/hello')
})

test('toCode returns shared, header, and source strings', (t) => {
  const schema = new Hyperschema()
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

  const out = hrpc.toCode({ schemaTarget: 'greeter_schema' })
  t.ok(out.shared.includes('hrpc_error_t'))
  t.ok(out.header.includes('greeter_hrpc_dispatch'))
  t.ok(out.source.includes('greeter_hrpc__frame'))
})
