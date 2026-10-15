const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  ts = require('typescript');
function loadTs(file, override) {
  const filename = path.resolve(file),
    exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    process,
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
    Response,
    Request,
    URL,
    Date,
    Buffer,
    TextDecoder,
    Blob,
    DecompressionStream,
    Uint8Array,
    ArrayBuffer,
    DataView,
    console,
    require(name) {
      const mock = override?.(name);
      if (mock !== undefined) return mock;
      if (name.startsWith('.'))
        return loadTs(path.resolve(path.dirname(filename), name) + '.ts', override);
      return require(name);
    }
  });
  return exports;
}
module.exports = { loadTs };
