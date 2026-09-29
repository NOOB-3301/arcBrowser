import * as THREE from 'three';
import GUI from 'lil-gui';
import Stats from 'stats-gl';
import { Time } from './Time';
import { Input } from './Input';
import { Settings } from './Settings';
import { Events } from './Events';
import { Physics } from '../physics/Physics';
import { PlayerController } from '../player/PlayerController';
import { Animator } from '../player/Animator';
import { CameraRig } from '../camera/CameraRig';
import { Tuning } from '../player/MovementStates';
import { DamageRegistry } from '../combat/Damage';
import { Effects } from '../combat/Effects';
import { AimAssist } from '../combat/AimAssist';
import { Ballistics } from '../weapons/Ballistics';
import { WEAPONS, RARITY, type Rarity } from '../weapons/WeaponDefs';
import { PlayerCombat } from '../player/PlayerCombat';
import { ArenaWorld } from '../world/ArenaWorld';
import { MapWorld } from '../world/MapWorld';
import type { GameWorld } from '../world/World';
import type { TimeOfDay } from '../world/DayNight';
import { IRONVALE } from '../maps/ironvale';
import { CombatHUD } from '../ui/CombatHUD';
import { Compass } from '../ui/Compass';
import { MapView } from '../ui/MapView';
import { Sfx } from '../audio/Sfx';
import { FIXED_DT } from './Time';
import { HUD } from '../ui/HUD';
import { AIDirector } from '../ai/AIDirector';
import { DIFFICULTIES, type DifficultyId } from '../ai/Difficulty';
import type { BotKind } from '../ai/Bot';
// W4: throwables, weather, boss bar, Shardcoast
import { Throwables } from '../weapons/Throwables';
import { Weather, WEATHER_STATES, type WeatherState } from '../world/Weather';
import { BossBar, ThrowableWidget } from '../ui/BossBar';
import { SHARDCOAST } from '../maps/shardcoast';
import { RaidManager } from '../raid/RaidManager'; // W3

