import type { CaptureResult, RawNode } from "./capture.js";

export interface NormalizedNode extends RawNode {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  aspectRatio: number;
  areaRatio: number;
  textLengthLog: number;
}

export interface NormalizedCapture {
  url: string;
  viewport: { width: number; height: number };
  nodes: NormalizedNode[];
}

export function normalize(cap: CaptureResult): NormalizedCapture {
  const { width: vw, height: vh } = cap.viewport;
  const vArea = vw * vh;
  const nodes: NormalizedNode[] = cap.nodes.map((n) => {
    const area = n.w * n.h;
    return {
      ...n,
      nx: n.x / vw,
      ny: n.y / vh,
      nw: n.w / vw,
      nh: n.h / vh,
      aspectRatio: n.h === 0 ? 0 : n.w / n.h,
      areaRatio: vArea === 0 ? 0 : area / vArea,
      textLengthLog: Math.log10(n.textLength + 1),
    };
  });
  return { url: cap.url, viewport: cap.viewport, nodes };
}
