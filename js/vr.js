/* =====================================================================
   TP03 - WebVR : composants A-Frame
   ---------------------------------------------------------------------
   thumbstick-locomotion  Ex1 : joystick gauche = déplacement, droit = rotation
   grabber                Ex2 : saisir / relâcher (+ lancer) les .grabbable
   gun / projectile       Ex3 : arme saisissable, tir de balles physiques
   target / target-spawner / particle-burst / score-board   Ex4
   ===================================================================== */

const VR = {
  GROUP_WORLD: 1,       // groupes de collision cannon (bitmask)
  GROUP_PROJECTILE: 2,
  tmpV: new THREE.Vector3(),
  tmpV2: new THREE.Vector3(),
  tmpQ: new THREE.Quaternion(),
  tmpM: new THREE.Matrix4(),
  whenBody(el, fn) {
    if (el.body) fn(el.body); else el.addEventListener('body-loaded', () => fn(el.body), { once: true });
  },
  pulse(handEl, intensity = 0.5, ms = 40) {
    try {
      const gp = handEl.components['tracked-controls'].controller.gamepad;
      gp.hapticActuators && gp.hapticActuators[0] && gp.hapticActuators[0].pulse(intensity, ms);
    } catch (e) { /* pas de retour haptique disponible */ }
  }
};

/* ---------------------------------------------------------------------
   Ex1 : thumbstick-locomotion (sur le rig)
   - joystick gauche : avant/arrière/gauche/droite, dans la direction du REGARD
     (projetée à l'horizontale, on ne s'envole pas en regardant le ciel)
   - joystick droit  : rotation de la vue (continue ou par crans "snap")
     La rotation se fait autour de la TÊTE du joueur, pas du centre du rig,
     sinon le joueur "glisse" en tournant (source de cybermalaise).
   --------------------------------------------------------------------- */
AFRAME.registerComponent('thumbstick-locomotion', {
  schema: {
    leftHand: { type: 'selector' },
    rightHand: { type: 'selector' },
    camera: { type: 'selector' },
    speed: { default: 2.5 },          // m/s
    turnSpeed: { default: 120 },      // °/s (mode continu)
    snapTurn: { default: false },
    snapAngle: { default: 30 },       // ° (mode snap)
    deadzone: { default: 0.2 }
  },
  init() {
    this.move = { x: 0, y: 0 };
    this.turn = 0;
    this.snapLatched = false;
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    const dz = (v) => (Math.abs(v) < this.data.deadzone ? 0 : v);
    this.data.leftHand.addEventListener('thumbstickmoved', (e) => { this.move.x = dz(e.detail.x); this.move.y = dz(e.detail.y); });
    this.data.rightHand.addEventListener('thumbstickmoved', (e) => { this.turn = dz(e.detail.x); });
  },
  rotateAroundHead(angle) {
    const rig = this.el.object3D;
    const head = this.data.camera.object3D.getWorldPosition(VR.tmpV);
    // position du rig relative à la tête, tournée autour de Y, puis replacée
    const off = VR.tmpV2.copy(rig.position).sub(head);
    off.applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    rig.position.copy(head).add(off);
    rig.rotation.y += angle;
  },
  tick(t, dtMs) {
    if (!dtMs) return;
    const dt = Math.min(dtMs / 1000, 0.1), d = this.data;

    // --- déplacement
    if (this.move.x || this.move.y) {
      d.camera.object3D.getWorldDirection(this.forward); // Object3D -> +Z monde
      this.forward.negate().setY(0);                      // caméra regarde vers -Z
      if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
      this.forward.normalize();
      this.right.set(-this.forward.z, 0, this.forward.x);
      // joystick : y < 0 quand on pousse vers l'avant
      this.el.object3D.position
        .addScaledVector(this.forward, -this.move.y * d.speed * dt)
        .addScaledVector(this.right, this.move.x * d.speed * dt);
    }

    // --- rotation
    if (d.snapTurn) {
      if (!this.snapLatched && Math.abs(this.turn) > 0.7) {
        this.rotateAroundHead(-Math.sign(this.turn) * THREE.MathUtils.degToRad(d.snapAngle));
        this.snapLatched = true;
      } else if (Math.abs(this.turn) < 0.3) this.snapLatched = false;
    } else if (this.turn) {
      this.rotateAroundHead(-this.turn * THREE.MathUtils.degToRad(d.turnSpeed) * dt);
    }
  }
});

