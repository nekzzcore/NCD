// Three.js 3D Health Avatar — яркая unlit-голограмма с запечённым рельефом
// ES-модуль. three + аддоны берутся из локального вендора (vendor/three) через import map
// в index.html — одна версия three (0.186) для core и addons, работает офлайн, без CDN.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

(function() {
    'use strict';

    // Ждём загрузки DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHealth3D);
    } else {
        initHealth3D();
    }

    // Desktop follows native display RAF; only mobile uses a 30 Hz budget. Idle scenes schedule nothing.
    function createFrameLoop(render, shouldAnimate, isMobile = false) {
        const interval = isMobile ? 1000 / 30 : 0;
        let raf = null, timer = null, running = false, dirty = true, lastTime = null;
        function requestFrame() {
            timer = null;
            if (running) raf = requestAnimationFrame(frame);
        }
        function schedule() {
            if (!running || raf !== null || timer !== null) return;
            const delay = !isMobile || lastTime === null ? 0 : Math.max(0, interval - (performance.now() - lastTime));
            if (delay > 0) timer = setTimeout(requestFrame, delay);
            else raf = requestAnimationFrame(frame);
        }
        function frame(time) {
            raf = null;
            if (!running) return;
            const elapsed = lastTime === null ? interval : time - lastTime;
            if (isMobile && elapsed + 0.01 < interval) { schedule(); return; }
            const delta = lastTime === null ? 0 : Math.min(elapsed / 1000, 0.1);
            lastTime = time;
            dirty = false;
            const changed = render(delta);
            if (dirty || changed || shouldAnimate()) schedule();
        }
        return {
            invalidate() { dirty = true; schedule(); },
            start() { if (running) return; running = true; lastTime = null; dirty = true; schedule(); },
            stop() {
                running = false;
                if (raf !== null) cancelAnimationFrame(raf);
                if (timer !== null) clearTimeout(timer);
                raf = timer = null; lastTime = null;
            }
        };
    }

    // Linear-time vertex clustering for static organic meshes, performed once at load.
    // Never simplify skin weights or morph targets: those require a dedicated asset pipeline.
    function simplifyStaticGeometry(source, triangleBudget) {
        const position = source.getAttribute('position');
        const index = source.getIndex();
        const count = index ? index.count : position.count;
        if (count / 3 <= triangleBudget) return source;
        source.computeBoundingBox();
        const { min, max } = source.boundingBox;
        const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
        if (!Number.isFinite(span) || span <= 0) return source;
        let result;
        for (let resolution = 256; resolution >= 4; resolution = Math.floor(resolution * 0.75)) {
            const scale = resolution / span, cells = new Map(), points = [], weights = [];
            const remap = new Uint32Array(position.count);
            for (let i = 0; i < position.count; i++) {
                const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
                const key = `${Math.floor((x - min.x) * scale)},${Math.floor((y - min.y) * scale)},${Math.floor((z - min.z) * scale)}`;
                let cell = cells.get(key);
                if (cell === undefined) { cell = weights.length; cells.set(key, cell); points.push(0, 0, 0); weights.push(0); }
                remap[i] = cell; weights[cell]++;
                points[cell * 3] += x; points[cell * 3 + 1] += y; points[cell * 3 + 2] += z;
            }
            for (let i = 0; i < weights.length; i++) for (let axis = 0; axis < 3; axis++) points[i * 3 + axis] /= weights[i];
            const triangles = [], seen = new Set();
            for (let i = 0; i < count; i += 3) {
                const a = remap[index ? index.getX(i) : i], b = remap[index ? index.getX(i + 1) : i + 1], c = remap[index ? index.getX(i + 2) : i + 2];
                if (a === b || b === c || a === c) continue;
                const key = [a, b, c].sort((x, y) => x - y).join(',');
                if (seen.has(key)) continue;
                seen.add(key); triangles.push(a, b, c);
            }
            if (!triangles.length) return source;
            result = { points, triangles };
            if (triangles.length / 3 <= triangleBudget) break;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(result.points, 3));
        geometry.setIndex(result.triangles);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return geometry;
    }

    function initHealth3D() {
        const container = document.getElementById('health3DCanvasContainer');
        if (!container) return;
        let sceneController = null, requestedActive = false;

        function setActive(active) {
            requestedActive = active;
            updateScene();
        }
        function updateScene() {
            const active = requestedActive && !document.hidden;
            if (active && !sceneController) {
                const loaderElement = document.getElementById('health3DLoader');
                const loaderText = document.getElementById('health3DLoaderText');
                const progress = document.getElementById('health3DProgress');
                if (loaderElement) loaderElement.hidden = false;
                if (loaderText) loaderText.textContent = 'Скан загружается...';
                if (progress) progress.removeAttribute('value');
                sceneController = createScene();
            } else if (!active && sceneController) {
                sceneController.dispose();
                sceneController = null;
            }
        }

        document.addEventListener('visibilitychange', updateScene);
        window.health3D = { setActive };
        setActive(document.getElementById('view-health')?.classList.contains('active') === true);

        function createScene() {
            // ===== КОНСТАНТЫ =====
            const nativePlatform = window.Capacitor?.getPlatform?.();
            const isMobile = nativePlatform === 'android' || nativePlatform === 'ios' || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            const HOLO_COLOR = new THREE.Color('#94a3b8');   // кибер-циан
            const FLOOR_Y = -1.3;                            // уровень пола
            const TARGET_HEIGHT = 2.6;                       // целевая высота модели

            // ===== CANVAS =====
            const canvas = document.createElement('canvas');
            canvas.id = 'health3DCanvas';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            container.appendChild(canvas);

            // ===== RENDERER =====
            const renderer = new THREE.WebGLRenderer({
                canvas,
                antialias: true,
                alpha: true,
                powerPreference: isMobile ? 'low-power' : 'high-performance'
            });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
            renderer.shadowMap.enabled = false;
            renderer.setClearColor(0x0f172a, 0); // почти чёрный — чтобы голограмма «светилась»
            renderer.outputColorSpace = THREE.SRGBColorSpace;

            function currentSize() {
                const w = container.clientWidth || 640;
                const h = container.clientHeight || 500;
                return { w, h };
            }
            let { w: W, h: H } = currentSize();
            renderer.setSize(W, H, false);

            // ===== SCENE =====
            const scene = new THREE.Scene();

            // ===== CAMERA =====
            const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000);
            // Full-height starting view, looking straight at the solar plexus.
            camera.position.set(0, FLOOR_Y + TARGET_HEIGHT * 0.6, 4.2);

            // ===== СВЕТ (нужен для тёмного пола — сама голограмма unlit) =====
            scene.add(new THREE.AmbientLight(0x223a55, 0.6));
            const keyLight = new THREE.DirectionalLight(0x94a3b8, 0.8);
            keyLight.position.set(2, 4, 3);
            scene.add(keyLight);

            // Bright unlit material; contour shading is baked into vertex colours once.
            const holoMaterial = new THREE.MeshBasicMaterial({
                color: HOLO_COLOR,
                vertexColors: true,
                transparent: true,
                opacity: 0.88,
                depthWrite: true,
                depthTest: true,
                side: THREE.FrontSide,
                forceSinglePass: true,
                blending: THREE.NormalBlending,
                toneMapped: false
            });
            function bakeHologramRelief(geometry) {
                if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
                const normals = geometry.getAttribute('normal');
                const colors = new Float32Array(normals.count * 3);
                for (let i = 0; i < normals.count; i++) {
                    // Soft fixed lighting retains muscle detail without per-pixel lighting.
                    const shade = 0.55 + 0.45 * Math.max(0, normals.getX(i) * 0.35 + normals.getY(i) * 0.65 + normals.getZ(i) * 0.67);
                    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = Math.min(1, shade);
                }
                geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            }

            function applyHologram(model) {
                const meshes = [];
                model.traverse((child) => {
                    if (child.isMesh) meshes.push(child);
                });

                for (const child of meshes) {
                    // Текстуры исходного материала голограмме не нужны: выгружаем их
                    // сразу после декодирования, не удерживая лишнюю GPU-память.
                    const originalMaterials = Array.isArray(child.material) ? child.material : [child.material];
                    originalMaterials.forEach(material => {
                        if (!material) return;
                        Object.values(material).forEach(value => {
                            if (value?.isTexture) value.dispose();
                        });
                        material.dispose();
                    });
                    child.material = holoMaterial;
                    const source = child.geometry;
                    if (source && !child.isSkinnedMesh && !Object.values(source.morphAttributes).some(values => values.length)) {
                        child.geometry = simplifyStaticGeometry(source, isMobile ? 45000 : 90000);
                        if (child.geometry !== source) source.dispose();
                    }
                    if (child.geometry) {
                        // The hologram samples no textures; keep only deformation/normal buffers.
                        for (const name of Object.keys(child.geometry.attributes)) {
                            if (!['position','normal','skinIndex','skinWeight'].includes(name)) child.geometry.deleteAttribute(name);
                        }
                        bakeHologramRelief(child.geometry);
                    }
                    child.castShadow = false;
                    child.receiveShadow = false;
                    child.frustumCulled = true;
                    child.renderOrder = 2;


                }
            }

            // ===== ТЁМНЫЙ ПОЛ + КРУГОВАЯ НЕОНОВАЯ ПЛАТФОРМА =====
            const floorGeo = new THREE.CircleGeometry(9, 64);
            const floorMat = new THREE.MeshBasicMaterial({ color: 0x223045 });
            const floor = new THREE.Mesh(floorGeo, floorMat);
            floor.rotation.x = -Math.PI / 2;
            floor.position.y = FLOOR_Y;
            scene.add(floor);

            // Яркая неоновая окантовка платформы
            const ringMat = new THREE.MeshBasicMaterial({
                color: HOLO_COLOR,
                transparent: true,
                opacity: 0.9,
                side: THREE.FrontSide,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const ring = new THREE.Mesh(new THREE.RingGeometry(1.68, 1.72, 64), ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = FLOOR_Y + 0.02;
            scene.add(ring);

            const innerRing = new THREE.Mesh(new THREE.RingGeometry(1.14, 1.16, 48), ringMat);
            innerRing.rotation.x = -Math.PI / 2;
            innerRing.position.y = FLOOR_Y + 0.02;
            scene.add(innerRing);

            // ===== ORBITCONTROLS (вращение пальцем/курсором + автовращение 360°) =====
            const controls = new OrbitControls(camera, renderer.domElement);
            // Мобильный UX: вертикальный жест пальцем прокручивает страницу,
            // горизонтальное перетаскивание вращает сцену, щипок — приблизить/отдалить.
            renderer.domElement.style.touchAction = 'pan-y';
            controls.touches.ONE = THREE.TOUCH.ROTATE;
            controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
            controls.enableDamping = true;
            controls.dampingFactor = 0.06;
            const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
            controls.autoRotate = !motionPreference.matches;
            controls.autoRotateSpeed = 2.0;
            controls.enablePan = false;
            // Зум: не даём залететь сквозь модель и не отдаляться до «муравья»
            controls.minDistance = 1.9;
            controls.maxDistance = 8;
            // Запрет верхнего ракурса «на макушку» — не даём смотреть сильно сверху вниз
            controls.minPolarAngle = Math.PI / 3;       // 60° от вертикали
            controls.maxPolarAngle = Math.PI / 1.7;     // ~106° — лёгкий взгляд снизу разрешён
            // Solar plexus target leaves room for both feet and head.
            controls.target.set(0, FLOOR_Y + TARGET_HEIGHT * 0.6, 0);
            camera.lookAt(controls.target);

            let interacting = false, resumeTimer = null;
            function resumeRotation() { controls.autoRotate = true; invalidate(); }
            // No per-frame 'change' listener: EventDispatcher otherwise copies its listener
            // array on every rotation step. Interaction and damping keep the loop alive.
            controls.addEventListener('start', () => { interacting = true; clearTimeout(resumeTimer); controls.autoRotate = false; invalidate(); });
            controls.addEventListener('end', () => {
                interacting = false;
                clearTimeout(resumeTimer);
                invalidate();
                if (!motionPreference.matches) resumeTimer = setTimeout(resumeRotation, 1800);
            });

            let bodyHalfWidth = TARGET_HEIGHT * 0.25, bodyHalfDepth = TARGET_HEIGHT * 0.2;
            let bodyHeight = TARGET_HEIGHT, bodyFloor = FLOOR_Y;
            function frameFullBody(root) {
                // Runs only after loading or resizing; no allocations in the render loop.
                if (root) {
                    const bounds = new THREE.Box3().setFromObject(root);
                    const size = bounds.getSize(new THREE.Vector3());
                    bodyHeight = size.y || TARGET_HEIGHT;
                    bodyFloor = bounds.min.y;
                    bodyHalfWidth = size.x / 2;
                    bodyHalfDepth = size.z / 2;
                }
                const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
                // Horizontal radius also fits the widest angle during auto-rotation.
                const radius = Math.hypot(bodyHalfWidth, bodyHalfDepth);
                const distance = Math.max(4.2, radius + 1.12 * Math.max(
                    bodyHeight * 0.6 / tanHalfFov, radius / (tanHalfFov * camera.aspect)
                ));
                controls.target.set(0, bodyFloor + bodyHeight * 0.6, 0);
                camera.position.set(0, controls.target.y, distance);
                camera.lookAt(controls.target);
                controls.minDistance = Math.max(1.9, Math.hypot(radius, bodyHeight * 0.6) + 0.2);
                controls.maxDistance = Math.max(8, distance * 1.8);
                controls.saveState();
            }

            // ===== ЗАГРУЗКА МОДЕЛИ (GLB) ИЛИ ЗАГЛУШКА =====
            const dracoLoader = new DRACOLoader();
            dracoLoader.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
            dracoLoader.setWorkerLimit(isMobile ? 1 : 2);
            const loader = new GLTFLoader();
            loader.setDRACOLoader(dracoLoader);
            const characterGroup = new THREE.Group();
            scene.add(characterGroup);
            let mixer = null;
            let disposed = false, modelReady = false;

            loader.load(
                './assets/avatar/character.glb',
                (gltf) => {
                    if (disposed) {
                        disposeObject(gltf.scene);
                        return;
                    }
                    const model = gltf.scene;

                    // Масштабируем и ставим модель на платформу
                    const preBox = new THREE.Box3().setFromObject(model);
                    const preSize = preBox.getSize(new THREE.Vector3());
                    const scale = preSize.y > 0.0001 ? TARGET_HEIGHT / preSize.y : 1;
                    model.scale.setScalar(scale);

                    const box = new THREE.Box3().setFromObject(model);
                    const center = box.getCenter(new THREE.Vector3());
                    model.position.x -= center.x;
                    model.position.z -= center.z;
                    model.position.y += FLOOR_Y - box.min.y;

                    applyHologram(model);
                    characterGroup.add(model);
                    frameFullBody(characterGroup);

                    // Проигрываем анимацию (idle), если есть
                    if (gltf.animations && gltf.animations.length > 0) {
                        mixer = new THREE.AnimationMixer(model);
                        mixer.clipAction(gltf.animations[0]).play();
                    }

                    updateStatus('3D-модель загружена ✓');
                    finishLoading();
                    invalidate();
                },
                (xhr) => {
                    if (disposed) return;
                    if (xhr.total) {
                        const pct = Math.round((xhr.loaded / xhr.total) * 100);
                        const progress = document.getElementById('health3DProgress');
                        if (progress) progress.value = pct;
                        updateStatus('Загрузка скана… ' + pct + '%');
                    } else {
                        updateStatus('Загрузка скана…');
                    }
                },
                (error) => {
                    if (disposed) return;
                    // Диагностика: почему не загрузился GLB (сеть уже отдала 200)
                    console.error('[GLTFLoader] Ошибка загрузки character.glb:', error && (error.stack || error.message || String(error)));
                    console.log('GLB не найден, создаю процедурный голограмм-манекен...');
                    createHoloMannequin(THREE, characterGroup);
                    frameFullBody(characterGroup);
                    updateStatus('Процедурный манекен создан ✓');
                    finishLoading();
                    invalidate();
                }
            );

            // ===== ЗАПАСНОЙ МАНЕКЕН (если GLB недоступен) =====
            function createHoloMannequin(THREE, group) {
                const addPart = (geo, x, y, z) => {
                    bakeHologramRelief(geo);
                    const m = new THREE.Mesh(geo, holoMaterial);
                    m.position.set(x, y, z);
                    m.frustumCulled = false;
                    group.add(m);
                };
                // Торс
                addPart(new THREE.CylinderGeometry(0.4, 0.32, 1.1, 20), 0, 0.45, 0);
                // Голова
                addPart(new THREE.SphereGeometry(0.26, 24, 24), 0, 1.35, 0);
                // Руки
                addPart(new THREE.CylinderGeometry(0.075, 0.075, 0.8, 14), -0.52, 0.55, 0);
                addPart(new THREE.CylinderGeometry(0.075, 0.075, 0.8, 14), 0.52, 0.55, 0);
                // Ноги
                addPart(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 14), -0.18, -0.55, 0);
                addPart(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 14), 0.18, -0.55, 0);
                group.position.y = FLOOR_Y + 1.3; // центрируем по платформе
            }

            // ===== ОБНОВЛЕНИЕ СТАТУСА =====
            function updateStatus(text) {
                const status = document.getElementById('bodyScanStatus');
                if (status) status.textContent = 'Статус: ' + text;
                const loaderText = document.getElementById('health3DLoaderText');
                if (loaderText && text.startsWith('Загрузка скана')) {
                    loaderText.textContent = text.replace('Загрузка скана', 'Скан загружается');
                }
            }

            function finishLoading() {
                modelReady = true;
                const loaderElement = document.getElementById('health3DLoader');
                if (loaderElement) loaderElement.hidden = true;
            }

            // ===== RESIZE (ResizeObserver — вкладка может быть скрыта при старте) =====
            function onResize() {
                if (disposed) return;
                const { w, h } = currentSize();
                if (w === W && h === H) return;
                W = w; H = h;
                camera.aspect = W / H;
                camera.updateProjectionMatrix();
                renderer.setSize(W, H, false);
                if (modelReady) frameFullBody();
                invalidate();
            }
            window.addEventListener('resize', onResize);
            let resizeObserver = null;
            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(onResize);
                resizeObserver.observe(container);
            }

            // ===== АНИМАЦИОННЫЙ ЦИКЛ =====
            const clock = new THREE.Clock(false);
            let delta = 0, controlsChanged = false;
            function renderFrame() {
                if (disposed) return false;
                delta = Math.min(clock.getDelta(), 0.1);
                if (!motionPreference.matches) mixer?.update(delta);
                controlsChanged = controls.update(delta);
                renderer.render(scene, camera);
                return controlsChanged;
            }
            function needsAnimation() { return interacting || (!motionPreference.matches && mixer !== null) || controls.autoRotate; }
            const frameLoop = createFrameLoop(renderFrame, needsAnimation, isMobile);
            function invalidate() { if (!disposed) frameLoop.invalidate(); }
            function updateSceneTheme() {
                const colors = getComputedStyle(document.documentElement);
                const light = document.documentElement.dataset.theme === 'light';
                floorMat.color.set(colors.getPropertyValue('--bg-secondary').trim() || '#223045');
                ringMat.color.set(light ? '#8b83bf' : '#8e9fc2');
                ringMat.blending = THREE.NormalBlending;
                holoMaterial.color.set(light ? '#65758f' : '#b9c7dc');
                invalidate();
            }
            const themeObserver = new MutationObserver(updateSceneTheme);
            themeObserver.observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
            updateSceneTheme();
            function onMotionChange() {
                clearTimeout(resumeTimer);
                controls.autoRotate = !motionPreference.matches;
                invalidate();
            }
            motionPreference.addEventListener('change', onMotionChange);

            function disposeObject(root) {
                const geometries = new Set();
                const materials = new Set();
                const textures = new Set();
                root?.traverse?.(object => {
                    if (object.geometry) geometries.add(object.geometry);
                    const list = Array.isArray(object.material) ? object.material : [object.material];
                    list.forEach(material => {
                        if (!material) return;
                        materials.add(material);
                        Object.values(material).forEach(value => {
                            if (value?.isTexture) textures.add(value);
                        });
                    });
                });
                textures.forEach(texture => texture.dispose());
                materials.forEach(material => material.dispose());
                geometries.forEach(geometry => geometry.dispose());
            }

            function dispose() {
                if (disposed) return;
                disposed = true;
                frameLoop.stop();
                clock.stop();
                clearTimeout(resumeTimer);
                window.removeEventListener('resize', onResize);
                resizeObserver?.disconnect();
                themeObserver.disconnect();
                if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); }
                mixer = null;
                motionPreference.removeEventListener('change', onMotionChange);
                controls.dispose();
                dracoLoader.dispose();
                disposeObject(scene);
                scene.clear();
                renderer.renderLists.dispose();
                renderer.dispose();
                renderer.forceContextLoss();
                holoMaterial.dispose();
                canvas.remove();
            }

            clock.start();
            frameLoop.start();
            return { dispose };
        }
    }
})();
