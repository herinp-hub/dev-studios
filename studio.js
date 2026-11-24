import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export function initStudio({ supabase, $, toast, getUser, getProfile, onPublished }) {
  const view = $("studioView");
  const canvas = $("studioCanvas");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101827);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  camera.position.set(13, 11, 16);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 1, 0);
  const hemi = new THREE.HemisphereLight(0xc8dcff, 0x344055, 2.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(10, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  const grid = new THREE.GridHelper(100, 100, 0x53627b, 0x26354b);
  grid.position.y = 0.01;
  scene.add(grid);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x253247, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = "StudioBaseplate";
  scene.add(floor);
  const gizmo = new TransformControls(camera, renderer.domElement);
  scene.add(gizmo.getHelper());
  gizmo.addEventListener("dragging-changed", e => { orbit.enabled = !e.value; });
  gizmo.addEventListener("objectChange", () => { syncInspector(); });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let objects = [];
  let selected = null;
  let currentProject = null;
  let playing = false;
  let publicMode = false;
  let player = null;
  let keys = {};
  let animationId = 0;
  let lastFrame = 0;
  let projectList = [];
  let objectCounter = 0;
  let scriptHandlers = [];
  const defaultScene = () => ({
    objects: [
      { id: "base-platform", name: "BasePlatform", type: "box", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [12, 1, 12], color: "#64748b" },
      { id: "spawn-point", name: "SpawnLocation", type: "cylinder", position: [0, 1.2, 0], rotation: [0, 0, 0], scale: [2, 0.35, 2], color: "#31c48d" },
      { id: "starter-block", name: "Part", type: "box", position: [3, 1.5, 0], rotation: [0, 0, 0], scale: [2, 2, 2], color: "#638cff" }
    ],
    script: '// DevScript: safe starter scripting\non start { color("Part", "#ff8a4c"); }\non click("Part") { color("Part", "#38d9a9"); say("Nice click!"); }\n'
  });
  function status(message) {
    const el = $("studioStatus");
    if (el) el.textContent = message;
  }
  function setEditorMode(on) {
    publicMode = !on;
    $("studioTools").classList.toggle("hidden", !on);
    $("studioInspector").classList.toggle("hidden", !on);
    $("studioScriptPanel").classList.toggle("hidden", !on);
    $("studioProjectBar")?.classList.toggle("hidden", !on);
    $("studioPlayLabel").textContent = on ? "Studio Editor" : "Published Game";
    $("studioPlayButton").classList.toggle("hidden", !on);
    $("studioSaveButton").classList.toggle("hidden", !on);
    $("studioPublishButton").classList.toggle("hidden", !on);
    $("studioExitButton").textContent = on ? "← Dashboard" : "← Back to Dev Studios";
  }
  function openView() {
    view.classList.remove("hidden");
    document.body.classList.add("studio-open");
    resize();
    if (!animationId) animate();
  }
  function closeView() {
    view.classList.add("hidden");
    document.body.classList.remove("studio-open");
    stopPlay();
    if (animationId) { cancelAnimationFrame(animationId); animationId = 0; }
    keys = {};
    $("studioInspector").classList.remove("open");
    status("");
    if (location.search.includes("play=")) history.replaceState(null, "", location.pathname);
  }
  function resize() {
    if (!view || view.classList.contains("hidden")) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  function geometry(type) {
    if (type === "sphere") return new THREE.SphereGeometry(1, 28, 18);
    if (type === "cylinder") return new THREE.CylinderGeometry(1, 1, 1, 24);
    if (type === "cone") return new THREE.ConeGeometry(1, 1.7, 24);
    return new THREE.BoxGeometry(1, 1, 1);
  }
  function createMesh(item) {
    const mesh = new THREE.Mesh(geometry(item.type || "box"), new THREE.MeshStandardMaterial({
      color: item.color || "#638cff",
      roughness: 0.68,
      metalness: 0.04
    }));
    mesh.name = item.name || "Part";
    mesh.userData.dsObject = true;
    mesh.userData.dsId = item.id || THREE.MathUtils.generateUUID();
    mesh.userData.dsType = item.type || "box";
    mesh.position.fromArray(item.position || [0, 1, 0]);
    mesh.rotation.set(...(item.rotation || [0, 0, 0]));
    mesh.scale.fromArray(item.scale || [2, 2, 2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    objects.push(mesh);
    return mesh;
  }
  function clearObjects() {
    if (selected) gizmo.detach();
    selected = null;
    for (const obj of objects) {
      scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    objects = [];
    if (player) { scene.remove(player); player.geometry.dispose(); player.material.dispose(); player = null; }
  }
  function loadScene(data) {
    clearObjects();
    const rows = Array.isArray(data?.objects) ? data.objects : [];
    rows.forEach(createMesh);
    $("studioScript").value = typeof data?.script === "string" ? data.script : "";
    $("studioScriptLength").textContent = $("studioScript").value.length + "/12000";
    refreshExplorer();
    selectObject(objects[0] || null);
  }
  function serializeScene() {
    return {
      objects: objects.map(obj => ({
        id: obj.userData.dsId,
        name: obj.name,
        type: obj.userData.dsType,
        position: obj.position.toArray(),
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        scale: obj.scale.toArray(),
        color: "#" + obj.material.color.getHexString()
      })),
      script: $("studioScript").value.slice(0, 12000)
    };
  }
  function refreshExplorer() {
    const list = $("studioExplorer");
    list.innerHTML = "";
    objects.forEach(obj => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "studio-tree-item" + (selected === obj ? " active" : "");
      row.textContent = (obj.userData.dsType === "sphere" ? "◉ " : obj.userData.dsType === "cylinder" ? "▰ " : "◧ ") + obj.name;
      row.addEventListener("click", () => selectObject(obj));
      list.appendChild(row);
    });
    $("studioObjectCount").textContent = objects.length + " objects";
  }
  function selectObject(obj) {
    selected = obj;
    if (!playing && !publicMode && obj) gizmo.attach(obj);
    else gizmo.detach();
    $("studioSelectedName").textContent = obj ? obj.name : "Nothing selected";
    if (window.innerWidth <= 900 && obj && !publicMode) $("studioInspector").classList.add("open");
    $("studioProperties").classList.toggle("hidden", !obj || publicMode);
    if (obj) syncInspector();
    refreshExplorer();
  }
  function fieldValue(id, value) { $(id).value = String(Number(value.toFixed(2))); }
  function syncInspector() {
    if (!selected) return;
    $("studioObjectName").value = selected.name;
    ["x", "y", "z"].forEach((axis, i) => {
      fieldValue("studioPos" + axis.toUpperCase(), selected.position.getComponent(i));
      fieldValue("studioSize" + axis.toUpperCase(), selected.scale.getComponent(i));
      fieldValue("studioRot" + axis.toUpperCase(), THREE.MathUtils.radToDeg(selected.rotation.getComponent(i)));
    });
    $("studioColor").value = "#" + selected.material.color.getHexString();
  }
  function applyInspector() {
    if (!selected) return;
    selected.name = $("studioObjectName").value.trim().slice(0, 32) || "Part";
    ["x", "y", "z"].forEach((axis, i) => {
      const pos = Number($("studioPos" + axis.toUpperCase()).value);
      const size = Number($("studioSize" + axis.toUpperCase()).value);
      const rot = Number($("studioRot" + axis.toUpperCase()).value);
      if (Number.isFinite(pos)) selected.position.setComponent(i, THREE.MathUtils.clamp(pos, -500, 500));
      if (Number.isFinite(size)) selected.scale.setComponent(i, THREE.MathUtils.clamp(Math.abs(size), 0.1, 100));
      if (Number.isFinite(rot)) selected.rotation.setComponent(i, THREE.MathUtils.degToRad(THREE.MathUtils.clamp(rot, -360, 360)));
    });
    selected.material.color.set($("studioColor").value);
    refreshExplorer();
  }
  function addPart(type) {
    if (publicMode || playing) return;
    objectCounter++;
    const mesh = createMesh({
      id: THREE.MathUtils.generateUUID(),
      name: type === "sphere" ? "Sphere" + objectCounter : type === "cylinder" ? "Cylinder" + objectCounter : type === "cone" ? "Cone" + objectCounter : "Part" + objectCounter,
      type,
      position: [0, 1.5, 0],
      scale: type === "cylinder" ? [2, 2, 2] : [2, 2, 2],
      color: type === "sphere" ? "#f0b85a" : type === "cylinder" ? "#39c6a4" : type === "cone" ? "#a78bfa" : "#638cff"
    });
    selectObject(mesh);
    status("Added " + mesh.name);
  }
  function runSafeScript(eventName, clickedName) {
    const source = $("studioScript").value.slice(0, 12000);
    scriptHandlers = [];
    const blockPattern = /on\s+(start|click\("([^"]{1,32})"\))\s*\{([^}]*)\}/g;
    let block;
    while ((block = blockPattern.exec(source))) {
      const type = block[1] === "start" ? "start" : "click";
      const target = block[2] || "";
      if (type === eventName && (type === "start" || target === clickedName)) {
        const body = block[3];
        const commandPattern = /(say|color|move|size)\s*\(([^;]*)\)\s*;/g;
        let command;
        while ((command = commandPattern.exec(body))) {
          const args = command[2].match(/"([^"]*)"|(-?\d+(?:\.\d+)?)/g) || [];
          const values = args.map(v => v.startsWith('"') ? v.slice(1, -1) : Number(v));
          if (command[1] === "say" && typeof values[0] === "string") {
            status(values[0].slice(0, 100));
          } else if (command[1] === "color" && typeof values[0] === "string" && /^#[0-9a-fA-F]{6}$/.test(values[1] || "")) {
            const targetObj = objects.find(o => o.name === values[0]);
            if (targetObj) targetObj.material.color.set(values[1]);
          } else if ((command[1] === "move" || command[1] === "size") && typeof values[0] === "string" && values.length === 4 && values.slice(1).every(Number.isFinite)) {
            const targetObj = objects.find(o => o.name === values[0]);
            if (targetObj) {
              const v = values.slice(1).map(n => THREE.MathUtils.clamp(n, -100, 100));
              if (command[1] === "move") targetObj.position.set(v[0], v[1], v[2]);
              else targetObj.scale.set(Math.max(.1, Math.abs(v[0])), Math.max(.1, Math.abs(v[1])), Math.max(.1, Math.abs(v[2])));
            }
          }
        }
      }
    }
    syncInspector();
    refreshExplorer();
  }
  function spawnPlayer() {
    if (player) return;
    player = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1, 4, 8), new THREE.MeshStandardMaterial({ color: 0xf7d38a }));
    player.position.set(0, 1.25, 5);
    player.castShadow = true;
    player.name = "Player";
    scene.add(player);
  }
  function startPlay() {
    if (playing) return;
    if (publicMode) return;
    playing = true;
    gizmo.detach();
    $("studioPlayButton").textContent = "■ Stop";
    $("studioPlayButton").classList.add("danger");
    spawnPlayer();
    $("studioDpad").classList.remove("hidden");
    status("Play mode: use WASD, arrows, or the touch pad to move. Tap a part to run its click script.");
    runSafeScript("start");
  }
  function stopPlay() {
    if (!playing) return;
    playing = false;
    if (player) { scene.remove(player); player.geometry.dispose(); player.material.dispose(); player = null; }
    $("studioDpad").classList.add("hidden");
    $("studioPlayButton").textContent = "▶ Play";
    $("studioPlayButton").classList.remove("danger");
    if (selected && !publicMode) gizmo.attach(selected);
    status("Stopped.");
  }
  function handlePointer(event) {
    if (view.classList.contains("hidden")) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(objects, false);
    if (!hits.length) { if (!playing) selectObject(null); return; }
    const obj = hits[0].object;
    if (playing || publicMode) {
      runSafeScript("click", obj.name);
      status("Clicked " + obj.name);
    } else selectObject(obj);
  }
  function animate(time = 0) {
    animationId = requestAnimationFrame(animate);
    const dt = Math.min((time - lastFrame) / 1000 || 0, 0.05);
    lastFrame = time;
    if (playing && player) {
      const speed = 7 * dt;
      if (keys.w || keys.ArrowUp) player.position.z -= speed;
      if (keys.s || keys.ArrowDown) player.position.z += speed;
      if (keys.a || keys.ArrowLeft) player.position.x -= speed;
      if (keys.d || keys.ArrowRight) player.position.x += speed;
      player.position.x = THREE.MathUtils.clamp(player.position.x, -45, 45);
      player.position.z = THREE.MathUtils.clamp(player.position.z, -45, 45);
    }
    orbit.update();
    renderer.render(scene, camera);
  }
  function validProject() {
    const user = getUser();
    if (!user) { toast("Sign in to create games."); return false; }
    return true;
  }
  function sceneData() { return serializeScene(); }
  async function saveProject() {
    if (!validProject()) return false;
    const title = $("studioTitle").value.trim().slice(0, 60);
    if (!title) { status("Give your game a title before saving."); $("studioTitle").focus(); return false; }
    const payload = {
      user_id: getUser().id,
      title,
      description: $("studioDescription").value.trim().slice(0, 300),
      genre: $("studioGenre").value.trim().slice(0, 24) || "Adventure",
      image_url: $("studioCover").value.trim() || null,
      scene: sceneData(),
      updated_at: new Date().toISOString()
    };
    $("studioSaveButton").disabled = true;
    status("Saving project…");
    try {
      let result;
      if (currentProject?.id) {
        result = await supabase.from("dev_studios_projects").update(payload).eq("id", currentProject.id).eq("user_id", getUser().id).select().single();
      } else {
        result = await supabase.from("dev_studios_projects").insert(payload).select().single();
      }
      if (result.error) throw result.error;
      currentProject = result.data;
      $("studioProjectTitle").textContent = currentProject.title;
      status("Saved " + currentProject.title);
      await loadProjectList();
      return true;
    } catch (error) {
      console.error(error);
      status("Save failed: " + (error.message || "check your connection"));
      return false;
    } finally {
      $("studioSaveButton").disabled = false;
    }
  }
  async function loadProjectList() {
    if (!getUser()) return;
    const result = await supabase.from("dev_studios_projects")
      .select("id,title,genre,is_published,updated_at")
      .eq("user_id", getUser().id)
      .order("updated_at", { ascending: false });
    if (result.error) { $("studioProjectList").textContent = "Could not load projects."; return; }
    projectList = result.data || [];
    const list = $("studioProjectList");
    list.innerHTML = "";
    if (!projectList.length) {
      list.textContent = "No projects yet. Create your first game!";
      return;
    }
    projectList.forEach(project => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "studio-project-item" + (currentProject?.id === project.id ? " active" : "");
      button.innerHTML = "<strong></strong><span></span>";
      button.querySelector("strong").textContent = project.title;
      button.querySelector("span").textContent = (project.genre || "Game") + (project.is_published ? " · Published" : " · Draft");
      button.addEventListener("click", () => openProject(project.id));
      list.appendChild(button);
    });
  }
  async function openProject(id) {
    const result = await supabase.from("dev_studios_projects").select("*").eq("id", id).eq("user_id", getUser().id).single();
    if (result.error) { status("Could not open project."); return; }
    currentProject = result.data;
    $("studioTitle").value = currentProject.title;
    $("studioDescription").value = currentProject.description || "";
    $("studioGenre").value = currentProject.genre || "Adventure";
    $("studioCover").value = currentProject.image_url || "";
    $("studioProjectTitle").textContent = currentProject.title;
    loadScene(currentProject.scene || defaultScene());
    await loadProjectList();
    status("Opened " + currentProject.title);
  }
  async function newProject() {
    if (!validProject()) return;
    stopPlay();
    currentProject = null;
    $("studioTitle").value = "Untitled Game";
    $("studioDescription").value = "A new game made with Dev Studios Studio.";
    $("studioGenre").value = "Adventure";
    $("studioCover").value = "";
    $("studioProjectTitle").textContent = "New project";
    loadScene(defaultScene());
    await loadProjectList();
    status("New project. Add parts, then save.");
  }
  async function publishProject() {
    if (!validProject()) return;
    if (!currentProject?.id && !(await saveProject())) return;
    if (currentProject?.id && !(await saveProject())) return;
    const slug = currentProject.published_game_slug || ("creator-" + currentProject.id.replace(/-/g, "").slice(0, 12));
    const profile = getProfile() || {};
    const launchUrl = location.origin + "/?play=" + encodeURIComponent(slug);
    $("studioPublishButton").disabled = true;
    status("Publishing to Dev Studios…");
    try {
      const game = {
        slug,
        title: currentProject.title,
        description: currentProject.description || "A game made with Dev Studios Studio.",
        status: "live",
        launch_url: launchUrl,
        image_url: currentProject.image_url || null,
        genre: currentProject.genre || "Adventure",
        creator_name: profile.display_name || profile.username || "Creator",
        creator_id: getUser().id
      };
      const published = await supabase.from("dev_studios_games").upsert(game, { onConflict: "slug" });
      if (published.error) throw published.error;
      const saved = await supabase.from("dev_studios_projects").update({
        is_published: true,
        published_game_slug: slug,
        updated_at: new Date().toISOString()
      }).eq("id", currentProject.id).eq("user_id", getUser().id);
      if (saved.error) throw saved.error;
      currentProject.is_published = true;
      currentProject.published_game_slug = slug;
      await loadProjectList();
      if (typeof onPublished === "function") await onPublished();
      status("Published! Your game is now in the Dev Studios dashboard.");
      toast("Your game is live on Dev Studios!");
    } catch (error) {
      console.error(error);
      status("Publish failed: " + (error.message || "check permissions"));
    } finally {
      $("studioPublishButton").disabled = false;
    }
  }
  async function openPublishedGame(slug) {
    publicMode = true;
    setEditorMode(false);
    openView();
    $("studioProjectTitle").textContent = "Loading game…";
    const result = await supabase.from("dev_studios_projects").select("id,title,description,genre,scene")
      .eq("published_game_slug", slug).eq("is_published", true).single();
    if (result.error) {
      $("studioProjectTitle").textContent = "Game unavailable";
      status("This published game could not be loaded.");
      return;
    }
    currentProject = result.data;
    $("studioProjectTitle").textContent = result.data.title;
    loadScene(result.data.scene || defaultScene());
    orbit.target.set(0, 1, 0);
    camera.position.set(13, 11, 16);
    playing = true;
    spawnPlayer();
    $("studioDpad").classList.remove("hidden");
    status("Explore the game. Move with the touch pad or WASD, and tap objects to interact.");
    runSafeScript("start");
  }
  function bindNumberFields() {
    ["studioObjectName", "studioPosX", "studioPosY", "studioPosZ", "studioSizeX", "studioSizeY", "studioSizeZ", "studioRotX", "studioRotY", "studioRotZ", "studioColor"]
      .forEach(id => $(id).addEventListener("change", applyInspector));
  }
  $("studioExitButton").addEventListener("click", closeView);
  $("studioPropertiesToggle").addEventListener("click", () => $("studioInspector").classList.toggle("open"));
  document.querySelectorAll("#studioDpad [data-move]").forEach(button => {
    const key = button.dataset.move;
    const down = event => { event.preventDefault(); keys[key] = true; };
    const up = event => { event.preventDefault(); keys[key] = false; };
    button.addEventListener("pointerdown", down);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointercancel", up);
    button.addEventListener("pointerleave", up);
  });
  $("studioNewButton").addEventListener("click", newProject);
  $("studioSaveButton").addEventListener("click", saveProject);
  $("studioPublishButton").addEventListener("click", publishProject);
  $("studioPlayButton").addEventListener("click", () => playing ? stopPlay() : startPlay());
  $("studioAddPart").addEventListener("click", () => addPart("box"));
  $("studioAddSphere").addEventListener("click", () => addPart("sphere"));
  $("studioAddCylinder").addEventListener("click", () => addPart("cylinder"));
  $("studioAddCone").addEventListener("click", () => addPart("cone"));
  $("studioDeletePart").addEventListener("click", () => {
    if (!selected || playing || publicMode) return;
    scene.remove(selected);
    selected.geometry.dispose();
    selected.material.dispose();
    objects = objects.filter(o => o !== selected);
    selected = null;
    gizmo.detach();
    $("studioProperties").classList.add("hidden");
    $("studioSelectedName").textContent = "Nothing selected";
    refreshExplorer();
  });
  $("studioMoveTool").addEventListener("click", () => gizmo.setMode("translate"));
  $("studioRotateTool").addEventListener("click", () => gizmo.setMode("rotate"));
  $("studioScaleTool").addEventListener("click", () => gizmo.setMode("scale"));
  $("studioCanvas").addEventListener("pointerdown", handlePointer);
  $("studioScriptRun").addEventListener("click", () => {
    if (!playing) startPlay();
    else runSafeScript("start");
    status("Scripts tested. " + $("studioScript").value.length + " characters loaded.");
  });
  $("studioTitle").addEventListener("input", () => { $("studioProjectTitle").textContent = $("studioTitle").value.trim() || "New project"; });
  $("studioScript").addEventListener("input", () => {
    $("studioScriptLength").textContent = $("studioScript").value.length + "/12000";
  });
  bindNumberFields();
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", e => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    keys[e.key] = true;
  });
  window.addEventListener("keyup", e => { keys[e.key] = false; });
  function showEditor() {
    if (!validProject()) return;
    publicMode = false;
    setEditorMode(true);
    openView();
    loadProjectList();
    if (!currentProject) newProject();
    resize();
  }
  refreshExplorer();
  return { showEditor, openPublishedGame, closeView };
}
