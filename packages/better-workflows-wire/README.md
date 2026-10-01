# `@better-workflows/wire`

`@better-workflows/wire` is a small, standalone Apache-2.0 package for framing
neutral JSON values as bounded JSON Lines (JSONL). It has no dependency on the
Better Workflows core or its governance contracts, and its source imports only
Node's built-in `node:util` module.

The package is an experimental, unreleased source artifact. It does not claim
cross-platform validation, publication, production readiness, authentication,
attestation, replay protection, authorization, or any known users. A transport
adapter must provide those concerns separately when they are needed.

## Wire format

Each frame is one UTF-8 JSON object followed by `LF` (`0x0a`). `CRLF` is also
accepted by the decoder. The envelope is deliberately neutral and contains
exactly these two members:

```json
{"protocolVersion":1,"payload":{"example":"value"}}
```

`protocolVersion` is a positive safe integer describing only this framing
protocol. It is not an identity, authorization, integrity, authentication, or
attestation field. The decoder accepts only the configured version.

The encoder emits a terminal `LF`; the decoder requires it at EOF. Raw carriage
returns, invalid UTF-8, a UTF-8 BOM, trailing commas, non-finite numbers,
duplicate keys in strict mode, prototype-sensitive keys (`__proto__`,
`constructor`, and `prototype`), and unknown envelope members are rejected.
Empty lines are rejected by default and can be skipped with
`allowEmptyLines: true`. `strictJSON: false` permits duplicate JSON keys with
the usual last-member-wins result; all other safety checks remain enabled.

`maxFrameBytes` counts the complete wire frame, including `LF` (and both bytes
of `CRLF`). The decoder bounds an incomplete frame buffer by the same limit.
`maxDepth` (default and maximum `128`) bounds nested arrays and objects. Decoder calls also
have bounded input and output: `maxChunkBytes` defaults to `maxFrameBytes`,
and `maxFramesPerPush` defaults to `128`. Exceeding either per-call limit is
rejected before the chunk is appended or another frame is returned.

## API

```js
import {
  createFrameDecoder,
  createFrameEncoder,
  WireFrameError,
} from '@better-workflows/wire';

const encoder = createFrameEncoder({
  protocolVersion: 1,
  maxFrameBytes: 4096,
});
const decoder = createFrameDecoder({
  protocolVersion: 1,
  maxFrameBytes: 4096,
});

const bytes = encoder.encodeFrame({ message: '繁體中文🙂' });
const frames = [
  ...decoder.push(bytes.subarray(0, 3)),
  ...decoder.push(bytes.subarray(3)),
  ...decoder.end(),
];
// frames[0] is { protocolVersion: 1, payload: { message: '繁體中文🙂' } }
```

`createFrameEncoder(options)` returns an encoder with
`encodeFrame(payload): Uint8Array`. `createFrameDecoder(options)` returns an
incremental decoder with `push(chunk): Frame[]` and `end(): Frame[]`. `end()`
returns an empty array after all complete frames; a partial final line raises
`ERR_UNEXPECTED_EOF`. `singleFrame: true` raises `ERR_MULTIPLE_FRAMES` on a
second non-empty frame.

For one-shot use, `encodeFrame(payload, options)` and
`decodeFrames(bytes, options)` are also exported.

All rejected operations throw `WireFrameError`. Stable `code` values are:

| Code | Meaning |
| --- | --- |
| `ERR_INVALID_OPTIONS` | Invalid protocol, limit, or decoder option. |
| `ERR_INVALID_CHUNK` | Input is not `Uint8Array` or `ArrayBuffer`. |
| `ERR_CHUNK_TOO_LARGE` | One decoder `push` input exceeds `maxChunkBytes`. |
| `ERR_UNSUPPORTED_VALUE` | Payload contains a cycle, accessor, unsupported type, non-plain object, symbol key, or non-finite number. |
| `ERR_FRAME_TOO_LARGE` | Encoded frame or incomplete buffer exceeds `maxFrameBytes`. |
| `ERR_MAX_DEPTH` | JSON nesting exceeds `maxDepth`. |
| `ERR_INVALID_NEWLINE` | A bare carriage return or unsupported line ending was found. |
| `ERR_INVALID_UTF8` | A completed line is not valid UTF-8. |
| `ERR_EMPTY_LINE` | A blank line was found while `allowEmptyLines` is false. |
| `ERR_INVALID_JSON` | JSON grammar, string, number, BOM, or Unicode validation failed. |
| `ERR_DUPLICATE_KEY` | A duplicate object key was found in strict mode. |
| `ERR_FORBIDDEN_KEY` | A prototype-sensitive object key was found. |
| `ERR_INVALID_ENVELOPE` | The top-level envelope is not exactly the neutral two-member shape. |
| `ERR_UNKNOWN_PROTOCOL` | The frame version differs from the configured version. |
| `ERR_MULTIPLE_FRAMES` | A single-frame decoder received a second frame. |
| `ERR_TOO_MANY_FRAMES` | One decoder `push` would return more than `maxFramesPerPush` frames. |
| `ERR_UNEXPECTED_EOF` | EOF arrived before an LF-terminated frame. |
| `ERR_DECODER_CLOSED` | A closed or failed decoder was used again. |

## Scope and provenance

This package is physically independent: it has its own package metadata,
exports, declarations, tests, license, and notice. It does not re-export or
import Better Workflows core code and intentionally contains no task, evidence,
action, authority, receipt, replay, host-trust, policy, execution, or stop
governance types. The implementation was written for this package from the
public JSONL framing concept; no existing native-review transport source was
copied into it.

The Apache License 2.0 text in `LICENSE` is the official text from
<https://www.apache.org/licenses/LICENSE-2.0.txt>, verified on 2026-09-14.
`NOTICE` records the package provenance and the absence of third-party runtime
dependencies.
