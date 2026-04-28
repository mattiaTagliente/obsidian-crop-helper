// Canvas-based crop component with zoom, pan, rectangle selection, and edge/corner resize.

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type State = 'idle' | 'drawing' | 'panning' | 'resizing' | 'moving';
type Edge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | null;

const HANDLE_DIST = 8; // px distance from edge to trigger resize

export class CanvasCrop {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private previewEl: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  private image: HTMLImageElement | null = null;

  // View transform (image -> canvas: cx = ix * scale + offsetX)
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private fitScale = 1;

  // Selection in IMAGE coordinates
  selection: CropRect | null = null;

  // Interaction
  private state: State = 'idle';
  private spaceHeld = false;
  private drawStart = { x: 0, y: 0 };
  private panStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private resizeEdge: Edge = null;
  private resizeOrigin: CropRect | null = null; // selection snapshot at resize start
  private moveStart = { x: 0, y: 0 }; // image coords at move start
  private resizeObserver: ResizeObserver;

  // Callbacks
  onConfirm: ((rect: CropRect) => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor(container: HTMLElement, previewContainer: HTMLElement) {
    this.canvas = container.createEl('canvas', { cls: 'crop-canvas' });
    this.ctx = this.canvas.getContext('2d')!;

    this.previewEl = previewContainer.createEl('canvas', { cls: 'crop-preview-canvas' });
    this.previewEl.width = 200;
    this.previewEl.height = 200;
    this.previewCtx = this.previewEl.getContext('2d')!;

    this.setupEvents(container);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.image) return;
      this.resizeCanvas();
      this.render();
    });
    this.resizeObserver.observe(container);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  // ── Image loading ──────────────────────────────────────────────────

  loadFromBuffer(buffer: ArrayBuffer, mimeType = 'image/png'): Promise<void> {
    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        this.image = img;
        this.selection = null;
        this.resizeCanvas();
        this.fitToWindow();
        this.render();
        resolve();
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });
  }

  /** Loaded image dimensions (render pixel size) */
  get renderWidth(): number { return this.image?.naturalWidth ?? 0; }
  get renderHeight(): number { return this.image?.naturalHeight ?? 0; }

  /** Set the initial selection rectangle (in image pixel coordinates) */
  setInitialSelection(rect: CropRect) {
    this.selection = { ...rect };
    this.render();
  }

  // ── Export ──────────────────────────────────────────────────────────

  async exportCrop(): Promise<ArrayBuffer | null> {
    if (!this.image || !this.selection) return null;
    const { x, y, width, height } = this.selection;
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(width);
    offscreen.height = Math.round(height);
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(this.image,
      Math.round(x), Math.round(y), Math.round(width), Math.round(height),
      0, 0, offscreen.width, offscreen.height);
    return new Promise((resolve) => {
      offscreen.toBlob(blob => {
        if (!blob) { resolve(null); return; }
        blob.arrayBuffer().then(resolve);
      }, 'image/png');
    });
  }

  // ── View transform ─────────────────────────────────────────────────

  private resizeCanvas() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
  }

  private fitToWindow() {
    if (!this.image) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const iw = this.image.naturalWidth;
    const ih = this.image.naturalHeight;
    this.fitScale = Math.min(cw / iw, ch / ih) * 0.95;
    this.scale = this.fitScale;
    this.offsetX = (cw - iw * this.scale) / 2;
    this.offsetY = (ch - ih * this.scale) / 2;
  }

  private canvasToImage(cx: number, cy: number) {
    return {
      x: (cx - this.offsetX) / this.scale,
      y: (cy - this.offsetY) / this.scale,
    };
  }

  // ── Hit testing ────────────────────────────────────────────────────

  /** Check if canvas point (cx, cy) is near a selection edge/corner */
  private hitTestEdge(cx: number, cy: number): Edge {
    if (!this.selection) return null;
    const s = this.selection;
    const d = HANDLE_DIST; // in canvas pixels

    const sx = s.x * this.scale + this.offsetX;
    const sy = s.y * this.scale + this.offsetY;
    const sw = s.width * this.scale;
    const sh = s.height * this.scale;

    const nearLeft = Math.abs(cx - sx) < d;
    const nearRight = Math.abs(cx - (sx + sw)) < d;
    const nearTop = Math.abs(cy - sy) < d;
    const nearBottom = Math.abs(cy - (sy + sh)) < d;
    const inHoriz = cx > sx - d && cx < sx + sw + d;
    const inVert = cy > sy - d && cy < sy + sh + d;

    // Corners first (higher priority)
    if (nearLeft && nearTop) return 'nw';
    if (nearRight && nearTop) return 'ne';
    if (nearLeft && nearBottom) return 'sw';
    if (nearRight && nearBottom) return 'se';

    // Edges
    if (nearTop && inHoriz) return 'n';
    if (nearBottom && inHoriz) return 's';
    if (nearLeft && inVert) return 'w';
    if (nearRight && inVert) return 'e';

    return null;
  }

  /** Check if canvas point is inside the selection */
  private hitTestInside(cx: number, cy: number): boolean {
    if (!this.selection) return false;
    const s = this.selection;
    const sx = s.x * this.scale + this.offsetX;
    const sy = s.y * this.scale + this.offsetY;
    const sw = s.width * this.scale;
    const sh = s.height * this.scale;
    return cx > sx && cx < sx + sw && cy > sy && cy < sy + sh;
  }

  private cursorForEdge(edge: Edge): string {
    switch (edge) {
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      default: return 'crosshair';
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────

  private setupEvents(container: HTMLElement) {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    container.tabIndex = 0;
    container.addEventListener('keydown', this.onKeyDown);
    container.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !this.spaceHeld) {
      this.spaceHeld = true;
      this.canvas.style.cursor = 'grab';
      e.preventDefault();
    }
    if (e.code === 'Enter' && this.selection) {
      e.preventDefault();
      this.onConfirm?.(this.selection);
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      this.onCancel?.();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      this.spaceHeld = false;
      this.canvas.style.cursor = 'crosshair';
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Pan: space+left or middle button
    if (e.button === 0 && this.spaceHeld || e.button === 1) {
      this.state = 'panning';
      this.panStart = { x: e.clientX, y: e.clientY, ox: this.offsetX, oy: this.offsetY };
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Resize: near an edge/corner of existing selection
    const edge = this.hitTestEdge(cx, cy);
    if (edge && this.selection) {
      this.state = 'resizing';
      this.resizeEdge = edge;
      this.resizeOrigin = { ...this.selection };
      this.drawStart = this.canvasToImage(cx, cy);
      e.preventDefault();
      return;
    }

    // Move: inside existing selection
    if (this.hitTestInside(cx, cy) && this.selection) {
      this.state = 'moving';
      this.moveStart = this.canvasToImage(cx, cy);
      this.resizeOrigin = { ...this.selection };
      this.canvas.style.cursor = 'move';
      e.preventDefault();
      return;
    }

    // Draw new selection
    this.state = 'drawing';
    const { x, y } = this.canvasToImage(cx, cy);
    this.drawStart = { x, y };
    this.selection = { x, y, width: 0, height: 0 };
    this.render();
  };

  private onMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (this.state === 'drawing') {
      const { x, y } = this.canvasToImage(cx, cy);
      const sx = Math.min(this.drawStart.x, x);
      const sy = Math.min(this.drawStart.y, y);
      const sw = Math.abs(x - this.drawStart.x);
      const sh = Math.abs(y - this.drawStart.y);
      this.selection = { x: sx, y: sy, width: sw, height: sh };
      this.render();

    } else if (this.state === 'panning') {
      this.offsetX = this.panStart.ox + (e.clientX - this.panStart.x);
      this.offsetY = this.panStart.oy + (e.clientY - this.panStart.y);
      this.render();

    } else if (this.state === 'resizing' && this.resizeOrigin && this.resizeEdge) {
      const img = this.canvasToImage(cx, cy);
      const dx = img.x - this.drawStart.x;
      const dy = img.y - this.drawStart.y;
      const o = this.resizeOrigin;

      let { x, y, width, height } = o;

      // Apply delta to the appropriate edges
      if (this.resizeEdge.includes('w')) { x += dx; width -= dx; }
      if (this.resizeEdge.includes('e')) { width += dx; }
      if (this.resizeEdge.includes('n')) { y += dy; height -= dy; }
      if (this.resizeEdge.includes('s')) { height += dy; }

      // Prevent negative dimensions (flip edges)
      if (width < 0) { x += width; width = -width; }
      if (height < 0) { y += height; height = -height; }

      this.selection = { x, y, width, height };
      this.render();

    } else if (this.state === 'moving' && this.resizeOrigin) {
      const img = this.canvasToImage(cx, cy);
      const dx = img.x - this.moveStart.x;
      const dy = img.y - this.moveStart.y;
      this.selection = {
        x: this.resizeOrigin.x + dx,
        y: this.resizeOrigin.y + dy,
        width: this.resizeOrigin.width,
        height: this.resizeOrigin.height,
      };
      this.render();

    } else if (this.state === 'idle') {
      // Update cursor based on hover position
      const edge = this.hitTestEdge(cx, cy);
      if (edge) {
        this.canvas.style.cursor = this.cursorForEdge(edge);
      } else if (this.hitTestInside(cx, cy)) {
        this.canvas.style.cursor = 'move';
      } else {
        this.canvas.style.cursor = this.spaceHeld ? 'grab' : 'crosshair';
      }
    }
  };

  private onMouseUp = () => {
    if (this.state === 'drawing' && this.selection) {
      if (this.selection.width < 5 / this.scale || this.selection.height < 5 / this.scale) {
        this.selection = null;
      }
    }
    this.state = 'idle';
    this.resizeEdge = null;
    this.resizeOrigin = null;
    this.canvas.style.cursor = this.spaceHeld ? 'grab' : 'crosshair';
    this.render();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.image) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const oldScale = this.scale;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.scale = Math.max(this.fitScale * 0.5, Math.min(this.fitScale * 20, this.scale * factor));

    this.offsetX = cx - (cx - this.offsetX) * (this.scale / oldScale);
    this.offsetY = cy - (cy - this.offsetY) * (this.scale / oldScale);
    this.render();
  };

  private onDblClick = () => {
    if (this.selection) this.onConfirm?.(this.selection);
  };

  // ── Rendering ──────────────────────────────────────────────────────

  render() {
    const { ctx, canvas, image, scale, offsetX, offsetY, selection } = this;
    if (!image) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Image
    const iw = image.naturalWidth * scale;
    const ih = image.naturalHeight * scale;
    ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight,
      offsetX, offsetY, iw, ih);

    // Selection overlay
    if (selection && selection.width > 0 && selection.height > 0) {
      const sx = selection.x * scale + offsetX;
      const sy = selection.y * scale + offsetY;
      const sw = selection.width * scale;
      const sh = selection.height * scale;

      // Dark overlay in 4 rectangles around selection
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(offsetX, offsetY, iw, sy - offsetY);
      ctx.fillRect(offsetX, sy + sh, iw, (offsetY + ih) - (sy + sh));
      ctx.fillRect(offsetX, sy, sx - offsetX, sh);
      ctx.fillRect(sx + sw, sy, (offsetX + iw) - (sx + sw), sh);

      // Selection border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);

      // Corner markers (L-shaped)
      const ms = 12;
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 3;
      for (const [cx, cy] of [[sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh]]) {
        ctx.beginPath();
        const dx = cx === sx ? 1 : -1;
        const dy = cy === sy ? 1 : -1;
        ctx.moveTo(cx + dx * ms, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * ms);
        ctx.stroke();
      }

      // Edge midpoint handles (small squares)
      const hs = 4;
      ctx.fillStyle = '#4fc3f7';
      const midpoints = [
        [sx + sw / 2, sy],           // n
        [sx + sw / 2, sy + sh],      // s
        [sx, sy + sh / 2],           // w
        [sx + sw, sy + sh / 2],      // e
      ];
      for (const [mx, my] of midpoints) {
        ctx.fillRect(mx - hs, my - hs, hs * 2, hs * 2);
      }

      // Dimensions label
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(sx, sy - 24, 120, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px monospace';
      ctx.fillText(`${Math.round(selection.width)} x ${Math.round(selection.height)}`, sx + 4, sy - 8);
    }

    this.renderPreview();
  }

  private renderPreview() {
    const pc = this.previewCtx;
    const pw = 200;
    const ph = 200;
    pc.clearRect(0, 0, pw, ph);

    if (!this.image || !this.selection || this.selection.width <= 0) {
      pc.fillStyle = '#333';
      pc.fillRect(0, 0, pw, ph);
      pc.fillStyle = '#888';
      pc.font = '13px sans-serif';
      pc.textAlign = 'center';
      pc.fillText('Draw a rectangle', pw / 2, ph / 2);
      pc.textAlign = 'start';
      return;
    }

    const { x, y, width, height } = this.selection;
    const s = Math.min(pw / width, ph / height);
    const dw = width * s;
    const dh = height * s;
    this.previewEl.width = Math.round(dw);
    this.previewEl.height = Math.round(dh);
    pc.drawImage(this.image, x, y, width, height, 0, 0, dw, dh);
  }
}
