// libsignal hace require('assert') y lo usa como función; el polyfill "empty" la deja como objeto vacío.
// CommonJS para que el require devuelva la función y no { default }
module.exports = function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); };
