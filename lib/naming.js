const errors = require('./errors')

const FQN = /^@([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/

function toCName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function splitFqn(fqn) {
  const m = FQN.exec(fqn)
  if (!m) {
    throw errors.INVALID_HANDLER_NAME(
      `Invalid handler name '${fqn}', expected @namespace/kebab-name`
    )
  }
  return { ns: m[1], name: m[2] }
}

function structFromRef(ref) {
  const m = FQN.exec(ref)
  if (!m) {
    throw errors.UNSUPPORTED_TYPE(
      `Unsupported request/response type '${ref}', v1 supports @namespace/type struct references only`
    )
  }
  return toCName(m[1]) + '_' + toCName(m[2])
}

function namespacesOf(hrpc) {
  const seen = []
  for (const h of hrpc.handlers) {
    const { ns } = splitFqn(h.name)
    if (!seen.includes(ns)) seen.push(ns)
  }
  return seen
}

function targetName(hrpc) {
  return namespacesOf(hrpc).map(toCName).join('_') + '_hrpc'
}

function schemaTargetName(hrpc) {
  return namespacesOf(hrpc).map(toCName).join('_') + '_schema'
}

module.exports = { toCName, splitFqn, structFromRef, namespacesOf, targetName, schemaTargetName }
