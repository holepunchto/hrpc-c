const { spawnSync } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const CHyperschema = require('hyperschema-c')
const CHRPC = require('../..')
const { targetName, schemaTargetName } = require('../../lib/naming')

const WORKSPACE = path.join(__dirname, '../c-workspace')
const SCHEMA_DIR = path.join(WORKSPACE, 'schema')
const HRPC_DIR = path.join(WORKSPACE, 'hrpc')
const BARE_MAKE = path.join(__dirname, '../../node_modules/.bin/bare-make')
const CMAKE_FETCH = path.join(__dirname, '../../node_modules/cmake-fetch').replace(/\\/g, '/')
const TIMEOUT = 180000

function workspaceCMake(hrpc) {
  const target = targetName(hrpc)
  const schema = schemaTargetName(hrpc)
  return (
    [
      'cmake_minimum_required(VERSION 4.0)',
      `find_package(cmake-fetch REQUIRED PATHS "${CMAKE_FETCH}")`,
      'project(hrpc_test C)',
      'fetch_package("github:holepunchto/libcompact")',
      'fetch_package("github:holepunchto/librpc")',
      'add_subdirectory(schema)',
      'add_subdirectory(hrpc)',
      'add_executable(hrpc_test main.c)',
      'set_target_properties(hrpc_test PROPERTIES C_STANDARD 99)',
      // utf is linked explicitly: compact/rpc call libutf inline helpers that
      // stay external in a debug build, so utf's objects must be on the link line.
      `target_link_libraries(hrpc_test PRIVATE ${target} ${schema} rpc compact utf)`
    ].join('\n') + '\n'
  )
}

// schema: a CHyperschema (hyperschema-c) instance; hrpc: a CHRPC built over it.
function runC(schema, hrpc, mainC) {
  fs.mkdirSync(SCHEMA_DIR, { recursive: true })
  fs.mkdirSync(HRPC_DIR, { recursive: true })

  CHyperschema.toDisk(schema, SCHEMA_DIR)
  CHRPC.toDisk(hrpc, HRPC_DIR, { schemaTarget: schemaTargetName(hrpc) })
  fs.writeFileSync(path.join(WORKSPACE, 'main.c'), mainC)
  fs.writeFileSync(path.join(WORKSPACE, 'CMakeLists.txt'), workspaceCMake(hrpc))

  const shell = os.platform() === 'win32'

  const gen = spawnSync(BARE_MAKE, ['generate', '--debug'], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: TIMEOUT,
    shell
  })
  if (gen.error || gen.status !== 0) {
    return { ok: false, stderr: gen.error ? gen.error.message : gen.stdout + gen.stderr }
  }

  const build = spawnSync(BARE_MAKE, ['build'], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: TIMEOUT,
    shell
  })
  if (build.error || build.status !== 0) {
    return { ok: false, stderr: build.error ? build.error.message : build.stdout + build.stderr }
  }

  const exe = path.join(
    WORKSPACE,
    'build',
    os.platform() === 'win32' ? 'hrpc_test.exe' : 'hrpc_test'
  )
  const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 10000 })
  if (run.error) return { ok: false, stderr: run.error.message }

  return { ok: run.status === 0, stdout: run.stdout || '', stderr: run.stderr || '' }
}

module.exports = { runC }
