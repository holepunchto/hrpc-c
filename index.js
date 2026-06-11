const HRPC = require('hrpc')
const generateC = require('./lib/codegen')
const writeToDisk = require('./lib/write')

class CHRPC extends HRPC {
  toCode(opts = {}) {
    return generateC(this, opts)
  }

  static toDisk(hrpc, dir, opts = {}) {
    if (typeof dir === 'object' && dir !== null && !Array.isArray(dir)) {
      opts = dir
      dir = null
    }
    if (!dir) dir = hrpc.hrpcDir
    writeToDisk(hrpc, dir, opts)
  }
}

module.exports = CHRPC