/* ---------------------------------------------------------------------
   Ex2 : grabber (sur chaque main)
   - gâchette de préhension (grip) enfoncée : on cherche le .grabbable le plus
     proche dont la boîte englobante (élargie de `radius`) contient la main.
   - pendant la saisie : le corps passe en KINEMATIC (plus de gravité, il
     pousse les autres objets) ; on lui donne à chaque pas physique la vitesse
     exacte qui l'amène sur la pose de la main => il suit la main.
   - relâché : retour en DYNAMIC + vitesse moyenne de la main des dernières
     frames => l'objet tombe (gravité) ou part si on le lance.
   - un objet avec `gun` se cale dans la main avec une pose fixe (voir gun.gripRotation).
   --------------------------------------------------------------------- */
AFRAME.registerComponent('grabber', {
  schema: { radius: { default: 0.08 } },
  init() {
    this.held = null;
    this.offset = new THREE.Matrix4();
    this.history = [];               // [{p: Vector3, t}] pour la vitesse de lancer
    this.box = new THREE.Box3();
    this.handPos = new THREE.Vector3();
    this.targetM = new THREE.Matrix4();
    this.tp = new THREE.Vector3(); this.tq = new THREE.Quaternion(); this.ts = new THREE.Vector3();
    this.el.addEventListener('gripdown', () => this.grab());
    this.el.addEventListener('gripup', () => this.release());
    this.el.addEventListener('triggerdown', () => {
      if (this.held && this.held.components.gun) { this.held.components.gun.fire(); VR.pulse(this.el, 0.8, 60); }
    });
    this.physics = this.el.sceneEl.systems.physics;
    this.physics.addComponent(this);
  },
  remove() { this.physics.removeComponent(this); },

  findCandidate() {
    this.el.object3D.getWorldPosition(this.handPos);
    let best = null, bestD = Infinity;
    for (const el of this.el.sceneEl.querySelectorAll('.grabbable')) {
      if (!el.body) continue;
      this.box.setFromObject(el.object3D).expandByScalar(this.data.radius);
      if (!this.box.containsPoint(this.handPos)) continue;
      const d = this.box.getCenter(VR.tmpV).distanceTo(this.handPos);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  },

  grab() {
    if (this.held) return;
    const el = this.findCandidate();
    if (!el) return;
    // si l'autre main tient déjà l'objet, elle le lâche (passage de main à main)
    for (const h of this.el.sceneEl.querySelectorAll('[grabber]')) {
      if (h !== this.el && h.components.grabber.held === el) h.components.grabber.release(true);
    }
    const hand = this.el.object3D, obj = el.object3D;
    hand.updateMatrixWorld(true); obj.updateMatrixWorld(true);
    const gun = el.components.gun;
    if (gun) {
      // pose fixe : la crosse dans le poing, le canon vers l'avant
      const r = gun.data.gripRotation, p = gun.data.gripPosition;
      this.offset.compose(
        VR.tmpV.set(p.x, p.y, p.z),
        VR.tmpQ.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(r.x), THREE.MathUtils.degToRad(r.y), THREE.MathUtils.degToRad(r.z))),
        VR.tmpV2.set(1, 1, 1));
    } else {
      // pose relative conservée : l'objet ne "saute" pas dans la main
      this.offset.copy(hand.matrixWorld).invert().multiply(obj.matrixWorld);
    }
    const body = el.body;
    body.type = CANNON.Body.KINEMATIC;
    body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0);
    body.wakeUp();
    this.held = el;
    this.history.length = 0;
    el.classList.add('held');
    el.emit('grabbed', { hand: this.el });
    VR.pulse(this.el, 0.3, 30);
  },

  release(silent) {
    const el = this.held;
    if (!el) return;
    this.held = null;
    el.classList.remove('held');
    const body = el.body;
    body.type = CANNON.Body.DYNAMIC;
    body.angularVelocity.set(0, 0, 0);
    // vitesse de lancer = moyenne sur ~100 ms
    const h = this.history;
    if (h.length >= 2) {
      const a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000;
      if (dt > 0) body.velocity.set((b.p.x - a.p.x) / dt, (b.p.y - a.p.y) / dt, (b.p.z - a.p.z) / dt);
    }
    body.wakeUp();
    if (!silent) el.emit('released', { hand: this.el });
  },

  // appelé par le système physique AVANT chaque pas de simulation
  beforeStep(t, dtMs) {
    if (!this.held || !dtMs) return;
    const body = this.held.body;
    const dt = Math.min(dtMs / 1000, this.physics.data.maxInterval);
    this.el.object3D.updateMatrixWorld(true);
    this.targetM.multiplyMatrices(this.el.object3D.matrixWorld, this.offset);
    this.targetM.decompose(this.tp, this.tq, this.ts);

    // vitesse qui amène exactement le corps sur la cible pendant ce pas
    body.velocity.set((this.tp.x - body.position.x) / dt, (this.tp.y - body.position.y) / dt, (this.tp.z - body.position.z) / dt);
    body.quaternion.set(this.tq.x, this.tq.y, this.tq.z, this.tq.w);
    body.angularVelocity.set(0, 0, 0);

    this.history.push({ p: this.tp.clone(), t });
    while (this.history.length > 2 && t - this.history[0].t > 100) this.history.shift();
  }
});

