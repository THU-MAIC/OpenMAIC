/** OOXML line geometries, excluding filled flowChart*Connector symbols. */
export function isLinePreset(preset: string | undefined): boolean {
  return /^(?:line(?:Inv)?|straightConnector1|(?:bent|curved)Connector[2-5])$/i.test(preset ?? '');
}
