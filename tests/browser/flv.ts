/** Independent container reader: validate offsets and PreviousTagSize, not muxer internals. */
export function readFlv(bytes: number[]) {
  const data = Uint8Array.from(bytes);
  const view = new DataView(data.buffer);
  const uint24 = (offset: number) =>
    data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };

  check(
    String.fromCharCode(...data.slice(0, 3)) === "FLV",
    "Missing FLV header"
  );
  check(data[3] === 1 && data[4] === 5, "Expected FLV v1 with audio and video");
  let offset = view.getUint32(5);
  check(view.getUint32(offset) === 0, "Invalid first PreviousTagSize");
  offset += 4;

  const video: { key: boolean; timestamp: number; data: number[] }[] = [];
  const audio: { timestamp: number; data: number[] }[] = [];
  const timestamps: number[] = [];
  let videoConfig: number[] = [];
  let audioConfig: number[] = [];
  let metadata = 0;

  while (offset < data.length) {
    check(offset + 15 <= data.length, "Truncated tag header");
    const type = data[offset];
    const size = uint24(offset + 1);
    const timestamp = uint24(offset + 4) + data[offset + 7] * 16777216;
    const end = offset + 11 + size;
    check(end + 4 <= data.length, "Truncated tag body");
    check(uint24(offset + 8) === 0, "Nonzero stream ID");
    check(view.getUint32(end) === size + 11, "Invalid PreviousTagSize");
    const body = data.slice(offset + 11, end);

    if (type === 9) {
      check(body.length >= 5 && (body[0] & 15) === 7, "Expected AVC video");
      if (body[1] === 0) {
        videoConfig = Array.from(body.slice(5));
      } else if (body[1] === 1) {
        check(videoConfig.length > 0, "Video data precedes configuration");
        const composition = uint24(offset + 13);
        check(composition === 0, "Expected realtime video without B-frames");
        let nalu = 5;
        const lengthSize = (videoConfig[4] & 3) + 1;
        while (nalu < body.length) {
          check(nalu + lengthSize <= body.length, "Truncated NALU length");
          let length = 0;
          for (let i = 0; i < lengthSize; i++)
            length = length * 256 + body[nalu++];
          check(length > 0 && nalu + length <= body.length, "Truncated NALU");
          nalu += length;
        }
        video.push({
          key: body[0] >> 4 === 1,
          timestamp,
          data: Array.from(body.slice(5)),
        });
        timestamps.push(timestamp);
      }
    } else if (type === 8) {
      check(body.length >= 2 && body[0] >> 4 === 10, "Expected AAC audio");
      if (body[1] === 0) audioConfig = Array.from(body.slice(2));
      else {
        check(
          body[1] === 1 && audioConfig.length > 0,
          "Invalid AAC packet order"
        );
        audio.push({ timestamp, data: Array.from(body.slice(2)) });
        timestamps.push(timestamp);
      }
    } else {
      check(type === 18, "Unexpected FLV tag type");
      metadata++;
    }

    offset = end + 4;
  }

  check(offset === data.length, "Trailing partial tag");
  return { video, audio, videoConfig, audioConfig, timestamps, metadata };
}