/* ---------------------------------------------------------------------
   Ex3 : gun — arme saisissable qui tire des projectiles physiques
   Le modèle (assets/pistol.glb) a le canon vers -Z et la crosse sur +Y.
   WebXR "grip space" : -Z = le long de la crosse (côté pouce),
   donc rotation X de -90° + 15° d'inclinaison de la crosse = -75°.
   --------------------------------------------------------------------- */
AFRAME.registerComponent('gun', {
  schema: {
    muzzle: { type: 'selector' },                         // point de sortie (enfant)
    speed: { default: 20 },                               // m/s (force initiale -> vitesse)
    gravityScale: { default: 0.6 },                       // 1 = gravité normale, 0 = tir tendu
    projectileMass: { default: 0.05 },
    projectileRadius: { default: 0.025 },
    lifetime: { default: 4000 },                          // ms
    cooldown: { default: 120 },                           // ms entre deux tirs
    gripRotation: { type: 'vec3', default: { x: -75, y: 0, z: 0 } },
    gripPosition: { type: 'vec3', default: { x: 0, y: 0, z: 0 } }
  },
  init() {
    this.last = 0;
    this.dir = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    VR.whenBody(this.el, (body) => {
      // l'arme ne doit pas entrer en collision avec ses propres balles
      body.collisionFilterGroup = VR.GROUP_WORLD;
      body.collisionFilterMask = VR.GROUP_WORLD;
    });
  },
  fire() {
    const now = performance.now();
    if (now - this.last < this.data.cooldown) return;
    this.last = now;
    const d = this.data;
    const muzzle = (d.muzzle || this.el).object3D;
    muzzle.getWorldPosition(this.pos);
    // direction du canon = -Z local de l'arme, exprimé dans le monde
    this.dir.set(0, 0, -1).applyQuaternion(this.el.object3D.getWorldQuaternion(VR.tmpQ)).normalize();

    const b = document.createElement('a-sphere');
    b.setAttribute('radius', d.projectileRadius);
    b.setAttribute('segments-width', 10); b.setAttribute('segments-height', 8);
    b.setAttribute('material', 'color: #ffd54f; emissive: #ff8f00; emissiveIntensity: 0.8');
    b.setAttribute('position', `${this.pos.x} ${this.pos.y} ${this.pos.z}`);
    b.setAttribute('dynamic-body', `shape: sphere; mass: ${d.projectileMass}; linearDamping: 0.01`);
    b.setAttribute('projectile', {
      vx: this.dir.x * d.speed, vy: this.dir.y * d.speed, vz: this.dir.z * d.speed,
      gravityScale: d.gravityScale, lifetime: d.lifetime
    });
    this.el.sceneEl.appendChild(b);

    // flash + son
    if (this.el.components.sound) this.el.components.sound.playSound();
    const flash = document.createElement('a-entity');
    flash.setAttribute('light', 'type: point; color: #ffb74d; intensity: 2.5; distance: 3');
    flash.setAttribute('position', `${this.pos.x} ${this.pos.y} ${this.pos.z}`);
    this.el.sceneEl.appendChild(flash);
    setTimeout(() => flash.parentNode && flash.parentNode.removeChild(flash), 60);
    this.el.emit('fired', { projectile: b });
  }
});

/* ---------------------------------------------------------------------
   projectile : vitesse initiale, gravité ajustable, durée de vie,
   détection d'impact.
   - Impact principal : événement `collide` du moteur physique.
   - Filet de sécurité anti "tunneling" : à 20 m/s une balle parcourt 33 cm
     par frame et peut traverser une cible fine entre deux pas ; on lance
     donc un rayon entre la position courante et la suivante.
   --------------------------------------------------------------------- */
