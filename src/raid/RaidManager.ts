import * as THREE from 'three';
import type { Game } from '../core/Game';
import { Events } from '../core/Events';
import { Settings } from '../core/Settings';
import type { DamageResult } from '../combat/Damage';
import { Bot } from '../ai/Bot';
import type { DifficultyId } from '../ai/Difficulty';
import type { TimeOfDay } from '../world/DayNight';
import type { Extracts } from '../world/Extracts';
import { ContainerManager, LootContainer, containerMesh } from '../loot/Containers';
import { InventoryPouch, QUICK_SLOTS, type Inventory, type SlotId } from '../loot/Inventory';
import { itemDef, useQuickItem, type MedEffect } from '../loot/Items';
import { Profile } from '../loot/Stash';
import { Sfx } from '../audio/Sfx';
import { ExtractionSystem } from './Extraction';
import { InventoryUI } from '../ui/InventoryUI';
import { RaidHUD } from '../ui/RaidHUD';
import { Menus, type RaidResult } from '../ui/Menus';

export type RaidPhase = 'menu' | 'raid' | 'results';
export type RaidOutcome = 'extracted' | 'died' | 'mia';

export const RAID_SECONDS = 30 * 60;
const SEARCH_NOISE = 12;
const THROW_HOLD = 0.35;

/** A generic hold-to-use world object (power relay…). */
export interface Interactable {
  pos: THREE.Vector3;
  label: string;
  verb: string;
  holdTime: number;
  enabled: boolean;
  onComplete(): void;
}

export interface DeployOptions {
  difficulty: DifficultyId;
  time: TimeOfDay;
}

/**
 * Raid lifecycle: main menu → deploy (world stays loaded; AI, loot and player
 * are reset) → live raid (timer, looting, extraction) → results → menu.
 */
export class RaidManager {
  phase: RaidPhase = 'menu';
  paused = false;
  readonly profile: Profile;
  readonly containers: ContainerManager;
  readonly extraction: ExtractionSystem;
  readonly invUI: InventoryUI;
  readonly hud: RaidHUD;
  readonly menus: Menus;
  timeLeft = RAID_SECONDS;
  elapsed = 0;
  kills = 0;
  /** Current look/interaction target. */
  target: LootContainer | Interactable | null = null;
  searchT = -1;
  private searchFor: LootContainer | Interactable | null = null;
  private deadT = -1;
  private startValue = 0;
  private equipped: (number | null)[] = [null, null];
  private shieldUid: number | null = null;
  private seenInv = -1;
  private throwDownT = -1;
  throwIndex = 0;
  interactables: Interactable[] = [];
  private interactMeshes: THREE.Object3D[] = [];
  private camDir = new THREE.Vector3();
  private lastOptions: DeployOptions = { difficulty: 'veteran', time: 'noon' };

  constructor(readonly game: Game) {
    this.profile = Profile.load();
    this.containers = new ContainerManager(game.scene, game.physics);
    const beacons = (game.world as unknown as { extracts?: Extracts }).extracts ?? null;
    this.extraction = new ExtractionSystem(this, beacons);
    this.hud = new RaidHUD(this);
    this.invUI = new InventoryUI(this);
    this.menus = new Menus(this);

    game.combat.autoRespawn = false;
    game.combat.pouch = new InventoryPouch(this.inv);
    game.combat.medProvider = () => this.pickMed();

    Events.on('kill', (r: DamageResult) => {
      if (this.phase !== 'raid') return;
      if (r.source.byPlayer && r.target.team !== 'player') this.kills++;
      if (r.target instanceof Bot) this.containers.addBody(r.target, (x, z) => game.world.heightAt?.(x, z) ?? 0);
    });
    Events.on('input:pointerlock', (locked: boolean) => {
      // Esc while playing on KB/M → pause menu
      if (!locked && this.phase === 'raid' && !this.invUI.open && !this.paused && this.game.combat.health.alive && game.input.activeDevice === 'kbm') this.setPaused(true);
    });
    if (this.profile.forfeited) setTimeout(() => Events.emit('toast', 'Previous raid abandoned — loadout lost'), 500);
    this.toMenu();
  }

  get inv(): Inventory {
    return this.profile.loadout;
  }

  /** Gameplay input is suspended (menus, inventory, pause, dead). */
  get blocksInput(): boolean {
    return this.phase !== 'raid' || this.paused || this.invUI.open || this.deadT >= 0;
  }

  // ================================================================ lifecycle

  toMenu(): void {
    const g = this.game;
    this.phase = 'menu';
    this.paused = false;
    this.invUI.close();
    g.ai.clear();
    g.ai.enabled = false;
    this.containers.clear();
    this.clearInteractables();
    this.extraction.reset();
    g.combat.health.reset();
    this.syncLoadout(true);
    g.player.teleport(g.world.spawn.clone());
    document.body.classList.add('w3-menu');
    document.body.classList.remove('w3-raid');
    this.hud.setVisible(false);
    this.menus.showMain();
  }

