export type ShapeKeypointRelative =
  | 'left'
  | 'right'
  | 'center'
  | 'top'
  | 'bottom'
  | 'left_bottom'
  | 'right_bottom'
  | 'top_right'
  | 'bottom_right';

/**
 * Formula metadata is injected by the host. Keeping it structural lets the
 * renderer implement geometry without importing an application shape registry.
 */
export interface ShapePathFormula {
  editable?: boolean;
  defaultValue?: readonly number[];
  range?: readonly (readonly [number, number])[];
  relative?: readonly string[];
  getBaseSize?: readonly ((width: number, height: number) => number)[];
  formula: (width: number, height: number, values?: number[]) => string;
}

export type ShapePathFormulaMap = Readonly<Record<string, ShapePathFormula>>;