AFRAME.registerComponent('projectile', {
  schema: {
    vx: { default: 0 }, vy: { default: 0 }, vz: { default: 0 },
    gravityScale: { default: 1 },
    lifetime: { default: 4000 }
  },
  init() {
    this.dead = false;
    this.born = performance.now();
    this.ray = new THREE.Raycaster();
    this.physics = this.el.sceneEl.systems.physics;
    VR.whenBody(this.el, (body) => {
      body.collisionFilterGroup = VR.GROUP_PROJECTILE;
      body.collisionFilterMask = VR.GROUP_WORLD;
      // NB : la vitesse initiale est appliquée au 1er beforeStep, car dynamic-body
      // remet body.velocity à 0 quand il démarre (play -> syncToPhysics).
      this.launched = false;
      this.physics.addComponent(this);
      this.el.addEventListener('collide', (e) => {
        const other = e.detail.body && e.detail.body.el;
        if (other && other.components.target) this.hit(other);
      });
    });
  },
  remove() { this.physics.removeComponent(this); },
  beforeStep(t, dtMs) {
    const body = this.el.body;
    if (!body || this.dead) return;
    if (!this.launched) { body.velocity.set(this.data.vx, this.data.vy, this.data.vz); this.launched = true; }
    // gravité propre au projectile : on ajoute m * g * (scale - 1)
    const g = this.physics.driver.world.gravity, k = body.mass * (this.data.gravityScale - 1);
    body.force.x += g.x * k; body.force.y += g.y * k; body.force.z += g.z * k;

    // rayon entre maintenant et la position au prochain pas (anti-tunneling)
    const dt = Math.min(dtMs / 1000, this.physics.data.maxInterval);
    const v = body.velocity, speed = v.length();
    if (speed > 1) {
      this.ray.set(VR.tmpV.set(body.position.x, body.position.y, body.position.z), VR.tmpV2.set(v.x / speed, v.y / speed, v.z / speed));
      this.ray.far = speed * dt + 0.05;
      const meshes = [];
      for (const el of this.el.sceneEl.querySelectorAll('[target]')) { const m = el.getObject3D('mesh'); if (m) meshes.push(m); }
      const hit = this.ray.intersectObjects(meshes, true)[0];
      if (hit) {
        let o = hit.object; while (o && !o.el) o = o.parent;
        if (o && o.el) this.hit(o.el);
      }
    }
    if (performance.now() - this.born > this.data.lifetime) this.kill();
  },
  hit(targetEl) {
    if (this.dead) return;
    targetEl.components.target && targetEl.components.target.onHit(this.el);
    this.kill();
  },
  kill() {
    if (this.dead) return;
    this.dead = true;
    // on ne retire jamais un corps pendant un pas physique -> setTimeout
    setTimeout(() => this.el.parentNode && this.el.parentNode.removeChild(this.el), 0);
  }
});

/* ---------------------------------------------------------------------
   Ex4 : particle-burst — explosion de particules (THREE.Points) :
   vitesses aléatoires, gravité, fondu, puis auto-suppression.
   --------------------------------------------------------------------- */
