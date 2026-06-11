import HRPC from 'hrpc'

declare class CHRPC extends HRPC {
  toCode(opts?: object): { header: string; source: string }
  static toDisk(hrpc: HRPC, dir?: string | null, opts?: object): void
}

export = CHRPC
