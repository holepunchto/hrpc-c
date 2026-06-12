const fs = require('fs')
const path = require('path')
const generateC = require('./codegen')
const generateCMake = require('./cmake')
const { targetName } = require('./naming')

module.exports = function writeToDisk(hrpc, dir, opts = {}) {
  const root = path.resolve(dir)
  fs.mkdirSync(root, { recursive: true })

  const target = targetName(hrpc)
  const { shared, header, source } = generateC(hrpc, opts)

  fs.writeFileSync(path.join(root, 'hrpc.json'), JSON.stringify(hrpc.toJSON(), null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'hrpc.h'), shared)
  fs.writeFileSync(path.join(root, `${target}.h`), header)
  fs.writeFileSync(path.join(root, `${target}.c`), source)
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), generateCMake(hrpc, opts))
}
