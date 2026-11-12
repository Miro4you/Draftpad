/**
 * Draftpad inside another app (e.g. MathPad).
 *
 * The editor brings its own page-wide styles and keyboard handling, so a host
 * runs it in its own document – typically a same-origin iframe whose script
 * calls `mountDraftpad`. To only show a drawing (no editor, no styles), import
 * `drawingToSvg` from `export/drawing-svg` instead.
 */
import './styles.css';
import { setLabelResolver } from './core/annotations';
import type { DocFile } from './core/types';
import { startShell } from './shell';

export { drawingToSvg, type DrawingSvg, type DrawingSvgOptions } from './export/drawing-svg';
export { setLabelResolver } from './core/annotations';
export type { DocFile } from './core/types';

export interface DraftpadOptions {
  /** The host's drawing to start with (null/undefined = empty). */
  drawing?: unknown | null;
  /** Reduced tool set for quick sketches (default true). */
  compact?: boolean;
  /** Called (debounced, and on flush) with the drawing after changes. */
  onChange: (file: DocFile) => void;
  /** Shows a "done" button in the top bar. */
  onDone?: () => void;
  doneLabel?: string;
  /**
   * Menu item to switch between the compact and the full tool set. The host
   * should flush, then start the editor again with `compact` flipped.
   */
  onToggleCompact?: () => void;
  /** Page and pen colours (default: as the system). */
  theme?: 'light' | 'dark' | 'system';
  /** Shown text for labels of forces, moments and line loads (e.g. "F_1" → "F_1 = 500 N"). */
  labelResolver?: (label: string) => string;
}

export interface DraftpadHandle {
  /** The current drawing (without the timelapse journal). */
  getDrawing(): DocFile;
  /** Hand pending changes to onChange right away (e.g. before closing). */
  flush(): void;
  /** Label texts changed in the host (e.g. new variable values): redraw them. */
  refreshLabels(): void;
  setTheme(theme: 'light' | 'dark' | 'system'): void;
}

export function mountDraftpad(root: HTMLElement, opts: DraftpadOptions): DraftpadHandle {
  setLabelResolver(opts.labelResolver ?? null);
  const app = startShell(root, {
    drawing: opts.drawing ?? null,
    compact: opts.compact ?? true,
    onChange: opts.onChange,
    onDone: opts.onDone,
    doneLabel: opts.doneLabel,
    onToggleCompact: opts.onToggleCompact,
  });
  if (opts.theme) app.updateSettings({ theme: opts.theme });
  return {
    getDrawing: () => {
      const { journal: _journal, ...file } = app.doc.toFile(app.cam.state);
      return file;
    },
    flush: () => void app.saveNow(),
    refreshLabels: () => {
      setLabelResolver(opts.labelResolver ?? null);
      app.redrawAll();
    },
    setTheme: (theme) => app.updateSettings({ theme }),
  };
}
