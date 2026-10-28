import type { Vec } from './geom';

export type PenKind = 'pencil' | 'ink';

/** ISO 128 line types used in the app. */
export type LineType = 'solid' | 'dashed' | 'dashdot' | 'dashdotdot' | 'freehand';

export interface Style {
  pen: PenKind;
  /** Nominal line width in mm. */
  width: number;
  lineType: LineType;
  /** Custom colour, or null for the pen's standard colour (graphite / black). */
  color: string | null;
  /** Pencil lead: light (2H), medium (HB, default) or dark (2B). */
  hardness?: Hardness;
}

export type Hardness = '2H' | 'HB' | '2B';

interface EntityBase {
  id: string;
  layerId: string;
  /** Draw order within a layer (higher = on top). */
  z: number;
  style: Style;
}

export interface LineEntity extends EntityBase {
  kind: 'line';
  a: Vec;
  b: Vec;
  /** Marked as symmetry axis. */
  axis?: boolean;
  /** For axes: new drawing is mirrored across it. */
  mirror?: boolean;
}

export interface StrokeEntity extends EntityBase {
  kind: 'stroke';
  /** Flat point list [x0, y0, x1, y1, …] in mm. */
  pts: number[];
}

export interface CircleEntity extends EntityBase {
  kind: 'circle';
  c: Vec;
  r: number;
  /** Draw a centre-line cross. */
  mark?: boolean;
}

/**
 * Circular arc. Angles are in world coordinates (radians, y pointing down), so a
 * positive sweep turns clockwise on screen. The arc runs from `start` to `start + sweep`.
 */
export interface ArcEntity extends EntityBase {
  kind: 'arc';
  c: Vec;
  r: number;
  start: number;
  sweep: number;
  mark?: boolean;
}

/** Hatch patterns (DIN ISO 128-50 / DIN 201 style). */
export type HatchPattern = 'diag' | 'diag2' | 'cross' | 'steel' | 'plastic' | 'dots';

/** Hatched area: closed loops (outer outline and holes, even-odd). */
export interface HatchEntity extends EntityBase {
  kind: 'hatch';
  /** Flat point lists [x0, y0, x1, y1, …] of closed loops in mm. */
  loops: number[][];
  pattern: HatchPattern;
  /** Extra rotation of the pattern in degrees (world, clockwise on screen). */
  angle: number;
  /** Line spacing in mm. */
  spacing: number;
  /** Gap tolerance (mm) the area was found with; used when it follows changes. */
  gap?: number;
}

/**
 * Dimension (DIN 406 / ISO 129):
 * - lin: distance p1–p2 measured along direction `dir` (radians), dimension line
 *   offset by `off` mm along the normal of dir from p1;
 * - dia: diameter of the circle with centre p1 through p2 (direction of the line);
 * - rad: radius from centre p1 to p2;
 * - ang: angle at vertex p1 between rays to p2 and p3, arc radius `off`.
 */
export interface DimEntity extends EntityBase {
  kind: 'dim';
  type: 'lin' | 'dia' | 'rad' | 'ang';
  p1: Vec;
  p2: Vec;
  p3?: Vec;
  dir?: number;
  off: number;
  /** Text instead of the measured value. */
  text?: string;
  /**
   * Position of the figure: linear – mm along the dimension line from its middle;
   * diameter/radius – mm from the centre along the line (default: half the
   * radius); angle – radians from the middle of the arc.
   */
  tpos?: number;
}

export type GpsSymbol =
  | 'straightness'
  | 'flatness'
  | 'circularity'
  | 'cylindricity'
  | 'profileLine'
  | 'profileSurface'
  | 'parallelism'
  | 'perpendicularity'
  | 'angularity'
  | 'position'
  | 'concentricity'
  | 'symmetry'
  | 'runout'
  | 'totalRunout';

/** Datum feature symbol (ISO 5459): filled triangle on the feature at `at`, letter frame at `p`. */
export interface DatumEntity extends EntityBase {
  kind: 'datum';
  at: Vec;
  p: Vec;
  letter: string;
}

/** Geometrical tolerance frame (ISO 1101) at `p`, leader with arrow to the feature at `at`. */
export interface GtolEntity extends EntityBase {
  kind: 'gtol';
  at: Vec;
  p: Vec;
  sym: GpsSymbol;
  value: string;
  /** Tolerance zone is a diameter (Ø before the value). */
  dia: boolean;
  datums: string[];
}

/** Free text (ISO 3098 style lettering); `at` is the start of the first baseline. */
export interface TextEntity extends EntityBase {
  kind: 'text';
  at: Vec;
  /** Lines separated by \n. */
  text: string;
  /** Letter height in mm. */
  size: number;
  /** Direction of writing (radians, world). */
  angle: number;
}

