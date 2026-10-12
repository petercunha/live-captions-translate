#!/usr/bin/env node
// Copies the runtime libraries the extension needs from node_modules into
// extension/vendor/. MV3 extensions cannot load remote code, so the speech
// engines' JS and WASM must ship inside the extension.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'extension', 'vendor');

async function copyInto(dir, files) {
  await mkdir(join(VENDOR, dir), { recursive: true });
  for (const [from, name] of files) await copyFile(join(NM, from), join(VENDOR, dir, name));
  console.log(`vendor/${dir}: ${files.length} files`);
}

await rm(VENDOR, { recursive: true, force: true });

// Moonshine Voice (streaming ASR + Silero VAD), compiled to WASM.
const moonshineDist = '@moonshine-ai/moonshine-wasm/dist';
const moonshineFiles = (await readdir(join(NM, moonshineDist)))
  .filter((f) => /\.(js|mjs|wasm)$/.test(f))
  .map((f) => [join(moonshineDist, f), f]);
await copyInto('moonshine', moonshineFiles);

// The Moonshine downloader caches every model file with the Cache API, which
// only accepts http(s) keys and throws on the chrome-extension:// URLs of the
// bundled models. Skip the cache for those; they are local files anyway.
const downloader = join(VENDOR, 'moonshine', 'asset-downloader.js');
const original = await readFile(downloader, 'utf8');
const needle = 'const cache = await this.openCache();';
if (!original.includes(needle)) throw new Error('asset-downloader.js changed upstream; update the patch in scripts/vendor.mjs');
await writeFile(downloader, original.replace(needle, 'const cache = /^https?:/i.test(url) ? await this.openCache() : undefined;'));

// Emscripten's embind glue builds its JS<->WASM call wrappers with
// `new Function`, which MV3's content security policy forbids (no
// 'unsafe-eval' for extension pages). Swap in closure-based equivalents with
// the same semantics (what Emscripten emits with -sDYNAMIC_EXECUTION=0).
function replaceBetween(source, start, end, replacement, what) {
  const i = source.indexOf(start);
  const j = i < 0 ? -1 : source.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`moonshine.mjs: ${what} not found; update the patch in scripts/vendor.mjs`);
  return source.slice(0, i) + replacement + source.slice(j + end.length);
}
const glue = join(VENDOR, 'moonshine', 'moonshine.mjs');
let code = await readFile(glue, 'utf8');
code = replaceBetween(code,
  'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){',
  'return createNamedFunction(humanName,invokerFn)}',
  `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
  var argCount=argTypes.length;
  if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}
  var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
  var needsDestructorStack=usesDestructorStack(argTypes);
  var returns=argTypes[0].name!=="void";
  var invokerFn=function(...args){
    var destructors=needsDestructorStack?[]:null;
    var thisWired;
    var argsWired=[];
    var callArgs=[cppTargetFunc];
    if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);callArgs.push(thisWired)}
    for(var i=0;i<argCount-2;++i){argsWired.push(argTypes[i+2].toWireType(destructors,args[i]))}
    var rv=cppInvokerFunc(...callArgs,...argsWired);
    if(needsDestructorStack){runDestructors(destructors)}
    else{for(var i=isClassMethodFunc?1:2;i<argCount;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:argsWired[i-2])}}}
    if(returns){return argTypes[0].fromWireType(rv)}
  };
  return createNamedFunction(humanName,invokerFn)}`,
  'embind invoker');
code = replaceBetween(code,
  'var functionBody=`return function (obj, func, destructorsRef, args) {',
  'var invokerFunction=new Function(...params,functionBody)(...args);',
  `var invokerFunction=(obj,func,destructorsRef,argsPtr)=>{
  var values=[];var offset=0;
  for(var i=0;i<argCount;++i){values.push(types[i].readValueFromPointer(argsPtr+offset));offset+=types[i].argPackAdvance}
  var rv=kind===1?new func(...values):kind===0?func.call(obj,...values):func.call(...values);
  if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,rv)}};`,
  'emval method caller');
if (code.includes('new Function')) throw new Error('moonshine.mjs still uses new Function');
// ONNX Runtime sizes its thread pool to every logical core, and idle pool
// threads spin. Four threads keep live captioning ~30% cheaper on CPU than ten
// for only ~0.1 s of extra latency per update (measured on an M1 Max).
code = replaceBetween(code,
  'var _emscripten_num_logical_cores=()=>',
  ';',
  'var _emscripten_num_logical_cores=()=>Math.min(4,ENVIRONMENT_IS_NODE?require("os").cpus().length:navigator["hardwareConcurrency"]);',
  'core count');
await writeFile(glue, code);

// Transformers.js (Whisper). transformers.min.js bundles the ONNX Runtime JS;
// only its WASM factory and binary are loaded separately.
await copyInto('transformers', [['@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js']]);
await copyInto('ort', [
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
]);

// ONNX Runtime's Emscripten glue has the same `new Function` in its emval
// method caller (newer Emscripten layout, minified). Replace the generated
// caller with a closure: kind 0 = call, 1 = method call, 2 = construct,
// 3 = pass the value through. The identifiers are the minified names in the
// pinned versions; the assertion below fires if an upgrade renames them.
function emvalCaller([kind, readers, toValue, getName, toWire, returnValue, isVoid]) {
  return `((kind,readers,toValue,getName,toWire,returnValue,isVoid)=>function(handle,methodName,destructorsRef,args){` +
    `var v=readers.map((read,i)=>read(args+8*i));` +
    `var rv=kind===3?v[v.length-1]:kind===2?new(toValue(handle))(...v):kind===1?toValue(handle)[getName(methodName)](...v):toValue(handle)(...v);` +
    `if(!isVoid)return returnValue(toWire,destructorsRef,rv)})(${kind},${readers},${toValue},${getName},${toWire},${returnValue},${isVoid})`;
}
for (const [file, call, assign, names] of [
  ['ort/ort-wasm-simd-threaded.asyncify.mjs', '(new Function(Object.keys(k),h))(...Object.values(k))', 'c=',
    ['c', 'f', 'R', 'Yg', 'b', 'Wg', 'd.we']],
  ['transformers/transformers.min.js', 'new Function(Object.keys(N),P)(...Object.values(N))', 'h=',
    ['h', 'T', 'Dt', 'yc', 'd', 'tI', 'g.we']],
]) {
  const path = join(VENDOR, file);
  const source = await readFile(path, 'utf8');
  if (!source.includes(assign + call) || source.split('new Function').length !== 2) {
    throw new Error(`${file}: emval caller not found; update the patch in scripts/vendor.mjs`);
  }
  await writeFile(path, source.replace(assign + call, assign + emvalCaller(names)));
}
