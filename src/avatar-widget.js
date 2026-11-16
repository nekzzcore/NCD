// ===== GoalTracker — 3D-виджет «Мой аватар» (голограмма-атлет) =====
// Сборка: npm run build:avatar  →  avatar.js (classic script, работает и в Electron file://)
//
// Если в assets/ лежит avatar.glb — показывается ваша модель,
// иначе — процедурная демо-фигура атлета.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const stage = document.getElementById('avatarStage');
const canvas = document.getElementById('avatarCanvas');

if (stage && canvas) {
    try {
        initWidget();
    } catch (e) {
        console.warn('[avatar] виджет не запущен:', e);
        stage.classList.add('avatar-fallback');
    }
}

function initWidget() {
    // ---------- Renderer ----------
    let renderer;
    try {
        // preserveDrawingBuffer: ?shot — чтобы страница-захват могла снять кадр (toDataURL)
        renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            preserveDrawingBuffer: location.search.includes('shot'),
        });
    } catch (e) {
        stage.classList.add('avatar-fallback');
        return;
    }
    renderer.setClearColor(0x05080f, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);

    // ---------- Материал «голограммы» ----------
    // Тёмное тело + светящиеся края (fresnel) + горизонтальные полосы + бегущая полоса сканирования
    const uTime = { value: 0 };
    const holoMat = new THREE.ShaderMaterial({
        uniforms: {
            uTime,
            uBase: { value: new THREE.Color(0x081119) },
            uEdge: { value: new THREE.Color(0x8fd6ff) },
            uAccent: { value: new THREE.Color(0x39b8ff) },
        },
        vertexShader: /* glsl */ `
            varying vec3 vN;
            varying vec3 vV;
            varying vec3 vW;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vW = wp.xyz;
                vN = normalize(mat3(modelMatrix) * normal);
                vV = normalize(cameraPosition - wp.xyz);
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform vec3 uBase;
            uniform vec3 uEdge;
            uniform vec3 uAccent;
            varying vec3 vN;
            varying vec3 vV;
            varying vec3 vW;
            void main() {
                float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.1);
                // тонкие «анатомические» полосы
                float lines = smoothstep(0.88, 1.0, sin(vW.y * 56.0 + uTime * 0.6) * 0.5 + 0.5);
                // бегущая полоса сканирования снизу вверх
                float bandY = fract(uTime * 0.22) * 2.4 - 0.3;
                float band = exp(-pow((vW.y - bandY) * 7.0, 2.0));
                vec3 col = uBase
                    + uEdge * fres * 1.5
                    + uAccent * lines * 0.22
                    + uEdge * band * 0.55;
                gl_FragColor = vec4(col, 1.0);
            }
        `,
    });

    const wireMat = new THREE.LineBasicMaterial({
        color: 0x6fc4ff,
        transparent: true,
        opacity: 0.10,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const wireCache = new WeakMap();
    function wireFor(geo) {
        let w = wireCache.get(geo);
        if (!w) {
            w = new THREE.WireframeGeometry(geo);
            wireCache.set(geo, w);
        }
        return w;
    }

    // ---------- Процедурный демо-атлет ----------
    const figure = new THREE.Group();          // вращается (drag/автоповорот)
    scene.add(figure);

    const UP = new THREE.Vector3(0, 1, 0);

    function addWire(mesh, geo, posCountLimit) {
        const pc = geo?.attributes?.position?.count || 0;
        if (pc && pc < (posCountLimit || 90000)) {
            const wire = new THREE.LineSegments(wireFor(geo), wireMat);
            wire.renderOrder = 2;
            mesh.add(wire);
        }
    }

    // капсула-«кость» между двумя суставами
    function bone(parent, a, b, rA, rB) {
        const va = new THREE.Vector3(...a);
        const vb = new THREE.Vector3(...b);
        const dir = vb.clone().sub(va);
        const len = dir.length();
        const geo = new THREE.CylinderGeometry(rB, rA, len, 18, 1, true);
        const m = new THREE.Mesh(geo, holoMat);
        m.position.copy(va.clone().add(dir.multiplyScalar(0.5)));
        m.quaternion.setFromUnitVectors(UP, vb.clone().sub(va).normalize());
        addWire(m, geo, 40000);
        parent.add(m);
        // суставные шары — плавные переходы
        for (const [p, r] of [[a, rA], [b, rB]]) {
            const sgeo = new THREE.SphereGeometry(r * 1.02, 16, 12);
            const s = new THREE.Mesh(sgeo, holoMat);
            s.position.set(...p);
            addWire(s, sgeo, 40000);
            parent.add(s);
        }
        return m;
    }

    // сглаженный корпус через профиль вращения (лате), сплюснутый по глубине
    function torso(parent) {
        // мужской V-силуэт: широкие плечи и грудь → талия прямая, бёдра уже плеч
        const pts = [
            [0.001, 0.88], [0.113, 0.90], [0.126, 0.97], [0.124, 1.04],
            [0.130, 1.10], [0.146, 1.18], [0.170, 1.26], [0.184, 1.33],
            [0.190, 1.40], [0.152, 1.46], [0.100, 1.50], [0.058, 1.535], [0.001, 1.55],
        ].map(([x, y]) => new THREE.Vector2(x, y));
        const geo = new THREE.LatheGeometry(pts, 28);
        const m = new THREE.Mesh(geo, holoMat);
        m.scale.z = 0.74;   // мужская грудная клетка шире и глубже
        addWire(m, geo, 60000);
        parent.add(m);
        // грудные — широкие плоские пластины, слегка скошенные вниз к центру
        for (const side of [1, -1]) {
            const pgeo = new THREE.SphereGeometry(1, 16, 12);
            const p = new THREE.Mesh(pgeo, holoMat);
            p.position.set(side * 0.074, 1.345, 0.126);
            p.scale.set(0.092, 0.038, 0.014);
            p.rotation.z = side * -0.11;
            addWire(p, pgeo, 40000);
            parent.add(p);
        }
        // пресс — тонкая рифлёная зона вровень с корпусом
        const ageo = new THREE.SphereGeometry(1, 18, 14);
        const abs = new THREE.Mesh(ageo, holoMat);
        abs.position.set(0, 1.125, 0.098);
        abs.scale.set(0.074, 0.125, 0.014);
        addWire(abs, ageo, 40000);
        parent.add(abs);
    }

    function buildPlaceholder() {
        const G = new THREE.Group();
        figure.add(G);

        torso(G);

        // шея (толстая, мужская) и голова (широкая, с выраженной челюстью)
        bone(G, [0, 1.46, 0.005], [0, 1.565, 0.012], 0.062, 0.054);
        const headGeo = new THREE.SphereGeometry(1, 22, 18);
        const head = new THREE.Mesh(headGeo, holoMat);
        head.position.set(0, 1.668, 0.014);
        head.scale.set(0.100, 0.118, 0.108);
        addWire(head, headGeo, 60000);
        G.add(head);
        // нижняя челюсть — широкий призматический подбородок
        const jawGeo = new THREE.SphereGeometry(1, 16, 12);
        const jaw = new THREE.Mesh(jawGeo, holoMat);
        jaw.position.set(0, 1.612, 0.030);
        jaw.scale.set(0.086, 0.052, 0.094);
        addWire(jaw, jawGeo, 40000);
        G.add(jaw);

        for (const side of [1, -1]) {
            // рука: плечо → локоть → запястье (плечи шире — V-силуэт)
            const sh = [side * 0.172, 1.452, 0];
            const el = [side * 0.232, 1.170, 0.008];
            const wr = [side * 0.262, 0.905, 0.028];
            // дельтовидная — крупная, «каплевидная», закрывает сустав
            const dgeo = new THREE.SphereGeometry(1, 16, 12);
            const delt = new THREE.Mesh(dgeo, holoMat);
            delt.position.set(side * 0.190, 1.430, 0);
            delt.scale.set(0.082, 0.090, 0.078);
            addWire(delt, dgeo, 40000);
            G.add(delt);
            bone(G, sh, el, 0.060, 0.045);   // бицепс/трицепс (толще)
            bone(G, el, wr, 0.045, 0.033);   // предплечье
            // кисть
            const hgeo = new THREE.SphereGeometry(1, 12, 10);
            const hand = new THREE.Mesh(hgeo, holoMat);
            hand.position.set(side * 0.270, 0.845, 0.034);
            hand.scale.set(0.036, 0.060, 0.022);
            addWire(hand, hgeo, 40000);
            G.add(hand);

            // нога: бедро → колено → щиколотка → стопа
            const hip = [side * 0.085, 0.940, 0];
            const kne = [side * 0.098, 0.500, 0.015];
            const ank = [side * 0.100, 0.090, -0.012];
            bone(G, hip, kne, 0.098, 0.062);   // бедро
            bone(G, kne, ank, 0.062, 0.040);   // голень
            // стопа
            const fgeo = new THREE.BoxGeometry(0.088, 0.058, 0.225);
            const foot = new THREE.Mesh(fgeo, holoMat);
            foot.position.set(side * 0.100, 0.030, 0.058);
            addWire(foot, fgeo, 40000);
            G.add(foot);
        }
        return G;
    }

    const placeholder = buildPlaceholder();

    // ---------- Платформа-голограмма ----------
    const platform = new THREE.Group();
    scene.add(platform);

    const discMat = new THREE.ShaderMaterial({
        uniforms: { uTime, uColor: { value: new THREE.Color(0x49c6ff) } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform vec3 uColor;
            varying vec2 vUv;
            void main() {
                float d = distance(vUv, vec2(0.5)) * 2.0;
                float glow = smoothstep(1.0, 0.15, d) * 0.42;
                float ring = smoothstep(0.035, 0.0, abs(d - 0.86)) * 0.8;
                float pulse = smoothstep(0.05, 0.0, abs(d - fract(uTime * 0.5) * 0.95)) * (1.0 - fract(uTime * 0.5)) * 0.5;
                gl_FragColor = vec4(uColor * (glow + ring + pulse), glow + ring + pulse);
            }
        `,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.72, 72), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.005;
    disc.renderOrder = 1;
    platform.add(disc);

    // ---------- Частицы, взмывающие вверх ----------
    const P_COUNT = 130;
    const pPos = new Float32Array(P_COUNT * 3);
    const pSpeed = new Float32Array(P_COUNT);
    for (let i = 0; i < P_COUNT; i++) {
        const r = Math.sqrt(Math.random()) * 0.62;
        const a = Math.random() * Math.PI * 2;
        pPos[i * 3] = Math.cos(a) * r;
        pPos[i * 3 + 1] = Math.random() * 2.0;
        pPos[i * 3 + 2] = Math.sin(a) * r;
        pSpeed[i] = 0.06 + Math.random() * 0.14;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
        color: 0x87dcff,
        size: 0.016,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    }));
    scene.add(points);

    // ---------- Камера / размеры ----------
    function fit() {
        const w = stage.clientWidth || 1;
        const h = stage.clientHeight || 1;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const distV = (2.25 / 2) / Math.tan(vFov / 2);
        const distH = (1.55 / 2) / (Math.tan(vFov / 2) * camera.aspect);
        const dist = Math.max(distV, distH);
        camera.position.set(0, 1.02, dist);
        camera.lookAt(0, 0.92, 0);
        camera.updateProjectionMatrix();
    }
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    fit();

    // ---------- Вращение: автоповорот + перетаскивание ----------
    let targetYaw = 0.35;
    let yaw = 0.35;
    let dragging = false;
    let lastX = 0;
    let idle = 0;

    stage.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        stage.setPointerCapture(e.pointerId);
        stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        targetYaw += (e.clientX - lastX) * 0.011;
        lastX = e.clientX;
        idle = 0;
    });
    const endDrag = () => { dragging = false; stage.classList.remove('is-dragging'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // ---------- Видимость (пауза, когда виджет скрыт) ----------
    let visible = true; // первый кадр рисуем сразу, observer поправит
    const io = new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
    }, { threshold: 0.02 });
    io.observe(stage);

    // ---------- Fallback: демонстративная фигура ----------
    // Модель загрузки удалена: если файла assets/avatar.glb нет,
    // приложение показывает дефолтную эмуляцию без ошибок 404.
    stage.classList.add('avatar-fallback');

    // ---------- HUD ----------
    function setHint(text) {
        const el = document.getElementById('avatarHint');
        if (el) el.textContent = text;
    }

    function update(data) {
        if (!data) return;
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null) el.textContent = v;
        };
        set('avatarLevel', data.level);
        set('avatarXp', data.xp);
        set('avatarStreak', data.streak);
        set('avatarBadges', data.badges);
        if (data.nickname) set('avatarCaption', data.nickname);
    }
    window.avatarWidget = { update };

    // первичное заполнение (app.js может позже вызывать update снова)
    setTimeout(() => {
        const app = window.app;
        if (app && app.user) {
            update({
                nickname: app.user.nickname,
                level: app.gamification.level,
                xp: app.gamification.xp,
                streak: app.gamification.streak,
                badges: app.gamification.badges.length,
            });
        }
    }, 600);

    // ---------- Цикл анимации ----------
    const clock = new THREE.Clock();
    function loop() {
        requestAnimationFrame(loop);
        if (!visible || document.hidden) return;

        const dt = Math.min(clock.getDelta(), 0.05);
        uTime.value += dt;

        idle += dt;
        if (!dragging && idle > 1.2) targetYaw += dt * 0.32; // медленное вращение
        yaw += (targetYaw - yaw) * Math.min(1, dt * 8);
        figure.rotation.y = yaw;

        // «дыхание»
        const breathe = 1 + Math.sin(uTime.value * 1.5) * 0.004;
        figure.scale.y = breathe;

        // частицы вверх
        const arr = pGeo.attributes.position.array;
        for (let i = 0; i < P_COUNT; i++) {
            arr[i * 3 + 1] += pSpeed[i] * dt;
            if (arr[i * 3 + 1] > 2.1) arr[i * 3 + 1] = 0;
        }
        pGeo.attributes.position.needsUpdate = true;

        renderer.render(scene, camera);
    }
    loop();
    // синхронный первый кадр — фигура видна сразу, без ожидания rAF
    renderer.render(scene, camera);
}