// ---- Technische Mechanik (Freikörperbild) -------------------------------------

/** Festlager, Loslager, Einspannung, Gelenk. */
export type SupportType = 'fixed' | 'roller' | 'clamp' | 'hinge';

/**
 * Support symbol at `at` on the part. `angle` (radians, world) points from the
 * part towards the ground, i.e. "down" for a beam lying on its supports.
 */
export interface SupportEntity extends EntityBase {
  kind: 'support';
  type: SupportType;
  at: Vec;
  angle: number;
}

/**
 * Point load: arrow from the tail `p` with its tip at the point of application `at`.
 * `label` like "F_1" or "F_1 = 500 N" (an underscore starts a subscript).
 */
export interface ForceEntity extends EntityBase {
  kind: 'force';
  at: Vec;
  p: Vec;
  label: string;
}

/**
 * Moment: curved arrow around `c` with radius `r`, running from `start` by `sweep`
 * (radians, world; negative sweep = counter-clockwise on screen). Arrowhead at the end.
 */
export interface MomentEntity extends EntityBase {
  kind: 'moment';
  c: Vec;
  r: number;
  start: number;
  sweep: number;
  label: string;
}

/**
 * Line load (Streckenlast) acting on the feature from `a` to `b`: a row of arrows
 * whose tails sit `h` mm away (signed, along the left normal of a→b).
 */
export interface LineLoadEntity extends EntityBase {
  kind: 'lineload';
  a: Vec;
  b: Vec;
  h: number;
  label: string;
}

export type MechEntity = SupportEntity | ForceEntity | MomentEntity | LineLoadEntity;

export type SheetFormat = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';

export interface TitleFields {
  title: string;
  number: string;
  material: string;
  drawnBy: string;
  date: string;
  company: string;
}

/**
 * Drawing sheet (ISO 5457 frame, ISO 7200 style title block). `at` is the top-left
 * corner of the trimmed sheet in world mm; the sheet is `scale` times the paper
 * size in the world (scale 2 = drawn at 1:2, 0.5 = 2:1).
 */
export interface SheetEntity extends EntityBase {
  kind: 'sheet';
  at: Vec;
  format: SheetFormat;
  landscape: boolean;
  scale: number;
  fields: TitleFields;
}

export type Entity =
  | LineEntity
  | StrokeEntity
  | CircleEntity
  | ArcEntity
  | HatchEntity
  | DimEntity
  | DatumEntity
  | GtolEntity
  | TextEntity
  | SheetEntity
  | MechEntity;

/** Annotations don't take part in trimming, erasing or geometric snapping. */
export type Annotation = HatchEntity | DimEntity | DatumEntity | GtolEntity | TextEntity | SheetEntity | MechEntity;

/** Annotations drawn from a layout of lines, fills and texts (all but hatches). */
export type LaidOut = Exclude<Annotation, HatchEntity>;

export function isAnnotation(e: Entity): e is Annotation {
  return e.kind === 'hatch' || e.kind === 'dim' || e.kind === 'datum' || e.kind === 'gtol' || e.kind === 'text' || e.kind === 'sheet' || isMech(e);
}

/** Supports, forces, moments and line loads (free-body diagram symbols). */
export function isMech(e: Entity): e is MechEntity {
  return e.kind === 'support' || e.kind === 'force' || e.kind === 'moment' || e.kind === 'lineload';
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Shown faded, like a sketch under tracing paper. */
  dimmed: boolean;
}

export interface ViewState {
  scale: number;
  rot: number;
  tx: number;
  ty: number;
}

/** Serialised document (file format and autosave). */
/**
 * A change in a form other devices can apply (live editing): entities are put or
 * deleted as a whole, layers sent as the full list. Applying one twice is harmless.
 * `vis` records showing/hiding a layer (each device keeps its own view; it is
 * only kept in the journal).
 */
export type SyncOp =
  | { t: 'put'; e: Entity }
  | { t: 'del'; id: string }
  | { t: 'layers'; layers: Layer[] }
  | { t: 'scale'; scale: number }
  | { t: 'vis'; id: string; visible: boolean; dimmed: boolean };

/**
 * One step of the drawing's history (for the timelapse): what changed and when.
 * A `base` entry stands for everything drawn before the history was kept.
 */
export interface JournalEntry {
  t: number;
  ops: SyncOp[];
  base?: true;
}

export interface DocFile {
  format: 'skizzen-cad';
  version: 1;
  layers: Layer[];
  activeLayerId: string;
  entities: Entity[];
  nextZ: number;
  /** Drawing scale (world mm per paper mm); missing in files from before it existed. */
  scale?: number;
  /** How the drawing came about, step by step (missing in older files). */
  journal?: JournalEntry[];
  view?: ViewState;
}
