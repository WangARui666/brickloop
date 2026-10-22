/** Minimal ISO-BMFF reader for the actual muxed AVC track, including chunk/sample tables. */
export function inspectAnimationMp4(data: Buffer) {
  type Box = { type: string; start: number; body: number; end: number };
  const boxes = (start: number, end: number): Box[] => {
    const out: Box[] = [];
    for (let p = start; p + 8 <= end;) {
      const size = data.readUInt32BE(p),
        extended = size === 1,
        n = extended ? Number(data.readBigUInt64BE(p + 8)) : size || end - p;
      if (n < (extended ? 16 : 8) || p + n > end) throw new Error('Invalid MP4 box');
      out.push({ type: data.toString('ascii', p + 4, p + 8), start: p, body: p + (extended ? 16 : 8), end: p + n });
      p += n;
    }
    return out;
  };
  const roots = boxes(0, data.length),
    requireBox = (list: Box[], type: string) => {
      const b = list.find((b) => b.type === type);
      if (!b) throw new Error(`Missing ${type}`);
      return b;
    };
  const child = (parent: Box, type: string) => requireBox(boxes(parent.body, parent.end), type);
  const moov = requireBox(roots, 'moov');
  requireBox(roots, 'ftyp');
  const mdat = requireBox(roots, 'mdat');
  const mdia = child(child(moov, 'trak'), 'mdia'),
    mdhd = child(mdia, 'mdhd');
  const version = data[mdhd.body]!,
    timescale = data.readUInt32BE(mdhd.body + (version ? 20 : 12));
  const duration =
    (version ? Number(data.readBigUInt64BE(mdhd.body + 24)) : data.readUInt32BE(mdhd.body + 16)) / timescale;
  const stbl = child(child(mdia, 'minf'), 'stbl'),
    sizes = child(stbl, 'stsz'),
    count = data.readUInt32BE(sizes.body + 8),
    fixed = data.readUInt32BE(sizes.body + 4);
  const lengths = Array.from({ length: count }, (_, i) => fixed || data.readUInt32BE(sizes.body + 12 + i * 4));
  const tables = boxes(stbl.body, stbl.end),
    chunks = tables.find((b) => b.type === 'stco' || b.type === 'co64')!;
  const offsets = Array.from({ length: data.readUInt32BE(chunks.body + 4) }, (_, i) =>
    chunks.type === 'co64'
      ? Number(data.readBigUInt64BE(chunks.body + 8 + i * 8))
      : data.readUInt32BE(chunks.body + 8 + i * 4),
  );
  const stsc = child(stbl, 'stsc'),
    runs = Array.from({ length: data.readUInt32BE(stsc.body + 4) }, (_, i) => ({
      first: data.readUInt32BE(stsc.body + 8 + i * 12),
      count: data.readUInt32BE(stsc.body + 12 + i * 12),
    }));
  const stts = child(stbl, 'stts'),
    durations: number[] = [];
  for (let i = 0; i < data.readUInt32BE(stts.body + 4); i++)
    for (let n = 0; n < data.readUInt32BE(stts.body + 8 + i * 8); n++)
      durations.push(data.readUInt32BE(stts.body + 12 + i * 8));
  const stss = tables.find((b) => b.type === 'stss'),
    keys = stss
      ? new Set(
          Array.from({ length: data.readUInt32BE(stss.body + 4) }, (_, i) => data.readUInt32BE(stss.body + 8 + i * 4)),
        )
      : null;
  const stsd = child(stbl, 'stsd'),
    avc1 = requireBox(boxes(stsd.body + 8, stsd.end), 'avc1'),
    avcc = requireBox(boxes(avc1.body + 78, avc1.end), 'avcC');
  const description = Array.from(data.subarray(avcc.body, avcc.end));
  const codec = 'avc1.' + data.subarray(avcc.body + 1, avcc.body + 4).toString('hex');
  const spsLength = data.readUInt16BE(avcc.body + 6),
    sps = data.subarray(avcc.body + 9, avcc.body + 8 + spsLength);
  const rbsp = Array.from(sps).filter((byte, i) => !(byte === 3 && i >= 2 && sps[i - 1] === 0 && sps[i - 2] === 0));
  let bit = 0;
  const bits = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + ((rbsp[bit >>> 3]! >>> (7 - (bit % 8))) & 1);
      bit++;
    }
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (bits(1) === 0) {
      if (++zeros > 31) throw new Error('Invalid SPS');
    }
    return 2 ** zeros - 1 + bits(zeros);
  };
  const profile = bits(8);
  bits(8);
  bits(8);
  ue();
  let chromaFormat = 1,
    bitDepth = 8;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = ue();
    if (chromaFormat === 3) bits(1);
    bitDepth = ue() + 8;
  }
  const samples: { timestamp: number; duration: number; key: boolean; data: number[] }[] = [];
  let sample = 0,
    timestamp = 0;
  offsets.forEach((offset, i) => {
    const run = [...runs].reverse().find((r) => r.first <= i + 1)!;
    let cursor = offset;
    for (let j = 0; j < run.count; j++) {
      const length = lengths[sample]!,
        d = durations[sample]!;
      if (cursor < mdat.body || cursor + length > mdat.end) throw new Error('Sample outside mdat');
      samples.push({
        timestamp: Math.round((timestamp / timescale) * 1e6),
        duration: Math.round((d / timescale) * 1e6),
        key: keys?.has(sample + 1) ?? true,
        data: Array.from(data.subarray(cursor, cursor + length)),
      });
      sample++;
      cursor += length;
      timestamp += d;
    }
  });
  return {
    boxes: roots.map((b) => b.type),
    duration,
    count,
    codec,
    description,
    samples,
    fastStart: moov.start < mdat.start,
    chromaFormat,
    bitDepth,
    trackCount: boxes(moov.body, moov.end).filter((b) => b.type === 'trak').length,
  };
}