  deploy(opts: DeployOptions): void {
    const g = this.game;
    const map = g.world.map;
    if (!map) return;
    this.lastOptions = opts;
    Settings.set('difficulty', opts.difficulty);
    g.ai.setDifficulty(opts.difficulty, false);
    g.world.dayNight.set(opts.time);

    // Reset world state
    g.ai.clear();
    this.containers.clear();
    this.containers.populate(map, g.ai.ctx.nav);
    this.clearInteractables();
    this.spawnPowerRelay();
    this.extraction.setup();

    // Player
    const [sx, sz] = map.def.spawns[Math.floor(Math.random() * map.def.spawns.length)];
    const spawn = new THREE.Vector3(sx, map.hm.sample(sx, sz) + 0.2, sz);
    g.player.teleport(spawn);
    g.rig.yaw = Math.atan2(spawn.x, spawn.z);
    g.combat.health.reset();
    this.deadT = -1;
    this.equipped = [null, null];
    this.shieldUid = null;
    this.syncLoadout(true);
    g.combat.health.shield = g.combat.health.maxShield > 0 ? Math.min(g.combat.health.maxShield, this.inv.slots.shield?.charge ?? g.combat.health.maxShield) : 0;

    g.ai.enabled = true;
    g.ai.populate(spawn);

    this.timeLeft = RAID_SECONDS;
    this.elapsed = 0;
    this.kills = 0;
    this.startValue = this.inv.value();
    this.throwIndex = 0;
    this.profile.inRaid = true;
    this.profile.stats.raids++;
    this.profile.save();

    this.phase = 'raid';
    this.paused = false;
    document.body.classList.remove('w3-menu');
    document.body.classList.add('w3-raid');
    this.menus.hide();
    this.hud.setVisible(true);
    this.lockPointer();
    Sfx.unlock();
    Events.emit('raid:start', { difficulty: opts.difficulty });
    Events.emit('toast', `Deployed · ${this.extraction.openCount()} extracts open`);
  }

  endRaid(outcome: RaidOutcome): void {
    if (this.phase !== 'raid') return;
    const g = this.game;
    this.saveEquipState();
    this.invUI.close();
    this.paused = false;
    document.body.classList.remove('w3-paused');
    this.phase = 'results';
    this.hud.setVisible(false);
    document.body.classList.remove('w3-raid');
    document.body.classList.add('w3-menu');
    if (document.pointerLockElement) document.exitPointerLock();

    const carried = this.inv.value();
    let banked = 0;
    let lost = 0;
    if (outcome === 'extracted') {
      banked = this.profile.bankBackpack();
      this.profile.stats.extracted++;
    } else {
      lost = carried;
      this.inv.clear();
      if (outcome === 'died') this.profile.stats.died++;
      else this.profile.stats.mia++;
    }
    this.profile.stats.kills += this.kills;
    this.profile.inRaid = false;
    this.profile.save();
    g.ai.enabled = false;

    const result: RaidResult = {
      outcome,
      time: this.elapsed,
      kills: this.kills,
      carried,
      banked,
      lost,
      gained: Math.max(0, carried - this.startValue),
      difficulty: this.lastOptions.difficulty,
    };
    Events.emit('raid:end', result);
    this.menus.showResults(result);
  }

  // ================================================================ per frame

  update(dt: number): void {
    const g = this.game;
    if (this.phase !== 'raid') {
      // Slow cinematic orbit behind the menus
      g.rig.yaw += dt * 0.04;
      this.menus.update(dt);
      return;
    }
    if (this.paused) {
      this.menus.update(dt);
      return;
    }
    const input = g.input;
    const alive = g.combat.health.alive;

    this.elapsed += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.endRaid('mia');
      return;
    }

    // Death → raid failed after a short beat
    if (!alive) {
      if (this.deadT < 0) {
        this.deadT = 0;
        this.invUI.close();
      }
      this.deadT += dt;
      if (this.deadT > 2.5) this.endRaid('died');
      this.hud.update(dt);
      return;
    }

    // Pause / inventory toggles
    if (input.pressed('pause') && !this.invUI.open) {
      this.setPaused(true);
      return;
    }
    if (input.pressed('inventory') && !(this.invUI.open && input.activeDevice === 'gamepad')) {
      if (this.invUI.open) this.closeInventory();
      else this.openInventory(null);
    }

    // Loadout ↔ combat sync
    this.saveEquipState();
    if (this.inv.version !== this.seenInv) this.syncLoadout(false);
    g.player.encumbrance = this.inv.encumbrance();

