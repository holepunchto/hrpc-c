module.exports = class CodegenError extends Error {
  constructor(msg, code, fn = CodegenError) {
    super(`${code}: ${msg}`)
    this.code = code
    if (Error.captureStackTrace) Error.captureStackTrace(this, fn)
  }

  get name() {
    return 'CodegenError'
  }

  static INVALID_HANDLER_NAME(msg) {
    return new CodegenError(msg, 'INVALID_HANDLER_NAME', CodegenError.INVALID_HANDLER_NAME)
  }

  static DUPLICATE_COMMAND_NAME(msg) {
    return new CodegenError(msg, 'DUPLICATE_COMMAND_NAME', CodegenError.DUPLICATE_COMMAND_NAME)
  }

  static UNSUPPORTED_TYPE(msg) {
    return new CodegenError(msg, 'UNSUPPORTED_TYPE', CodegenError.UNSUPPORTED_TYPE)
  }

  static MISSING_RESPONSE(msg) {
    return new CodegenError(msg, 'MISSING_RESPONSE', CodegenError.MISSING_RESPONSE)
  }

  static UNSUPPORTED_HANDLER(msg) {
    return new CodegenError(msg, 'UNSUPPORTED_HANDLER', CodegenError.UNSUPPORTED_HANDLER)
  }
}
