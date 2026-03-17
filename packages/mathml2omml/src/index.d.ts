export interface MML2OMMLOptions {
  /**
   * Whether to disable XML decoding of input
   */
  disableDecode?: boolean
}

/**
 * Convert MathML to Office Open XML Math (OMML) format
 *
 * @param mmlString - MathML string to convert
 * @param options - Optional configuration options
 * @returns OMML string
 */
export function mml2omml(mmlString: string, options?: MML2OMMLOptions): string

/**
 * MML2OMML class for converting MathML to OMML
 */
export class MML2OMML {
  /**
   * Construct a new MML2OMML converter
   *
   * @param mmlString - MathML string to convert
   * @param options - Optional configuration options
   */
  constructor(mmlString: string, options?: MML2OMMLOptions)

  /**
   * Run the conversion process
   */
  run(): void

  /**
   * Get the resulting OMML as a string
   *
   * @returns OMML string
   */
  getResult(): string
}
