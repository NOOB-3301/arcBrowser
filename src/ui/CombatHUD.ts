import * as THREE from 'three';
import { Events } from '../core/Events';
import type { DamageResult } from '../combat/Damage';
import type { PlayerCombat } from '../player/PlayerCombat';
import type { CameraRig } from '../camera/CameraRig';
import type { PlayerController } from '../player/PlayerController';
import { AMMO_LABEL, RARITY } from '../weapons/WeaponDefs';
import { Sfx } from '../audio/Sfx';

interface DmgNumber {
  el: HTMLElement;
  pos: THREE.Vector3;
  life: number;
}

/** Vitals, weapon panel, hitmarkers, damage numbers, hurt vignette, scope. */
export class CombatHUD {
  private root: HTMLElement;
  private shieldFill: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private healBar: HTMLElement;
  private wName: HTMLElement;
  private wMode: HTMLElement;
  private wMag: HTMLElement;
  private wReserve: HTMLElement;
  private wBar: HTMLElement;
  private wBarFill: HTMLElement;
  private wAlt: HTMLElement;
  private hitmarker: HTMLElement;
  private vignette: HTMLElement;
  private scope: HTMLElement;
  private down: HTMLElement;
  private crosshair: HTMLElement;
  private numbers: DmgNumber[] = [];
  private hitT = 0;
  private hurt = 0;
  private _v = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {
    this.root = document.createElement('div');
    this.root.className = 'combat-hud';
    this.root.innerHTML = `
      <div class="scope"><div class="scope-ring"></div></div>
      <div class="vignette"></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i></div>
      <div class="vitals">
        <div class="bar shield"><div class="fill"></div></div>
        <div class="bar hp"><div class="fill"></div><span></span></div>
        <div class="bar heal"><div class="fill"></div></div>
      </div>
      <div class="weapon-panel">
        <div class="w-name"></div>
        <div class="w-ammo"><span class="w-mag"></span><span class="w-reserve"></span></div>
        <div class="w-mode"></div>
        <div class="w-bar"><div class="fill"></div></div>
        <div class="w-alt"></div>
      </div>
      <div class="down-overlay">DOWN<small>respawning…</small></div>`;
    document.getElementById('ui')!.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.shieldFill = q('.shield .fill');
    this.hpFill = q('.hp .fill');
    this.hpText = q('.hp span');
    this.healBar = q('.heal');
    this.wName = q('.w-name');
    this.wMode = q('.w-mode');
    this.wMag = q('.w-mag');
    this.wReserve = q('.w-reserve');
    this.wBar = q('.w-bar');
    this.wBarFill = q('.w-bar .fill');
    this.wAlt = q('.w-alt');
    this.hitmarker = q('.hitmarker');
    this.vignette = q('.vignette');
    this.scope = q('.scope');
    this.down = q('.down-overlay');
    this.crosshair = document.querySelector('.crosshair') as HTMLElement;

    Events.on('damage', (r: DamageResult) => this.onDamage(r));
    Events.on('player:hurt', ({ amount }: { amount: number }) => {
      this.hurt = Math.min(1, this.hurt + amount / 40);
    });
    Events.on('plate:ring', ({ dist }: { dist: number }) => {
      this.flashHit('hit');
      Sfx.plate(dist);
    });
  }

  private onDamage(r: DamageResult): void {
    if (!r.source.byPlayer || r.target.team === 'player') return;
    if (r.target.team === 'neutral') return;
    const head = r.zone.kind === 'head' || r.zone.kind === 'weakpoint';
    this.flashHit(r.killed ? 'kill' : head ? 'head' : r.zone.kind === 'armor' ? 'armor' : 'hit');
    if (r.killed) Sfx.kill();
    else Sfx.hit(head);
    this.spawnNumber(r.point, r.dealt, head, r.toShield > r.toHp, r.zone.kind === 'armor');
  }

  private flashHit(kind: 'hit' | 'head' | 'kill' | 'armor'): void {
    this.hitmarker.className = `hitmarker show ${kind}`;
    this.hitT = kind === 'kill' ? 0.35 : 0.15;
  }

