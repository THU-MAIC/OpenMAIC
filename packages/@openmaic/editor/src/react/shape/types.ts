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

/** Formula metadata consumed by the editor geometry runtime. */
export interface ShapePathFormula {
  editable?: boolean;
  defaultValue?: readonly number[];
  range?: readonly (readonly [number, number])[];
  relative?: readonly string[];
  getBaseSize?: readonly ((width: number, height: number) => number)[];
  formula: (width: number, height: number, values?: number[]) => string;
}

export type ShapePathFormulaMap = Readonly<Record<string, ShapePathFormula>>;
