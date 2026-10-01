/** JSON values accepted by the wire encoder. */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Frame {
  readonly protocolVersion: number;
  readonly payload: JsonValue;
}

export interface FrameOptions {
  /** Transport protocol version carried in the neutral envelope. Defaults to 1. */
  readonly protocolVersion?: number;
  /** Maximum encoded frame size, including its line ending. Defaults to 65536. */
  readonly maxFrameBytes?: number;
  /** Maximum nesting depth accepted by the serializer. Defaults to 128. */
  readonly maxDepth?: number;
}

export interface FrameDecoderOptions extends FrameOptions {
  /** Skip blank lines. Defaults to false. */
  readonly allowEmptyLines?: boolean;
  /** Reject duplicate JSON object keys. Defaults to true. */
  readonly strictJSON?: boolean;
  /** Reject a second non-empty frame. Defaults to false. */
  readonly singleFrame?: boolean;
  /** Maximum bytes accepted in one push call. Defaults to maxFrameBytes. */
  readonly maxChunkBytes?: number;
  /** Maximum non-empty frames returned by one push call. Defaults to 128. */
  readonly maxFramesPerPush?: number;
}

export class WireFrameError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface FrameEncoder {
  readonly protocolVersion: number;
  readonly maxFrameBytes: number;
  readonly maxDepth: number;
  encodeFrame(payload: JsonValue): Uint8Array;
}

export interface FrameDecoder {
  readonly protocolVersion: number;
  readonly maxFrameBytes: number;
  readonly maxDepth: number;
  readonly maxChunkBytes: number;
  readonly maxFramesPerPush: number;
  readonly framesDecoded: number;
  push(chunk: Uint8Array | ArrayBuffer): Frame[];
  end(): Frame[];
}

export function createFrameEncoder(options?: FrameOptions): FrameEncoder;
export function createFrameDecoder(options?: FrameDecoderOptions): FrameDecoder;
export function encodeFrame(payload: JsonValue, options?: FrameOptions): Uint8Array;
export function decodeFrames(
  bytes: Uint8Array | ArrayBuffer,
  options?: FrameDecoderOptions,
): Frame[];
