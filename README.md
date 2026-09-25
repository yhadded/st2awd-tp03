# ST2AWD — TP03 — WebVR

Site statique : ouvrir `index.html` (liste des exercices). Bibliothèques via CDN, versions figées :

| Lib | Version | Utilisée dans |
|---|---|---|
| A-Frame | 1.6.0 (TP01, la version recommandée par AR.js 3.4.8) · 1.7.0 (TP02, TP03) | tout |
| AR.js (build A-Frame) | 3.4.8 | TP01 |
| @c-frame/aframe-physics-system (driver Cannon / cannon-es) | 4.2.4 | TP02 ex5-6, TP03 ex2-4 |
| qrcode-generator | 1.4.4 | TP01 `qr.html` |


## Publier sur GitHub Pages (obligatoire pour la caméra sur mobile : HTTPS)

```bash
git init && git add . && git commit -m "TPs ST2AWD"
git branch -M main
git remote add origin https://github.com/<user>/st2awd-tp03.git
git push -u origin main
```
Sur GitHub : **Settings → Pages → Source : Deploy from a branch → `main` / `/ (root)`**.
Le site est ensuite en ligne à `https://<user>.github.io/st2awd-tp03/`.

En local (desktop uniquement ; la caméra marche sur `localhost`) :
```bash
python -m http.server 8000     # puis http://localhost:8000
```
N'ouvrez pas les fichiers en `file://` : les textures, le `.patt` et le `.glb` seraient bloqués par le navigateur.

---


## Exercices

**Test :** dans le navigateur d'un Quest, ouvrez l'URL GitHub Pages puis appuyez sur le bouton VR. **Sans casque :** extension Chrome **Immersive Web Emulator**, ou **mode bureau intégré** (ex2 à 4) : `WASD` + souris, `G` pour saisir l'objet visé au centre de l'écran (à moins de 3 m) ou le lâcher, `F` pour tirer (le canon converge vers le centre de l'écran).

| Ex | Page | Ce qui est fait |
|---|---|---|
| 1 | `ex1.html` | `shadow="type: pcfsoft"`. Lumière **directionnelle** `castShadow` avec une caméra d'ombre de ±10 m et `shadowBias`, plus une lumière **ambiante**. Tous les objets ont `shadow="cast: true; receive: true"`. Rig = caméra + 2 `hand-controls`. `thumbstick-locomotion` : **stick gauche** pour se déplacer dans la direction du regard (projetée à l'horizontale), **stick droit** pour tourner, en continu ou par crans (`snapTurn: true`). La rotation se fait **autour de la tête** et non du centre du rig, ce qui évite le glissement et limite le mal des transports. |
| 2 | `ex2.html` | `grabber` sur chaque main. Au **grip**, la main saisit le `.grabbable` le plus proche dont la boîte englobante (élargie de 8 cm) la contient. Pendant la saisie, le corps passe en **KINEMATIC** et reçoit à chaque pas physique la vitesse exacte pour atteindre la pose de la main : il suit la main et pousse les autres objets. Au relâchement, il repasse en **DYNAMIC** avec la vitesse moyenne de la main sur 100 ms : il **tombe**, ou part si on le lance. On peut aussi passer un objet d'une main à l'autre. |
| 3 | `ex3.html` | `assets/pistol.glb` (modèle low-poly généré) avec un corps physique **composé de 2 boîtes** (`shape__slide`, `shape__grip`). Une arme saisie se cale dans la main avec une **pose fixe** : le « grip space » WebXR a son axe -Z le long de la crosse, d'où une rotation X de -90° + 15° d'inclinaison = **-75°**. Gâchette → balle `dynamic-body` avec **vitesse initiale** (`speed`, 20 m/s) et **gravité propre** (`gravityScale`, 0,6, via une force `m·g·(k-1)`), plus son, flash lumineux et vibration de la manette. Les groupes de collision empêchent l'arme de toucher ses propres balles. Cible d'essai : 8 canettes sur une étagère. |
| 4 | `ex4.html` | 3 cibles fixes, puis `target-spawner` : **une cible toutes les 2 s** (8 au maximum), forme, couleur, position et rotation aléatoires. Impact détecté par l'**événement `collide`** de cannon, plus un rayon anti-« tunneling » (à 20 m/s une balle parcourt 33 cm par frame). À l'impact : **son 3D positionnel** (`hit.wav`, `refDistance: 3`, `rolloffFactor: 1.2`, `volume` réglable dans `target`), **explosion de particules** (`THREE.Points`, gravité, fondu), score. |

Paramètres à ajuster pour l'Ex3 : `gun="speed: 20; gravityScale: 0.6; projectileMass: 0.05"`. Pour l'Ex4 : `target="volume: 1.2"` et `refDistance` / `rolloffFactor` dans `vr.js`.

**Deux pièges évités :**
- `dynamic-body` **remet `body.velocity` à 0** au démarrage (`play` → `syncToPhysics`). La vitesse initiale d'une balle est donc appliquée au **premier `beforeStep`**, pas à `body-loaded`.
- La forme de collision d'une cible est calculée **à la création** du corps. Les cibles apparaissent avec une animation d'échelle ; le `static-body` n'est donc ajouté qu'**après** l'animation, sinon la forme de collision serait minuscule.

---

