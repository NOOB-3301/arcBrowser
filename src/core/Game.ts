import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import GUI from 'lil-gui';
import Stats from 'stats-gl';
import { Time } from './Time';
import { Input } from './Input';
import { Settings } from './Settings';
import { Events } from './Events';
import { Physics } from '../physics/Physics';
import { TestArena } from '../world/TestArena';
import { PlayerController } from '../player/PlayerController';
import { Animator } from '../player/Animator';
import { CameraRig } from '../camera/CameraRig';
import { Traversal } from '../world/Traversal';
import { Tuning } from '../player/MovementStates';
import { DamageRegistry } from '../combat/Damage';
import { Effects } from '../combat/Effects';
import { AimAssist } from '../combat/AimAssist';
import { Ballistics } from '../weapons/Ballistics';
import { WEAPONS, RARITY, type Rarity } from '../weapons/WeaponDefs';
import { PlayerCombat } from '../player/PlayerCombat';
import { TargetRange } from '../world/TargetRange';
import { CombatHUD } from '../ui/CombatHUD';
import { Sfx } from '../audio/Sfx';
import { FIXED_DT } from './Time';
import { HUD } from '../ui/HUD';

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
  private sun!: THREE.DirectionalLight;
  private sunDir = new THREE.Vector3();
  readonly traversal = new Traversal();
  player!: PlayerController;
  animator!: Animator;
  rig!: CameraRig;
  private spawn = new THREE.Vector3();
  readonly registry = new DamageRegistry();
  effects!: Effects;
  ballistics!: Ballistics;
  combat!: PlayerCombat;
  range!: TargetRange;
  private aimAssist!: AimAssist;
  private combatHud!: CombatHUD;
  private hud!: HUD;
  private stats!: Stats;
  private gui!: GUI;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;

    this.camera = new THREE.PerspectiveCamera(Settings.get('fov'), window.innerWidth / window.innerHeight, 0.05, 3000);
    this.input = new Input(canvas);

    window.addEventListener('resize', () => this.onResize());
  }

  async init(): Promise<void> {
    await this.physics.init();
    this.buildEnvironment();

    const arena = new TestArena(this.scene, this.physics, this.traversal);
    arena.build();
    this.spawn.copy(arena.spawn).setY(0);
    this.player = new PlayerController(this.physics, this.traversal, this.spawn);
    this.animator = new Animator(this.scene);
    this.rig = new CameraRig(this.camera, this.physics);
    Events.on('player:fallDamage', ({ amount }: { amount: number }) => {
      this.hud.showToast(`Fall damage ${amount.toFixed(0)}`);
      this.input.rumble(0.8, 0.4, 200);
    });

    this.effects = new Effects(this.scene);
    this.ballistics = new Ballistics(this.physics, this.registry, this.effects);
    this.range = new TargetRange(this.scene, this.physics, this.registry);
    this.combat = new PlayerCombat(this.player, this.animator, this.rig, this.camera, this.ballistics, this.effects, this.registry, this.spawn);
    this.aimAssist = new AimAssist(this.registry, this.physics);
    Events.on('player:shot', () => this.input.rumble(0.15, 0.35, 50));
    Events.on('player:hurt', () => this.input.rumble(0.6, 0.3, 120));

    this.hud = new HUD(this.input);
    this.combatHud = new CombatHUD(this.camera);
    this.initDebug();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private buildEnvironment(): void {
    const sky = new Sky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.85;
    const sunDir = this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(35));
    u.sunPosition.value.copy(sunDir);
    this.scene.add(sky);

    this.scene.fog = new THREE.Fog('#b9b3a3', 80, 900);

    this.scene.add(new THREE.HemisphereLight('#dfe8f0', '#4a4436', 0.9));
    this.sun = new THREE.DirectionalLight('#fff1dc', 2.6);
    this.sun.position.copy(sunDir).multiplyScalar(80);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -60;
    s.right = s.top = 60;
    s.near = 1;
    s.far = 250;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
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

    const view = this.gui.addFolder('View');
    bind(view, 'fov', 55, 100, 1);
    bind(view, 'showDebug');
    view
      .add({ physicsDebug: false }, 'physicsDebug')
      .name('physics colliders')
      .onChange((on: boolean) => this.physics.setDebug(this.scene, on));
    bind(inputFolder, 'adsSensitivityMultiplier', 0.2, 1, 0.05);

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
    wf.add({ refill: () => { this.combat.health.reset(); } }, 'refill').name('Refill health + shield');

    const tp = this.gui.addFolder('Teleport');
    const spots: Record<string, [number, number, number]> = {
      Spawn: [0, 0, 8], Range: [70, 0, 4], Ledges: [-10, 0, -4], Ramps: [21, 0, -2], Stairs: [-30, 0, 13],
      'Vault walls': [-9, 0, 50], 'Slide hill (top)': [-70, 5, 22], Ladder: [-45, 0, -23], Corridor: [41.5, 0, 12],
    };
    for (const [name, [x, y, z]] of Object.entries(spots)) {
      tp.add({ go: () => this.player.teleport(new THREE.Vector3(x, y + 0.1, z)) }, 'go').name(name);
    }
    this.gui.close();
  }

  private frame(now: number): void {
    this.stats.begin();
    const steps = this.time.tick(now);
    const dt = this.time.delta;

    this.input.update(dt);
    const alive = this.combat.health.alive;
    const active = this.hud.playing && alive;
    const aiming = active && this.input.adsAxis > 0.3;
    if (this.input.activeDevice === 'gamepad' && (this.input.pressed('fire') || this.input.pressed('jump'))) Sfx.unlock();

    if (active) {
      const assist =
        this.input.activeDevice === 'gamepad'
          ? this.aimAssist.compute(this.camera, Settings.get('aimAssist'), this.rig.ads, Math.abs(this.input.moveX) + Math.abs(this.input.moveY) + Math.abs(this.input.lookX) > 0.01, dt, this.player.collider)
          : undefined;
      this.rig.handleInput(this.input, dt, aiming, assist);
    }
    this.combat.update(dt, active ? this.input : IDLE_INPUT, active);
    const facing = aiming || this.combat.combatFacing;
    this.player.frameInput(active ? this.input : IDLE_INPUT, this.rig.moveYaw, this.rig.yaw, facing, dt);
    if (active && this.input.down('fire')) this.player.breakSprint();

    for (let i = 0; i < steps; i++) {
      this.player.step();
      this.range.step();
      this.ballistics.step(FIXED_DT);
      this.physics.step();
      if (this.player.center.y < -50) this.player.teleport(this.spawn);
    }

    this.physics.syncMeshes();
    this.physics.updateDebug();
    this.player.interpolate(this.time.alpha);
    this.animator.update(dt, this.player, this.rig.pitch, this.combat.pose);
    this.rig.update(dt, this.player, aiming, this.animator.root);
    this.range.update(dt);
    this.ballistics.render();
    this.effects.update(dt);

    // Keep shadow frustum centred on player
    const p = this.player.renderCenter;
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.sunDir, 80);

    this.hud.update(dt, Settings.get('showDebug'), this.player, this.rig);
    this.combatHud.update(dt, this.combat, this.rig, this.player);
    this.renderer.render(this.scene, this.camera);
    this.stats.end();
    this.stats.update();
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
