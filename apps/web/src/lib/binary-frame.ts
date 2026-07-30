import {
  BinaryFrameHeaderSchema,
  type BinaryFrameHeader,
} from "@edgesh/contracts";

export type DecodedBinaryFrame = {
  header: BinaryFrameHeader;
  payload: Uint8Array;
};

export function decodeBinaryFrame(buffer: ArrayBuffer): DecodedBinaryFrame {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 5) throw new Error("Binary frame is truncated");

  const headerLength = new DataView(buffer).getUint32(0);
  if (headerLength < 2 || headerLength > 16 * 1024 || 4 + headerLength >= bytes.byteLength) {
    throw new Error("Binary frame header is invalid");
  }

  const rawHeader = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(4, 4 + headerLength),
  );
  const result = BinaryFrameHeaderSchema.safeParse(JSON.parse(rawHeader) as unknown);
  if (!result.success) throw new Error("Binary frame header is invalid");

  const payload = bytes.subarray(4 + headerLength);
  if (payload.byteLength !== result.data.payloadBytes) {
    throw new Error("Binary frame payload size does not match its header");
  }
  return { header: result.data, payload };
}

export function encodeBinaryFrame(header: BinaryFrameHeader, payload: Uint8Array): ArrayBuffer {
  if (payload.byteLength !== header.payloadBytes) {
    throw new Error("Binary frame payload size does not match its header");
  }
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + encodedHeader.byteLength + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, encodedHeader.byteLength);
  frame.set(encodedHeader, 4);
  frame.set(payload, 4 + encodedHeader.byteLength);
  return frame.buffer;
}