AFRAME.registerComponent('particle-burst', {
  schema: { color: { default: '#ffcc00' }, count: { default: 80 }, speed: { default: 4 }, duration: { default: 900 }, size: { default: 0.06 } },
  init() {
    const n = this.data.count;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // direction uniforme sur la sphère, vitesse aléatoire
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = this.data.speed * (0.4 + Math.random() * 0.8);
      this.vel.set([s * Math.cos(a) * sp, u * sp + 1.5, s * Math.sin(a) * sp], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({ color: this.data.color, size: this.data.size, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.el.setObject3D('mesh', new THREE.Points(geo, this.mat));
    this.age = 0;
  },
  tick(t, dtMs) {
    if (!dtMs) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    this.age += dtMs;
    const n = this.data.count, p = this.pos, v = this.vel;
    for (let i = 0; i < n * 3; i += 3) {
      v[i + 1] -= 9.8 * dt;
      v[i] *= 0.98; v[i + 2] *= 0.98;
      p[i] += v[i] * dt; p[i + 1] += v[i + 1] * dt; p[i + 2] += v[i + 2] * dt;
    }
    this.el.getObject3D('mesh').geometry.attributes.position.needsUpdate = true;
    this.mat.opacity = Math.max(0, 1 - this.age / this.data.duration);
    if (this.age > this.data.duration && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  },
  remove() { this.el.getObject3D('mesh').geometry.dispose(); this.mat.dispose(); }
});

/* ---------------------------------------------------------------------
   Ex4 : target — une cible touchée : son positionnel + particules + disparition
   --------------------------------------------------------------------- */
AFRAME.registerComponent('target', {
  schema: { points: { default: 1 }, sound: { default: '#hitSound' }, volume: { default: 1.2 } },
  init() { this.done = false; },
  onHit(projectileEl) {
    if (this.done) return;
    this.done = true;
    const scene = this.el.sceneEl;
    const p = this.el.object3D.getWorldPosition(new THREE.Vector3());
    const color = (this.el.getAttribute('material') || {}).color || '#ffcc00';

    // particules
    const fx = document.createElement('a-entity');
    fx.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
    fx.setAttribute('particle-burst', { color });
    scene.appendChild(fx);

    // son 3D à l'endroit de l'impact (volume / atténuation réglables)
    const snd = document.createElement('a-entity');
    snd.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
    snd.setAttribute('sound', {
      src: this.data.sound, autoplay: true, positional: true, volume: this.data.volume,
      distanceModel: 'inverse', refDistance: 3, rolloffFactor: 1.2
    });
    scene.appendChild(snd);
    setTimeout(() => snd.parentNode && snd.parentNode.removeChild(snd), 2000);

    scene.emit('target-hit', { points: this.data.points, target: this.el });
    setTimeout(() => this.el.parentNode && this.el.parentNode.removeChild(this.el), 0);
  }
});

/* ---------------------------------------------------------------------
   Ex4 : target-spawner — fait apparaître des cibles aléatoires
   (forme, couleur, position) toutes les `interval` ms, jusqu'à `max`.
   --------------------------------------------------------------------- */
AFRAME.registerComponent('target-spawner', {
  schema: {
    interval: { default: 2000 },
    max: { default: 8 },
    minDist: { default: 5 }, maxDist: { default: 12 },
    minY: { default: 0.8 }, maxY: { default: 3.2 },
    arc: { default: 140 }            // secteur (°) devant le joueur (-Z)
  },
  init() {
    this.timer = 0;
    this.shapes = [
      // shape = forme de collision cannon (auto = déduite de la géométrie)
      { tag: 'a-box', attrs: { width: 0.6, height: 0.6, depth: 0.6 } },
      { tag: 'a-cone', attrs: { 'radius-bottom': 0.4, 'radius-top': 0, height: 0.8 } },
      { tag: 'a-cylinder', attrs: { radius: 0.3, height: 0.7 } },
      { tag: 'a-sphere', attrs: { radius: 0.35 } },
      { tag: 'a-dodecahedron', attrs: { radius: 0.4 }, shape: 'sphere' }
    ];
    this.colors = ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#ffca28', '#ff7043'];
  },
  tick(t, dt) {
    if (!dt) return;
    this.timer += dt;
    if (this.timer < this.data.interval) return;
    this.timer = 0;
    if (this.el.sceneEl.querySelectorAll('[target]').length >= this.data.max) return;
    this.spawn();
  },
  spawn() {
    const d = this.data, r = Math.random;
    const s = this.shapes[Math.floor(r() * this.shapes.length)];
    const el = document.createElement(s.tag);
    for (const k in s.attrs) el.setAttribute(k, s.attrs[k]);
    const ang = THREE.MathUtils.degToRad((r() - 0.5) * d.arc);
    const dist = d.minDist + r() * (d.maxDist - d.minDist);
    const y = d.minY + r() * (d.maxY - d.minY);
    // positions en coordonnées MONDE autour du spawner (les cibles sont ajoutées à la scène)
    const c = this.el.object3D.getWorldPosition(VR.tmpV);
    el.setAttribute('position', `${c.x + Math.sin(ang) * dist} ${y} ${c.z - Math.cos(ang) * dist}`);
    el.setAttribute('rotation', `${r() * 360} ${r() * 360} 0`);
    el.setAttribute('material', `color: ${this.colors[Math.floor(r() * this.colors.length)]}; roughness: 0.5`);
    el.setAttribute('shadow', 'cast: true');
    el.setAttribute('target', '');
    // apparition en "pop". Le corps physique est créé APRÈS l'animation : sa forme
    // de collision est calculée à la création, avec l'échelle du moment.
    el.setAttribute('animation__in', 'property: scale; from: 0.01 0.01 0.01; to: 1 1 1; dur: 400; easing: easeOutBack');
    el.addEventListener('animationcomplete__in', () => {
      // static-body : la cible flotte (pas de gravité) mais reste solide ;
      // l'animation de rotation fait tourner le corps physique avec elle.
      el.setAttribute('static-body', `shape: ${s.shape || 'auto'}`);
    }, { once: true });
    el.setAttribute('animation__spin', `property: rotation; to: ${r() * 360} ${360 + r() * 360} 0; dur: ${5000 + r() * 5000}; loop: true; easing: linear; dir: alternate`);
    el.classList.add('target');
    this.el.sceneEl.appendChild(el);
  }
});

/* ---------------------------------------------------------------------
   score-board : compte les impacts (événement "target-hit")
   --------------------------------------------------------------------- */
AFRAME.registerComponent('score-board', {
  init() {
    this.score = 0;
    this.el.setAttribute('text', { value: 'Score : 0', align: 'center', width: 4, color: '#ffffff' });
    this.el.sceneEl.addEventListener('target-hit', (e) => {
      this.score += e.detail.points;
      this.el.setAttribute('text', 'value', `Score : ${this.score}`);
    });
  }
});

/* ---------------------------------------------------------------------
   desktop-debug : pour tester SANS casque (souris + clavier)
   G : saisir / relâcher l'objet visé avec la "main droite" simulée
   F : tirer (si l'arme est tenue)
   La main droite est alors attachée devant la caméra.
   --------------------------------------------------------------------- */
AFRAME.registerComponent('desktop-debug', {
  schema: { hand: { type: 'selector' }, camera: { type: 'selector' } },
  init() {
    const scene = this.el.sceneEl;
    this.active = true;
    scene.addEventListener('enter-vr', () => { this.active = false; });
    scene.addEventListener('exit-vr', () => { this.active = true; });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.repeat) return;
      const hand = this.data.hand;
      if (e.code === 'KeyG') {
        if (hand.components.grabber.held) { hand.emit('gripup'); return; }
        // objet visé au centre de l'écran (<= 3 m) -> amené dans la main simulée, puis saisi
        const target = this.aimedGrabbable();
        if (target) {
          const p = hand.object3D.getWorldPosition(new THREE.Vector3());
          target.body.position.set(p.x, p.y, p.z);
          target.object3D.position.copy(p); // (les .grabbable sont enfants directs de la scène)
          hand.emit('gripdown');
        }
      }
      if (e.code === 'KeyF') hand.emit('triggerdown');
    });
    this.local = new THREE.Vector3(0.25, -0.25, -0.5);
    this.ray = new THREE.Raycaster();
  },
  aimedGrabbable() {
    const cam = this.el.sceneEl.camera;
    this.ray.setFromCamera({ x: 0, y: 0 }, cam);
    this.ray.far = 3;
    const els = [...this.el.sceneEl.querySelectorAll('.grabbable')].filter((el) => el.body);
    const hit = this.ray.intersectObjects(els.map((el) => el.object3D), true)[0];
    if (!hit) return null;
    let o = hit.object; while (o && !o.el) o = o.parent;
    return o ? o.el : null;
  },
  tick() {
    if (!this.active) return;
    // place la main droite devant la caméra (hors VR les manettes ne sont pas suivies)
    const cam = this.data.camera.object3D, hand = this.data.hand.object3D;
    cam.updateMatrixWorld(true);
    const p = VR.tmpV.copy(this.local).applyMatrix4(cam.matrixWorld);
    hand.parent.worldToLocal(p);
    hand.position.copy(p);
    // la main vise le point regardé à 10 m (convergence), puis +75° en X pour
    // compenser la pose de l'arme (-75°) => le canon pointe vers le centre de l'écran
    const aim = new THREE.Vector3(0, 0, -10).applyMatrix4(cam.matrixWorld);
    const handWorld = hand.getWorldPosition(new THREE.Vector3());
    const m = new THREE.Matrix4().lookAt(handWorld, aim, THREE.Object3D.DEFAULT_UP);
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(75), 0, 0)));
    const pq = hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    hand.quaternion.copy(pq.multiply(q));
  }
});
