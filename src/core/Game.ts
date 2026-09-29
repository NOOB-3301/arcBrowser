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
import { DebugPlayer } from '../player/DebugPlayer';
import { HUD } from '../ui/HUD';

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly time = new Time();
  readonly physics = new Physics();
  readonly input: Input;
  private sun!: THREE.DirectionalLight;
  private sunDir = new THREE.Vector3();
  private player!: DebugPlayer;
  private hud!: HUD;
  private stats!: Stats;
  private gui!: GUI;
  private jumpQueued = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;

    this.camera = new THREE.PerspectiveCamera(Settings.get('fov'), window.innerWidth / window.innerHeight, 0.05, 3000);
    this.input = new Input(canvas);

    window.addEventListener('resize', () => this.onResize());
    Events.on('settings:changed', ({ key, value }: { key: string; value: unknown }) => {
      if (key === 'fov') {
        this.camera.fov = value as number;
        this.camera.updateProjectionMatrix();
      }
    });
  }

  async init(): Promise<void> {
    await this.physics.init();
    this.buildEnvironment();

    const arena = new TestArena(this.scene, this.physics);
    arena.build();
    this.player = new DebugPlayer(this.scene, this.physics, arena.spawn);

    this.hud = new HUD(this.input);
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

    this.gui = new GUI({ title: 'Debug (M1)' });
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
    this.gui.close();
  }

  private frame(now: number): void {
    this.stats.begin();
    const steps = this.time.tick(now);
    const dt = this.time.delta;

    this.input.update(dt);
    const active = this.hud.playing;

    if (active) {
      this.player.look(this.input);
      if (this.input.pressed('jump')) this.jumpQueued = true;
      if (this.input.pressed('fire')) this.input.rumble(0.2, 0.5, 60);
    }

    for (let i = 0; i < steps; i++) {
      this.player.step(this.input, this.jumpQueued && active);
      this.jumpQueued = false;
      this.physics.step();
    }

    this.physics.syncMeshes();
    this.physics.updateDebug();
    this.player.render(this.camera, this.time.alpha);

    // Keep shadow frustum centred on player
    const p = this.player.position;
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.sunDir, 80);

    this.hud.update(dt, Settings.get('showDebug'));
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