/** Neutral input used while paused so buffered actions don't fire. */
const IDLE_INPUT = {
  moveX: 0, moveY: 0, activeDevice: 'kbm',
  pressed: () => false, down: () => false,
} as unknown as Input;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly time = new Time();
  readonly physics = new Physics();
  readonly input: Input;
  world!: GameWorld;
  player!: PlayerController;
  animator!: Animator;
  rig!: CameraRig;
  private spawn = new THREE.Vector3();
  readonly registry = new DamageRegistry();
  effects!: Effects;
  ballistics!: Ballistics;
  combat!: PlayerCombat;
  private aimAssist!: AimAssist;
  private combatHud!: CombatHUD;
  private hud!: HUD;
  private compass!: Compass;
  private mapView: MapView | null = null;
  ai!: AIDirector;
  /** W3: raid loop + menus (null in the ?map=arena sandbox). */
  raid: RaidManager | null = null;
  private stats!: Stats;
  // W4
  throwables!: Throwables;
  weather!: Weather;
  private bossBar!: BossBar;
  private throwWidget!: ThrowableWidget;
  private gui!: GUI;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;

    this.camera = new THREE.PerspectiveCamera(Settings.get('fov'), window.innerWidth / window.innerHeight, 0.05, 2600);
    this.input = new Input(canvas);

    window.addEventListener('resize', () => this.onResize());
  }

  async init(mapId: string, progress: (msg: string) => void = () => {}): Promise<void> {
    await this.physics.init();
    if (mapId === 'arena') {
      this.world = new ArenaWorld(this.scene, this.physics, this.registry, this.renderer);
    } else {
      const w = new MapWorld(this.scene, this.physics, this.renderer, mapId === 'shardcoast' ? SHARDCOAST : IRONVALE); // W4: map selection
      await w.init(progress);
      this.world = w;
    }
    this.spawn.copy(this.world.spawn);
    this.player = new PlayerController(this.physics, this.world.traversal, this.spawn);
    this.animator = new Animator(this.scene);
    this.rig = new CameraRig(this.camera, this.physics);
    Events.on('player:fallDamage', ({ amount }: { amount: number }) => {
      this.hud.showToast(`Fall damage ${amount.toFixed(0)}`);
      this.input.rumble(0.8, 0.4, 200);
    });

    this.effects = new Effects(this.scene);
    this.ballistics = new Ballistics(this.physics, this.registry, this.effects);
    this.combat = new PlayerCombat(this.player, this.animator, this.rig, this.camera, this.ballistics, this.effects, this.registry, this.spawn);
    this.aimAssist = new AimAssist(this.registry, this.physics);
    progress('Training the machines…');
    this.ai = new AIDirector(this.scene, this.physics, this.registry, this.ballistics, this.effects, this.world, Settings.get('difficulty'));
    this.ai.populate(this.spawn);
    Events.on('explosion', ({ pos, radius }: { pos: THREE.Vector3; radius: number }) => {
      const d = pos.distanceTo(this.player.renderCenter);
      const k = Math.max(0, 1 - d / (radius * 6));
      this.rig.addTrauma(k * 0.8);
      if (k > 0.2) this.input.rumble(k, k, 300);
    });
    Events.on('player:shot', () => this.input.rumble(0.15, 0.35, 50));
    Events.on('player:hurt', () => this.input.rumble(0.6, 0.3, 120));

    // W4: throwables + weather + boss bar
    this.throwables = new Throwables(this.scene, this.physics, this.registry, this.effects, this.rig, this.player, this.combat);
    this.weather = new Weather(this.scene, this.renderer, this.world.dayNight);
    const wq = new URLSearchParams(location.search).get('weather');
    const pick = wq === 'random' ? (['clear', 'clear', 'clear', 'rain', 'rain', 'fog', 'storm'] as WeatherState[])[Math.floor(Math.random() * 7)] : wq;
    if (pick && (WEATHER_STATES as string[]).includes(pick)) {
      this.weather.set(pick as WeatherState);
      this.weather.snap();
    }

    this.hud = new HUD(this.input);
    this.bossBar = new BossBar();
    this.throwWidget = new ThrowableWidget(this.throwables, this.input);
    this.combatHud = new CombatHUD(this.camera);
    this.compass = new Compass(this.world.map);
    if (this.world.map) this.mapView = new MapView(this.world.map);
    // Face into the map from the spawn
    if (this.world.map) this.rig.yaw = Math.atan2(this.spawn.x, this.spawn.z);
    this.initDebug();
    if (mapId !== 'arena') this.raid = new RaidManager(this); // W3: boots to the main menu
    // Compile every material up front (parallel where supported) so the first frames don't hitch
    progress('Compiling shaders…');
    this.rig.update(0, this.player, false, this.animator.root);
    await this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private initDebug(): void {
    this.stats = new Stats({ trackGPU: false, horizontal: true });
    this.stats.init(this.renderer);
    document.body.appendChild(this.stats.dom);

    this.gui = new GUI({ title: 'Debug' });
    const inputFolder = this.gui.addFolder('Input');
    const proxy = { mode: Settings.get('inputMode') };
    const modeCtrl = inputFolder
      .add(proxy, 'mode', { Auto: 'auto', 'Keyboard + Mouse': 'kbm', Controller: 'gamepad' })
      .name('Input mode (F9)')
      .onChange((m: typeof proxy.mode) => this.input.setMode(m));
    Events.on('input:mode', (m: typeof proxy.mode) => {
      proxy.mode = m;
      modeCtrl.updateDisplay();
    });
    const bind = (folder: GUI, key: Parameters<typeof Settings.get>[0], min?: number, max?: number, step?: number) => {
      const obj = { v: Settings.get(key) };
      const c = min !== undefined ? folder.add(obj, 'v', min, max, step) : folder.add(obj, 'v');
      c.name(key).onChange((v: never) => Settings.set(key, v));
    };
    bind(inputFolder, 'mouseSensitivity', 0.1, 4, 0.05);
    bind(inputFolder, 'gamepadSensitivityX', 0.1, 4, 0.05);
    bind(inputFolder, 'gamepadSensitivityY', 0.1, 4, 0.05);
    bind(inputFolder, 'stickDeadzone', 0, 0.5, 0.01);
    bind(inputFolder, 'stickCurve', 1, 3, 0.1);
    bind(inputFolder, 'invertY');
    bind(inputFolder, 'rumble');
    bind(inputFolder, 'adsSensitivityMultiplier', 0.2, 1, 0.05);

    const view = this.gui.addFolder('View');
    bind(view, 'fov', 55, 100, 1);
    bind(view, 'showDebug');
    view
      .add({ physicsDebug: false }, 'physicsDebug')
      .name('physics colliders')
      .onChange((on: boolean) => this.physics.setDebug(this.scene, on));

    const wld = this.gui.addFolder('World');
    const params = new URLSearchParams(location.search);
    const worldCfg = { map: params.get('map') ?? 'ironvale', time: this.world.dayNight.current as TimeOfDay };
    wld.add(worldCfg, 'map', { 'Ironvale Basin': 'ironvale', Shardcoast: 'shardcoast', 'Test arena + range': 'arena' }).name('Map (reloads)') // W4: shardcoast option
      .onChange((m: string) => {
      params.set('map', m);
      location.search = params.toString();
    });
    wld.add(worldCfg, 'time', ['morning', 'noon', 'dusk', 'overcast']).name('Time of day').onChange((t: TimeOfDay) => this.world.dayNight.set(t));
    // W4: weather
    const weatherCfg = { weather: this.weather.state };
    wld.add(weatherCfg, 'weather', WEATHER_STATES).name('Weather').onChange((s: WeatherState) => this.weather.set(s));
    wld.add({ f: () => this.weather.strike(this.camera.position, 300) }, 'f').name('Lightning strike');
    for (const [k, v] of Object.entries(this.world.stats())) wld.add({ [k]: v }, k).disable();

    const aiF = this.gui.addFolder('AI');
    const aiCfg = { difficulty: this.ai.difficultyId as DifficultyId };
    aiF
      .add(aiCfg, 'difficulty', Object.fromEntries(Object.values(DIFFICULTIES).map((d) => [d.label, d.id])))
      .name('Difficulty (respawns)')
      .onChange((id: DifficultyId) => {
        Settings.set('difficulty', id);
        this.ai.setDifficulty(id, false);
        this.ai.clear();
        this.ai.populate(this.player.renderCenter);
      });
    aiF.add(this.ai, 'enabled').name('AI enabled');
    const spawnAhead = (kind: BotKind, n = 1, dist = 25) => {
      for (let i = 0; i < n; i++) {
        const fwd = new THREE.Vector3(-Math.sin(this.rig.yaw), 0, -Math.cos(this.rig.yaw));
        const p = this.player.renderCenter.clone().addScaledVector(fwd, dist).add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6));
        p.y = this.world.heightAt ? this.world.heightAt(p.x, p.z) : 0;
        this.ai.spawn(kind, p, { facing: this.rig.yaw + Math.PI, dormant: false, route: [p.clone(), p.clone().add(new THREE.Vector3(30, 0, 0)), p.clone().add(new THREE.Vector3(15, 0, 25))] });
      }
    };
    aiF.add({ f: () => spawnAhead('tick', 4, 30) }, 'f').name('Spawn Tick pack');
    aiF.add({ f: () => spawnAhead('wasp', 1, 40) }, 'f').name('Spawn Wasp');
    aiF.add({ f: () => spawnAhead('sentinel', 1, 35) }, 'f').name('Spawn Sentinel');
    aiF.add({ f: () => spawnAhead('raider', 1, 45) }, 'f').name('Spawn Raider');
    aiF.add({ f: () => spawnAhead('stalker', 1, 40) }, 'f').name('Spawn Stalker'); // W4
    aiF.add({ f: () => spawnAhead('colossus', 1, 70) }, 'f').name('Spawn Colossus'); // W4
    aiF.add({ f: () => (['frag', 'emp', 'smoke', 'decoy', 'mine'] as const).forEach((id) => this.throwables.add(id, 3)) }, 'f').name('+3 each throwable'); // W4
    aiF.add({ f: () => this.ai.clear() }, 'f').name('Remove all bots');
    aiF.add({ f: () => this.ai.toggleNavDebug(this.player.renderCenter) }, 'f').name('Toggle nav grid (40 m)');
    aiF.add({ navMs: Math.round(this.ai.navBuildMs) }, 'navMs').name('Nav build ms').disable();
    aiF.add({ f: () => this.combat.health.reset() }, 'f').name('God refill');

    const move = this.gui.addFolder('Movement tuning');
    move.add(Tuning, 'jogSpeed', 2, 7, 0.1);
    move.add(Tuning, 'sprintSpeed', 4, 10, 0.1);
    move.add(Tuning, 'jumpVelocity', 3, 8, 0.1);
    move.add(Tuning, 'gravity', 9, 30, 0.1);
    move.add(Tuning, 'sprintTurnRate', 1, 12, 0.1);
    move.add(Tuning, 'rollSpeed', 4, 12, 0.1);
    move.add(Tuning, 'slideFriction', 1, 12, 0.1);
    move.add(this.player, 'encumbrance', 0, 1, 0.05).name('encumbrance');
    move.close();

    const wf = this.gui.addFolder('Weapons');
    const ids = Object.fromEntries(Object.values(WEAPONS).map((w) => [w.name, w.id]));
    const rarities = Object.keys(RARITY);
    const cfg = { slot1: 'mako', slot2: 'wrenchback', rarity: 'rare' as Rarity };
    const reequip = () => {
      this.combat.equip(0, cfg.slot1, cfg.rarity);
      this.combat.equip(1, cfg.slot2, cfg.rarity);
      this.combat.selectSlot(this.combat.active, true);
    };
    wf.add(cfg, 'slot1', ids).name('Slot 1 (1)').onChange(reequip);
    wf.add(cfg, 'slot2', ids).name('Slot 2 (2)').onChange(reequip);
    wf.add(cfg, 'rarity', rarities).name('Rarity').onChange(reequip);
    wf.add(this.combat.pouch, 'infinite').name('Infinite reserve');
    bind(wf, 'aimAssist', 0, 1, 0.05);
    wf.add({ refill: () => this.combat.health.reset() }, 'refill').name('Refill health + shield');

    const tp = this.gui.addFolder('Teleport');
    for (const [name, pos] of Object.entries(this.world.spots)) {
      tp.add({ go: () => this.player.teleport(pos.clone().add(new THREE.Vector3(0, 0.1, 0))) }, 'go').name(name);
    }
    this.gui.close();
  }

  private frame(now: number): void {
    this.stats.begin();
    const steps = this.time.tick(now);
    const dt = this.time.delta;

    this.input.update(dt);
    // W3: pause menu freezes the simulation (solo raid)
    if (this.raid?.paused) {
      this.raid.update(dt);
      this.renderer.render(this.scene, this.camera);
      this.stats.end();
      this.stats.update();
      return;
    }
    const alive = this.combat.health.alive;
    const mapOpen = this.mapView?.open ?? false;
    const active = this.hud.playing && alive && !mapOpen && !(this.raid?.blocksInput ?? false); // W3
    const aiming = active && this.input.adsAxis > 0.3;
    if (this.input.activeDevice === 'gamepad' && (this.input.pressed('fire') || this.input.pressed('jump'))) Sfx.unlock();

    if (active) {
      const moving = Math.abs(this.input.moveX) + Math.abs(this.input.moveY) + Math.abs(this.input.lookX) > 0.01;
      const assist =
        this.input.activeDevice === 'gamepad'
          ? this.aimAssist.compute(this.camera, Settings.get('aimAssist'), this.rig.ads, moving, dt, this.player.collider)
          : undefined;
      this.rig.handleInput(this.input, dt, aiming, assist);
    }
    this.combat.update(dt, active ? this.input : IDLE_INPUT, active);
    this.throwables.update(dt, active ? this.input : IDLE_INPUT, active); // W4
    const facing = aiming || this.combat.combatFacing;
    this.player.frameInput(active ? this.input : IDLE_INPUT, this.rig.moveYaw, this.rig.yaw, facing, dt);
    if (active && this.input.down('fire')) this.player.breakSprint();

    for (let i = 0; i < steps; i++) {
      this.player.step();
      this.world.step();
      this.ai.step(FIXED_DT);
      this.ballistics.step(FIXED_DT);
      this.throwables.step(FIXED_DT); // W4
      this.physics.step();
      this.recoverFallThrough();
    }

    this.physics.syncMeshes();
    this.physics.updateDebug();
    this.player.interpolate(this.time.alpha);
    this.animator.update(dt, this.player, this.rig.pitch, this.combat.pose);
    this.rig.update(dt, this.player, aiming, this.animator.root);
    this.world.update(dt, this.camera, this.player.renderCenter);
    this.ai.update(dt, this.player.renderCenter, this.time.alpha);
    Sfx.listener.copy(this.camera.position);
    this.ballistics.render();
    this.effects.update(dt);
    this.weather.update(dt, this.camera.position); // W4

    if (this.mapView) {
      if (this.hud.playing && this.input.pressed('map') && !(this.raid?.blocksInput ?? false)) this.mapView.toggle(); // W3
      this.mapView.update(this.player.renderCenter, this.rig.yaw);
    }
    this.compass.update(this.rig.yaw, this.player.renderCenter);

    this.raid?.update(dt); // W3
    this.hud.update(dt, Settings.get('showDebug'), this.player, this.rig);
    this.combatHud.update(dt, this.combat, this.rig, this.player);
    this.bossBar.update(dt, this.ai.bots, this.player.renderCenter); // W4
    this.throwWidget.update(dt); // W4
    this.renderer.render(this.scene, this.camera);
    this.stats.end();
    this.stats.update();
  }

  /** Rescue the player if they slip under the terrain or out of the world. */
  private recoverFallThrough(): void {
    const c = this.player.center;
    const ground = this.world.heightAt?.(c.x, c.z);
    if (c.y < -50 || (ground !== undefined && c.y < ground - 4)) {
      this.player.teleport(new THREE.Vector3(c.x, (ground ?? this.spawn.y) + 1, c.z));
    }
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
