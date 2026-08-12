declare module 'parse-srcset' {
  export interface SrcsetCandidate {
    url: string;
    w?: number;
    d?: number;
    h?: number;
  }

  export default function parseSrcset(value: string): SrcsetCandidate[];
}
