import type * as THREE from 'three';
import type { MapInfo } from '../world/World';

const WIDTH = 520;
const FOV_DEG = 120;
const LABELS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

/** Heading strip at the top of the screen with extraction markers. */
export class Compass {
  private el: HTMLElement;
  private strip: HTMLElement;
  private heading: HTMLElement;
  private markers: { el: HTMLElement; pos: THREE.Vector3; dist: HTMLElement }[] = [];

  constructor(map: MapInfo | undefined) {
    this.el = document.createElement('div');
    this.el.className = 'compass';
    this.el.innerHTML = `<div class="compass-strip"></div><div class="compass-needle"></div><div class="compass-heading"></div>`;
    document.getElementById('ui')!.appendChild(this.el);
    this.strip = this.el.querySelector('.compass-strip')!;
    this.heading = this.el.querySelector('.compass-heading')!;
    for (let d = 0; d < 360; d += 15) {
      const t = document.createElement('div');
      t.className = LABELS[d] ? 'tick major' : 'tick';
      t.dataset.deg = String(d);
      t.textContent = LABELS[d] ?? '';
      this.strip.appendChild(t);
    }
    for (const e of map?.extracts ?? []) {
      const m = document.createElement('div');
      m.className = 'compass-marker';
      m.innerHTML = `<span>⇪</span><small></small>`;
      this.strip.appendChild(m);
      this.markers.push({ el: m, pos: e.pos, dist: m.querySelector('small')! });
    }
    if (!map) this.el.style.display = 'none';
  }

  update(yaw: number, from: THREE.Vector3): void {
    const heading = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
    this.heading.textContent = `${Math.round(heading)}°`;
    const place = (el: HTMLElement, bearing: number) => {
      let d = bearing - heading;
      d = ((d + 540) % 360) - 180;
      const visible = Math.abs(d) < FOV_DEG / 2;
      el.style.display = visible ? '' : 'none';
      if (visible) el.style.transform = `translateX(${((d / FOV_DEG) * WIDTH + WIDTH / 2).toFixed(1)}px)`;
    };
    for (const t of this.strip.querySelectorAll<HTMLElement>('.tick')) place(t, Number(t.dataset.deg));
    for (const m of this.markers) {
      const dx = m.pos.x - from.x;
      const dz = m.pos.z - from.z;
      place(m.el, ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360);
      m.dist.textContent = `${Math.round(Math.hypot(dx, dz))}m`;
    }
  }
}
