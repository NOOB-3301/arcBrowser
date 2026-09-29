import * as THREE from 'three';
import type { MapInfo } from '../world/World';
import { SPLAT } from '../world/Heightmap';

const RES = 1024;
const GRID = 6;

/** Full-screen tactical map: shaded relief, roads, water, POIs, extracts, player arrow. */
export class MapView {
  open = false;
  private el: HTMLElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private map: MapInfo) {
    this.el = document.createElement('div');
    this.el.className = 'mapview';
    this.el.innerHTML = `
      <div class="mapview-frame">
        <div class="mapview-title">${map.def.name.toUpperCase()}<small>M / View to close</small></div>
        <div class="mapview-canvas"></div>
        <div class="mapview-legend"><span class="lg-x">⇪ Extraction</span><span class="lg-p">◆ Point of interest</span><span class="lg-me">▲ You</span></div>
      </div>`;
    document.getElementById('ui')!.appendChild(this.el);
    const holder = this.el.querySelector('.mapview-canvas')!;
    const base = this.renderBase();
    base.className = 'mapview-base';
    holder.appendChild(base);
    this.overlay = document.createElement('canvas');
    this.overlay.width = this.overlay.height = RES;
    this.overlay.className = 'mapview-overlay';
    holder.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d')!;
  }

  toggle(): void {
    this.open = !this.open;
    this.el.classList.toggle('open', this.open);
  }

  private toPx(x: number, z: number): [number, number] {
    const s = RES / this.map.hm.size;
    return [(x + this.map.hm.half) * s, (z + this.map.hm.half) * s];
  }

  private renderBase(): HTMLCanvasElement {
    const { hm, def, gen } = this.map;
    const c = document.createElement('canvas');
    c.width = c.height = RES;
    const g = c.getContext('2d')!;
    const img = g.createImageData(RES, RES);
    const light = new THREE.Vector3(-1, 1.4, -1).normalize();
    const n = new THREE.Vector3();
    const palette: [number, number, number][] = [
      [96, 112, 70], // grass
      [112, 96, 70], // dirt
      [128, 124, 118], // rock
      [170, 156, 120], // sand
      [58, 58, 60], // asphalt
      [168, 166, 160], // concrete
    ];
    for (let py = 0; py < RES; py++) {
      const z = (py / RES) * hm.size - hm.half;
      for (let px = 0; px < RES; px++) {
        const x = (px / RES) * hm.size - hm.half;
        const h = hm.sample(x, z);
        hm.normal(x, z, n);
        const shade = 0.55 + 0.6 * Math.max(0, n.dot(light));
        const ix = Math.round((x + hm.half) / hm.cell);
        const iz = Math.round((z + hm.half) / hm.cell);
        const si = (iz * hm.n + ix) * 6;
        let r = 0;
        let gg = 0;
        let b = 0;
        for (let k = 0; k < 6; k++) {
          const w = hm.splat[si + k] / 255;
          r += palette[k][0] * w;
          gg += palette[k][1] * w;
          b += palette[k][2] * w;
        }
        const wet = hm.wet[iz * hm.n + ix] / 255;
        const water = (wet > 0.5 && h < def.waterLevel) || (wet > 0.6 && def.rivers.length > 0 && h < 6 && hm.splat[si + SPLAT.sand] > 60);
        // Contours every 10 m
        const contour = Math.abs((h % 10) - 5) > 4.6 ? 0.82 : 1;
        const o = (py * RES + px) * 4;
        if (water) {
          img.data[o] = 44;
          img.data[o + 1] = 82;
          img.data[o + 2] = 96;
        } else {
          img.data[o] = r * shade * contour;
          img.data[o + 1] = gg * shade * contour;
          img.data[o + 2] = b * shade * contour;
        }
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // Roads
    for (const road of gen.roads) {
      g.strokeStyle = road.surface === 'asphalt' ? 'rgba(40,40,40,0.85)' : 'rgba(120,100,70,0.8)';
      g.lineWidth = road.surface === 'asphalt' ? 3 : 2;
      g.beginPath();
      road.points.forEach((p, i) => {
        const [x, y] = this.toPx(p.x, p.z);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }
    // Grid
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '14px system-ui, sans-serif';
    for (let i = 1; i < GRID; i++) {
      const p = (i / GRID) * RES;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, RES);
      g.moveTo(0, p);
      g.lineTo(RES, p);
      g.stroke();
    }
    for (let i = 0; i < GRID; i++) {
      g.fillText(String.fromCharCode(65 + i), ((i + 0.5) / GRID) * RES - 4, 16);
      g.fillText(String(i + 1), 6, ((i + 0.5) / GRID) * RES + 5);
    }
    // POIs
    g.textAlign = 'center';
    for (const p of def.pois) {
      const [x, y] = this.toPx(p.center[0], p.center[1]);
      g.fillStyle = p.tier >= 3 ? '#ff8a2a' : p.tier === 2 ? '#ffd28a' : '#f1ead8';
      g.beginPath();
      g.moveTo(x, y - 7);
      g.lineTo(x + 7, y);
      g.lineTo(x, y + 7);
      g.lineTo(x - 7, y);
      g.fill();
      g.font = 'bold 15px system-ui, sans-serif';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 4;
      g.strokeText(p.name.toUpperCase(), x, y - 12);
      g.fillText(p.name.toUpperCase(), x, y - 12);
    }
    // Extracts
    for (const e of this.map.extracts) {
      const [x, y] = this.toPx(e.pos.x, e.pos.z);
      g.fillStyle = '#5cffb0';
      g.font = 'bold 20px system-ui, sans-serif';
      g.strokeText('⇪', x, y + 7);
      g.fillText('⇪', x, y + 7);
      g.font = '12px system-ui, sans-serif';
      g.strokeText(e.def.name, x, y + 22);
      g.fillText(e.def.name, x, y + 22);
    }
    return c;
  }

  /** Draw the player marker (call every frame while open). */
  update(pos: THREE.Vector3, yaw: number): void {
    if (!this.open) return;
    const g = this.ctx;
    g.clearRect(0, 0, RES, RES);
    const [x, y] = this.toPx(pos.x, pos.z);
    g.save();
    g.translate(x, y);
    g.rotate(-yaw);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -12);
    g.lineTo(8, 9);
    g.lineTo(0, 4);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.beginPath();
    g.arc(x, y, 18 + Math.sin(performance.now() / 200) * 3, 0, Math.PI * 2);
    g.stroke();
  }
}