    this.containers.update();
    if (!this.blocksInput) {
      this.updateInteraction(dt);
      this.updateThrowables(dt);
    } else {
      this.searchT = -1;
      this.searchFor = null;
    }
    this.extraction.update(dt, g.player.feet());
    this.invUI.update(dt);
    this.hud.update(dt);
  }

  // ================================================================ interaction

  private updateInteraction(dt: number): void {
    const g = this.game;
    const input = g.input;
    const feet = g.player.feet();
    g.camera.getWorldDirection(this.camDir);
    let target: LootContainer | Interactable | null = this.containers.pick(feet, g.camera.position, this.camDir);
    if (!target) {
      for (const it of this.interactables) {
        if (it.enabled && Math.hypot(it.pos.x - feet.x, it.pos.z - feet.z) < 2.5 && Math.abs(it.pos.y - feet.y) < 2) target = it;
      }
    }
    this.target = target;
    if (!target) {
      this.searchT = -1;
      this.searchFor = null;
      return;
    }
    const box = target instanceof LootContainer ? target : null;
    const obj = box ? null : (target as Interactable);
    // Already-searched containers open on a tap
    if (box && box.searched && input.pressed('interact')) {
      this.openInventory(box);
      return;
    }
    if (input.down('interact')) {
      if (this.searchFor !== target) {
        if (box && box.searched) return;
        this.searchFor = target;
        this.searchT = 0;
        if (box && box.lockedBy && !this.inv.has(box.lockedBy)) {
          Events.emit('toast', `Locked · requires ${itemDef(box.lockedBy).name}`);
          this.searchT = -1;
          return;
        }
        Events.emit('noise', { pos: target.pos.clone(), radius: SEARCH_NOISE, emitter: g.combat, source: 'search' });
        Sfx.swap();
      }
      if (this.searchT < 0) return;
      this.searchT += dt;
      const need = box ? box.searchTime : obj!.holdTime;
      if (this.searchT >= need) {
        this.searchT = -1;
        this.searchFor = null;
        if (box) {
          if (box.lockedBy && !box.searched) {
            this.inv.consume(box.lockedBy, 1);
            Events.emit('toast', `${itemDef(box.lockedBy).name} used`);
            box.lockedBy = null;
          }
          box.open();
          this.openInventory(box);
        } else obj!.onComplete();
      }
    } else {
      this.searchT = -1;
      this.searchFor = null;
    }
  }

  get searchProgress(): number {
    if (this.searchT < 0 || !this.searchFor) return -1;
    const need = this.searchFor instanceof LootContainer ? this.searchFor.searchTime : this.searchFor.holdTime;
    return Math.min(1, this.searchT / need);
  }

  openInventory(container: LootContainer | null): void {
    if (this.phase !== 'raid') return;
    this.invUI.show(container);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  closeInventory(): void {
    this.invUI.close();
    if (this.phase === 'raid') this.lockPointer();
  }

  setPaused(on: boolean): void {
    if (this.phase !== 'raid') return;
    this.paused = on;
    document.body.classList.toggle('w3-paused', on);
    if (on) {
      this.invUI.close();
      if (document.pointerLockElement) document.exitPointerLock();
      this.menus.showPause();
    } else {
      this.menus.hide();
      this.lockPointer();
    }
  }

  /** Re-grab the mouse; browsers may refuse without a gesture (the HUD overlay then asks for a click). */
  lockPointer(): void {
    if (this.game.input.pointerLocked) return;
    try {
      const r = this.game.renderer.domElement.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      // ignore
    }
  }

  /** Dam elevator needs power: a relay at the pumping station. */
  private spawnPowerRelay(): void {
    const map = this.game.world.map;
    const poi = map?.def.pois.find((p) => p.kind === 'pumping');
    const dam = this.extraction.byId('x-dam');
    if (!poi || !dam) return;
    const p = this.game.ai.ctx.nav.nearestWalkable(poi.center[0] + 8, poi.center[1] + 10, 12);
    if (!p) return;
    const mesh = containerMesh('toolbox');
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.3), new THREE.MeshStandardMaterial({ color: '#c9a227', roughness: 0.5, metalness: 0.4 }));
    top.position.set(0, 1.25, 0);
    mesh.add(top);
    mesh.position.copy(p);
    this.game.scene.add(mesh);
    this.interactMeshes.push(mesh);
    const relay: Interactable = {
      pos: p,
      label: 'Power Relay',
      verb: 'Restore power',
      holdTime: 3,
      enabled: true,
      onComplete: () => {
        relay.enabled = false;
        (mesh.userData.status as THREE.MeshStandardMaterial).emissive.set('#5cffb0');
        this.extraction.powerUp('x-dam');
        Events.emit('noise', { pos: p.clone(), radius: 60, emitter: this.game.combat, source: 'machine' });
      },
    };
    this.interactables.push(relay);
  }

  private clearInteractables(): void {
    for (const m of this.interactMeshes) this.game.scene.remove(m);
    this.interactMeshes.length = 0;
    this.interactables.length = 0;
  }

  // ================================================================ loadout

  /** Push inventory weapons / shield into PlayerCombat. */
  syncLoadout(force: boolean): void {
    const c = this.game.combat;
    this.seenInv = this.inv.version;
    let changed = false;
    (['w0', 'w1'] as SlotId[]).forEach((id, i) => {
      const s = this.inv.slots[id];
      const uid = s?.uid ?? null;
      if (!force && uid === this.equipped[i]) return;
      this.equipped[i] = uid;
      changed = true;
      const def = s ? itemDef(s.id) : null;
      if (s && def?.weaponId) {
        c.equip(i, def.weaponId, s.rarity ?? 'common');
        const w = c.slots[i];
        w.mag = Math.min(w.magCap, s.mag ?? 0);
      } else c.unequip(i);
    });
    if (changed) {
      const pick = c.empty[c.active] && !c.empty[1 - c.active] ? 1 - c.active : c.active;
      c.selectSlot(pick, true);
    }
    const sh = this.inv.slots.shield;
    const cap = sh ? itemDef(sh.id).shieldCap ?? 0 : 0;
    if ((sh?.uid ?? null) !== this.shieldUid || force) {
      this.shieldUid = sh?.uid ?? null;
      c.health.maxShield = cap;
      c.health.shield = Math.min(cap, sh?.charge ?? cap);
    }
    document.body.classList.toggle('w3-unarmed', c.empty[c.active]);
    document.body.classList.toggle('w3-alt-empty', c.empty[1 - c.active]);
  }

  /** Write magazine / shield state back onto the item stacks. */
  private saveEquipState(): void {
    const c = this.game.combat;
    (['w0', 'w1'] as SlotId[]).forEach((id, i) => {
      const s = this.inv.slots[id];
      if (s && s.uid === this.equipped[i] && !c.empty[i]) s.mag = c.slots[i].mag;
    });
    const sh = this.inv.slots.shield;
    if (sh && sh.uid === this.shieldUid) sh.charge = Math.round(c.health.shield);
    document.body.classList.toggle('w3-unarmed', c.empty[c.active]);
    document.body.classList.toggle('w3-alt-empty', c.empty[1 - c.active]);
  }

  /** Heal action: choose + consume the most useful med (quick slots first, then backpack). */
  private pickMed(): MedEffect | null {
    const h = this.game.combat.health;
    const needHp = h.maxHp - h.hp;
    const needShield = h.maxShield - h.shield;
    const order: string[] = [];
    if (needHp > 35) order.push('medkit', 'bandage');
    else if (needHp > 0.5) order.push('bandage', 'medkit');
    if (needShield > 5) order.push('shield_cell');
    // Quick slot items take priority over the backpack
    const inQuick = (id: string) => QUICK_SLOTS.some((q) => this.inv.slots[q]?.id === id);
    const pick = order.find(inQuick) ?? order.find((id) => this.inv.has(id));
    if (!pick) {
      Events.emit('toast', needHp > 0.5 || needShield > 5 ? 'No meds' : 'Health full');
      return null;
    }
    this.inv.consume(pick, 1);
    Events.emit('toast', `Using ${itemDef(pick).name}`);
    return itemDef(pick).med!;
  }

  /** Throwable action: tap = throw selected, hold = cycle. */
  private updateThrowables(dt: number): void {
    const input = this.game.input;
    const slots = this.inv.quickThrowables();
    if (this.throwIndex >= slots.length) this.throwIndex = 0;
    if (input.pressed('throwable')) this.throwDownT = 0;
    if (this.throwDownT >= 0 && input.down('throwable')) {
      this.throwDownT += dt;
      if (this.throwDownT >= THROW_HOLD) {
        this.throwDownT = -1;
        if (slots.length > 1) {
          this.throwIndex = (this.throwIndex + 1) % slots.length;
          Events.emit('toast', `Throwable: ${itemDef(this.inv.slots[slots[this.throwIndex]]!.id).name}`);
        }
      }
    } else if (this.throwDownT >= 0) {
      this.throwDownT = -1;
      const slot = slots[this.throwIndex];
      const s = slot ? this.inv.slots[slot] : null;
      if (!s) {
        Events.emit('toast', 'No throwables in quick slots');
        return;
      }
      const id = s.id;
      s.qty--;
      if (s.qty <= 0) this.inv.slots[slot] = null;
      this.inv.changed();
      useQuickItem(id);
    }
  }

  /** Selected throwable quick slot (for the HUD). */
  get selectedThrowSlot(): SlotId | null {
    return this.inv.quickThrowables()[this.throwIndex] ?? null;
  }
}