  private spawnNumber(pos: THREE.Vector3, amount: number, head: boolean, shield: boolean, armor: boolean): void {
    const el = document.createElement('div');
    el.className = `dmg-num${head ? ' head' : ''}${shield ? ' shield' : ''}${armor ? ' armor' : ''}`;
    el.textContent = amount < 1 ? amount.toFixed(1) : Math.round(amount).toString();
    this.root.appendChild(el);
    this.numbers.push({ el, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.2, 0)), life: 0.8 });
    if (this.numbers.length > 40) this.numbers.shift()!.el.remove();
  }

  update(dt: number, combat: PlayerCombat, rig: CameraRig, player: PlayerController): void {
    const h = combat.health;
    this.shieldFill.style.width = `${(h.shield / Math.max(1, h.maxShield)) * 100}%`;
    this.hpFill.style.width = `${(h.hp / h.maxHp) * 100}%`;
    this.hpText.textContent = `${Math.ceil(h.hp)}`;
    this.healBar.style.opacity = combat.healingT >= 0 ? '1' : '0';
    (this.healBar.firstElementChild as HTMLElement).style.width = `${Math.max(0, combat.healingT / 2.2) * 100}%`;

    // Weapon panel
    const w = combat.weapon;
    const d = w.def;
    this.wName.textContent = d.name;
    this.wName.style.color = RARITY[w.rarity].color;
    if (w.usesHeat) {
      this.wMag.textContent = w.overheated ? 'HOT' : `${Math.round(100 - w.heat)}%`;
      this.wReserve.textContent = ` / ${combat.pouch.count(d.ammo)}`;
    } else {
      this.wMag.textContent = `${w.mag}`;
      this.wReserve.textContent = ` / ${combat.pouch.count(d.ammo)}`;
    }
    this.wMag.classList.toggle('low', !w.usesHeat && w.mag <= Math.ceil(w.magCap * 0.25));
    const mode = d.altAmmo ? (w.altAmmo ? d.altAmmo.name : 'Buckshot') : w.mode;
    this.wMode.textContent = `${AMMO_LABEL[d.ammo]} · ${mode.toUpperCase()}${d.suppressed ? ' · SUPP' : ''}`;

    let bar = -1;
    let barClass = '';
    if (w.reloading) {
      bar = w.reloadProgress;
      barClass = 'reload';
    } else if (w.usesHeat && w.heat > 0) {
      bar = w.heat / 100;
      barClass = w.overheated ? 'hot' : 'heat';
    } else if (w.charge > 0) {
      bar = w.charge;
      barClass = 'charge';
    } else if (d.spinUp && w.spin > 0) {
      bar = w.spin;
      barClass = 'spin';
    }
    this.wBar.style.opacity = bar >= 0 ? '1' : '0';
    this.wBar.className = `w-bar ${barClass}`;
    this.wBarFill.style.width = `${Math.max(0, bar) * 100}%`;
    const other = combat.slots[1 - combat.active];
    this.wAlt.textContent = other ? `${other.def.name}  ${other.usesHeat ? '' : other.mag}` : '';

    // Crosshair from real spread cone
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const px = (Math.tan(((combat.spreadDeg / 2) * Math.PI) / 180) / Math.tan(fovRad / 2)) * (window.innerHeight / 2);
    this.crosshair.style.setProperty('--spread', `${Math.max(3, Math.min(px, 120)).toFixed(1)}px`);
    const hideCross = player.locomotion === 'sprint' || player.state === 'roll' || player.state === 'mantle' || rig.scoped;
    this.crosshair.style.opacity = hideCross ? '0' : '1';

    // Hitmarker
    this.hitT -= dt;
    if (this.hitT <= 0) this.hitmarker.classList.remove('show');

    // Hurt vignette
    this.hurt = Math.max(0, this.hurt - dt * 0.8);
    const lowHp = h.hp / h.maxHp < 0.3 ? 0.35 + Math.sin(performance.now() / 200) * 0.1 : 0;
    this.vignette.style.opacity = `${Math.max(this.hurt, lowHp)}`;

    this.scope.style.opacity = rig.scoped ? '1' : '0';
    this.down.style.display = h.alive ? 'none' : 'flex';

    // Damage numbers
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.life -= dt;
      n.pos.y += dt * 0.8;
      if (n.life <= 0) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      this._v.copy(n.pos).project(this.camera);
      if (this._v.z > 1) {
        n.el.style.opacity = '0';
        continue;
      }
      const x = (this._v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this._v.y * 0.5 + 0.5) * window.innerHeight;
      n.el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
      n.el.style.opacity = `${Math.min(1, n.life * 3)}`;
    }
  }
}
