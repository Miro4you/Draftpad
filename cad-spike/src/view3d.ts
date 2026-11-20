// 3D-Ansicht: Körper mit Kanten, drehen/zoomen mit Fingern oder Maus.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private material = new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.1, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x1d2833 });
  first = true; // beim nächsten Ergebnis einpassen

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -120, 90);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -2, 3);
    this.camera.add(sun);
    this.scene.add(this.camera);
    const grid = new THREE.GridHelper(200, 20, 0x8899aa, 0xc8d0d8);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid, this.group);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  setDark(dark: boolean) {
    this.material.color.set(dark ? 0x8fa3b8 : 0x9aa7b4);
    this.edgeMat.color.set(dark ? 0xdfe8f0 : 0x1d2833);
  }

  show(m: { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array; lines: Float32Array }) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
    this.group.add(new THREE.Mesh(g, this.material));
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(m.lines, 3));
    this.group.add(new THREE.LineSegments(eg, this.edgeMat));
    if (this.first) {
      this.fit();
      this.first = false;
    }
  }

  clear() {
    for (const c of [...this.group.children]) this.group.remove(c);
  }

  fit() {
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(c);
    const dir = new THREE.Vector3(0.45, -0.7, 0.55).normalize();
    this.camera.position.copy(c).addScaledVector(dir, size * 2.4);
    this.camera.near = size / 100;
    this.camera.far = size * 100;
    this.camera.updateProjectionMatrix();
  }
}
