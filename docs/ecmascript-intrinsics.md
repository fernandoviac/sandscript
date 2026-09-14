# ECMAScript Well-Known Intrinsic Objects

A reference of the well-known intrinsic objects defined in the ECMAScript specification.

## What Are Intrinsics?

From the [ECMAScript specification](https://tc39.es/ecma262/#sec-well-known-intrinsic-objects):

> Well-known intrinsics are built-in objects that are explicitly referenced by the algorithms of this specification and which usually have realm-specific identities. Unless otherwise specified each intrinsic object actually corresponds to a set of similar objects, one per realm. Within this specification a reference such as %name% means the intrinsic object, associated with the current realm, corresponding to the name.

The `%Name%` notation denotes an **internal reference** that bypasses normal scope lookup. When the spec says "throw a TypeError", it means use the intrinsic `%TypeError%`, not look up `TypeError` in scope. This is why:

```javascript
let TypeError = 42;
null.foo;  // Still throws a real TypeError, not 42
```

The engine uses internal references to the original constructors, making them unshadowable by user code.

## Complete Intrinsics Table

### Core Objects

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %Object% | Object | Object constructor |
| %ObjectPrototype% | Object.prototype | Prototype for all objects |
| %Function% | Function | Function constructor |
| %FunctionPrototype% | Function.prototype | Prototype for functions |

### Primitive Wrappers

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %Boolean% | Boolean | Boolean constructor |
| %BooleanPrototype% | Boolean.prototype | Prototype for boolean values |
| %Number% | Number | Number constructor |
| %NumberPrototype% | Number.prototype | Prototype for number values |
| %String% | String | String constructor |
| %StringPrototype% | String.prototype | Prototype for string values |
| %Symbol% | Symbol | Symbol constructor |
| %SymbolPrototype% | Symbol.prototype | Prototype for symbol values |
| %BigInt% | BigInt | BigInt constructor (ES2020) |
| %BigIntPrototype% | BigInt.prototype | Prototype for bigint values |

### Error Types

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %Error% | Error | Error constructor |
| %ErrorPrototype% | Error.prototype | Prototype for error objects |
| %TypeError% | TypeError | TypeError constructor |
| %TypeErrorPrototype% | TypeError.prototype | Prototype for TypeError objects |
| %ReferenceError% | ReferenceError | ReferenceError constructor |
| %ReferenceErrorPrototype% | ReferenceError.prototype | Prototype for ReferenceError objects |
| %RangeError% | RangeError | RangeError constructor |
| %RangeErrorPrototype% | RangeError.prototype | Prototype for RangeError objects |
| %SyntaxError% | SyntaxError | SyntaxError constructor |
| %SyntaxErrorPrototype% | SyntaxError.prototype | Prototype for SyntaxError objects |
| %EvalError% | EvalError | EvalError constructor |
| %EvalErrorPrototype% | EvalError.prototype | Prototype for EvalError objects |
| %URIError% | URIError | URIError constructor |
| %URIErrorPrototype% | URIError.prototype | Prototype for URIError objects |
| %AggregateError% | AggregateError | AggregateError constructor (ES2021) |
| %AggregateErrorPrototype% | AggregateError.prototype | Prototype for AggregateError objects |

### Collections

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %Array% | Array | Array constructor |
| %ArrayPrototype% | Array.prototype | Prototype for array objects |
| %ArrayIteratorPrototype% | — | Prototype for array iterators |
| %Map% | Map | Map constructor |
| %MapPrototype% | Map.prototype | Prototype for Map objects |
| %Set% | Set | Set constructor |
| %SetPrototype% | Set.prototype | Prototype for Set objects |
| %WeakMap% | WeakMap | WeakMap constructor |
| %WeakMapPrototype% | WeakMap.prototype | Prototype for WeakMap objects |
| %WeakSet% | WeakSet | WeakSet constructor |
| %WeakSetPrototype% | WeakSet.prototype | Prototype for WeakSet objects |

### Typed Arrays

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %TypedArray% | — | Abstract superclass of typed arrays |
| %TypedArrayPrototype% | — | Prototype for typed array objects |
| %ArrayBuffer% | ArrayBuffer | ArrayBuffer constructor |
| %ArrayBufferPrototype% | ArrayBuffer.prototype | Prototype for ArrayBuffer objects |
| %SharedArrayBuffer% | SharedArrayBuffer | SharedArrayBuffer constructor |
| %SharedArrayBufferPrototype% | SharedArrayBuffer.prototype | Prototype for SharedArrayBuffer objects |
| %DataView% | DataView | DataView constructor |
| %DataViewPrototype% | DataView.prototype | Prototype for DataView objects |
| %Int8Array% | Int8Array | Int8Array constructor |
| %Uint8Array% | Uint8Array | Uint8Array constructor |
| %Uint8ClampedArray% | Uint8ClampedArray | Uint8ClampedArray constructor |
| %Int16Array% | Int16Array | Int16Array constructor |
| %Uint16Array% | Uint16Array | Uint16Array constructor |
| %Int32Array% | Int32Array | Int32Array constructor |
| %Uint32Array% | Uint32Array | Uint32Array constructor |
| %Float32Array% | Float32Array | Float32Array constructor |
| %Float64Array% | Float64Array | Float64Array constructor |
| %BigInt64Array% | BigInt64Array | BigInt64Array constructor |
| %BigUint64Array% | BigUint64Array | BigUint64Array constructor |

### Async & Generators

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %AsyncFunction% | AsyncFunction | Async function constructor |
| %AsyncFunctionPrototype% | — | Prototype for async functions |
| %AsyncGeneratorFunction% | AsyncGeneratorFunction | Async generator function constructor |
| %AsyncGeneratorFunctionPrototype% | — | Prototype for async generator functions |
| %AsyncGeneratorPrototype% | — | Prototype for async generator objects |
| %GeneratorFunction% | GeneratorFunction | Generator function constructor |
| %GeneratorFunctionPrototype% | — | Prototype for generator functions |
| %GeneratorPrototype% | — | Prototype for generator objects |
| %AsyncFromSyncIteratorPrototype% | — | Prototype for async-from-sync iterators |
| %Promise% | Promise | Promise constructor |
| %PromisePrototype% | Promise.prototype | Prototype for Promise objects |

### Other Built-ins

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %JSON% | JSON | JSON namespace object |
| %Math% | Math | Math namespace object |
| %Reflect% | Reflect | Reflect namespace object |
| %Proxy% | Proxy | Proxy constructor |
| %RegExp% | RegExp | RegExp constructor |
| %RegExpPrototype% | RegExp.prototype | Prototype for RegExp objects |
| %Date% | Date | Date constructor |
| %DatePrototype% | Date.prototype | Prototype for Date objects |
| %Atomics% | Atomics | Atomics namespace object |
| %WeakRef% | WeakRef | WeakRef constructor (ES2021) |
| %WeakRefPrototype% | WeakRef.prototype | Prototype for WeakRef objects |
| %FinalizationRegistry% | FinalizationRegistry | FinalizationRegistry constructor (ES2021) |
| %FinalizationRegistryPrototype% | FinalizationRegistry.prototype | Prototype for FinalizationRegistry objects |

### Global Functions

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %eval% | eval | eval function |
| %isFinite% | isFinite | isFinite function |
| %isNaN% | isNaN | isNaN function |
| %parseFloat% | parseFloat | parseFloat function |
| %parseInt% | parseInt | parseInt function |
| %decodeURI% | decodeURI | decodeURI function |
| %decodeURIComponent% | decodeURIComponent | decodeURIComponent function |
| %encodeURI% | encodeURI | encodeURI function |
| %encodeURIComponent% | encodeURIComponent | encodeURIComponent function |
| %ThrowTypeError% | — | Function that unconditionally throws TypeError |

### Iterator Prototypes

| Intrinsic | Global Name | Description |
|-----------|-------------|-------------|
| %IteratorPrototype% | — | Base prototype for all iterators |
| %ArrayIteratorPrototype% | — | Prototype for array iterators |
| %StringIteratorPrototype% | — | Prototype for string iterators |
| %MapIteratorPrototype% | — | Prototype for Map iterators |
| %SetIteratorPrototype% | — | Prototype for Set iterators |
| %RegExpStringIteratorPrototype% | — | Prototype for RegExp string iterators |
| %SegmentIteratorPrototype% | — | Prototype for Intl.Segmenter iterators |

---

## Prototype Chain Structure

The error prototype chain:

```
Object.prototype (proto = null)
  └── Error.prototype
        ├── TypeError.prototype
        ├── ReferenceError.prototype
        ├── RangeError.prototype
        ├── SyntaxError.prototype
        ├── EvalError.prototype
        ├── URIError.prototype
        └── AggregateError.prototype
```

The iterator prototype chain:

```
Object.prototype (proto = null)
  └── %IteratorPrototype%
        ├── %ArrayIteratorPrototype%
        ├── %StringIteratorPrototype%
        ├── %MapIteratorPrototype%
        ├── %SetIteratorPrototype%
        ├── %RegExpStringIteratorPrototype%
        └── %GeneratorPrototype%
              └── %AsyncGeneratorPrototype%
```

The typed array prototype chain:

```
Object.prototype (proto = null)
  └── %TypedArrayPrototype%
        ├── Int8Array.prototype
        ├── Uint8Array.prototype
        ├── Uint8ClampedArray.prototype
        ├── Int16Array.prototype
        ├── Uint16Array.prototype
        ├── Int32Array.prototype
        ├── Uint32Array.prototype
        ├── Float32Array.prototype
        ├── Float64Array.prototype
        ├── BigInt64Array.prototype
        └── BigUint64Array.prototype
```

---

## References

- [ECMAScript 2024 Specification - Well-Known Intrinsic Objects](https://tc39.es/ecma262/#sec-well-known-intrinsic-objects)
- [ES6 Well-Known Intrinsics Gist](https://gist.github.com/RReverser/14bdeea873d978b26918)
- [get-intrinsic npm package](https://github.com/ljharb/get-intrinsic)
- [TC39 Proposal: Get Intrinsic](https://github.com/tc39/proposal-get-intrinsic)
