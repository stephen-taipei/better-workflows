// Public teaching playback only. This module has no live-service adapter.
(() => {
  "use strict";
  const root = document.documentElement;
  if (root.dataset.replayMode !== "public-demo") return;
  const node = (id) => document.getElementById(id);
  let data;
  try { data = JSON.parse(node("evidence-cinema-data").textContent); } catch { return; }
  if (data.demo !== true || data.authoritative !== false || data.presentationOnly !== true
    || data.locale !== root.lang || !Array.isArray(data.scenes) || data.scenes.length !== 8
    || data.scenes.some((scene, index) => scene.no !== String(index + 1).padStart(2, "0")
      || !/^assets\/scene-0[1-8]-[a-z]+\.webp$/.test(scene.image) || !/^assets\/character-[a-z]+\.webp$/.test(scene.avatar)
      || !node("chapter-" + scene.no))) return;
  const { scenes, unknown, ui } = data;
  if (!ui || !unknown || !node("chapter-08-unknown")) return;
  const controls = ["restart-button", "previous-button", "play-button", "next-button", "story-progress", "speed-select"];
  if (controls.some((id) => !node(id))) return;
  const listeners = new AbortController();
  const listen = (target, event, handler) => target.addEventListener(event, handler, { signal: listeners.signal });
  const format = (template, values) => template.replace(/\{([a-z]+)\}/g, (_, key) => values[key]);
  const text = (id, value) => { node(id).textContent = value; };
  const duration = 64000, sceneMs = 8000;
  let elapsed = 0, playing = false, frame = 0, lastTime = null, active = -1, speed = 1, ending = "verified";
  const chapter = (index) => node("chapter-" + scenes[index].no + (index === 7 && ending === "unknown" ? "-unknown" : ""));
  const currentScene = (index) => index === 7 && ending === "unknown" ? { ...scenes[index], ...unknown } : scenes[index];
  const setPlaying = (value) => {
    playing = value; lastTime = null;
    cancelAnimationFrame(frame); frame = 0;
    text("play-button", (playing ? "Ⅱ " : "▶ ") + (playing ? ui.pause : ui.play));
    node("play-button").setAttribute("aria-label", playing ? ui.pause : ui.play);
    node("play-button").setAttribute("aria-pressed", String(playing));
    root.dataset.playing = String(playing);
    if (playing) frame = requestAnimationFrame(tick);
  };
  const render = (force = false) => {
    const index = Math.min(7, Math.floor(elapsed / sceneMs)), scene = currentScene(index);
    node("story-progress").value = String(elapsed / 1000);
    const seconds = Math.floor(elapsed / 1000);
    text("current-time", String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0"));
    if (index === active && !force) return;
    active = index;
    const image = node("scene-image"); image.src = "/docs/evidence-cinema/" + scene.image; image.alt = scene.alt;
    const avatar = node("actor-avatar"); avatar.src = "/docs/evidence-cinema/" + scene.avatar; avatar.alt = format(ui.portrait, { actor: scene.actor });
    text("actor-name", scene.actor); text("scene-role", scene.role); text("scene-title", scene.title);
    text("scene-dialogue", scene.dialogue); text("scene-state", scene.badge); text("scene-fact", scene.fact); text("derived-state", scene.state);
    text("scene-index", format(ui.sceneIndex, { number: scene.no }));
    node("scene-state").dataset.terminal = String(index === 7);
    // Clone only the already-rendered public transcript. No HTML string input.
    const proof = chapter(index);
    node("record-list").replaceChildren(...[...proof.querySelector(".record-list").children].map((child) => child.cloneNode(true)));
    const source = proof.querySelector(".record-source");
    node("record-source").setAttribute("href", source.getAttribute("href"));
    text("record-source", scene.source.label);
    text("raw-record", JSON.stringify({ demo: true, authoritative: false, presentationOnly: true, recordedOutcome: null,
      ending, scene: scene.no, derivedState: scene.state, records: scene.records }, null, 2));
    for (const link of document.querySelectorAll("[data-demo-scene]")) {
      if (Number(link.dataset.demoScene) === index) link.setAttribute("aria-current", "step"); else link.removeAttribute("aria-current");
    }
  };
  const go = (index) => { setPlaying(false); elapsed = Math.max(0, Math.min(7, index)) * sceneMs; render(); };
  function tick(time) {
    if (!playing) return;
    if (lastTime !== null) elapsed = Math.min(duration, elapsed + Math.min(250, Math.max(0, time - lastTime)) * speed);
    lastTime = time; render();
    if (elapsed >= duration) setPlaying(false); else frame = requestAnimationFrame(tick);
  }
  const togglePlayback = () => { if (!playing && elapsed >= duration) { elapsed = 0; render(); } setPlaying(!playing); };
  listen(node("play-button"), "click", togglePlayback);
  listen(node("restart-button"), "click", () => { go(0); setPlaying(true); });
  listen(node("previous-button"), "click", () => go(active - 1));
  listen(node("next-button"), "click", () => go(active + 1));
  listen(node("story-progress"), "input", () => { setPlaying(false); elapsed = Math.max(0, Math.min(duration, Number(node("story-progress").value) * 1000)); render(); });
  listen(node("speed-select"), "change", () => { const value = Number(node("speed-select").value); if ([0.75, 1, 1.25, 1.5].includes(value)) speed = value; });
  for (const link of document.querySelectorAll("[data-demo-scene], [data-cast-scene]")) listen(link, "click", (event) => {
    // Modified clicks retain native anchor behavior and its full transcript.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); go(Number(link.dataset.demoScene ?? link.dataset.castScene));
    if (link.hasAttribute("data-cast-scene")) node("cinema").scrollIntoView({ block: "start" });
  });
  for (const button of document.querySelectorAll("button[data-ending]")) {
    button.disabled = false;
    listen(button, "click", () => {
      ending = button.dataset.ending === "unknown" ? "unknown" : "verified"; root.dataset.ending = ending;
      for (const option of document.querySelectorAll("button[data-ending]")) option.setAttribute("aria-pressed", String(option.dataset.ending === ending));
      go(7); render(true);
    });
  }
  listen(node("cinema"), "keydown", (event) => {
    if (event.target.closest("button,input,select,a,summary,textarea") || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === " ") { event.preventDefault(); togglePlayback(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); go(active + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(active - 1); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(7); }
  });
  listen(document, "visibilitychange", () => { if (document.hidden) setPlaying(false); });
  // A page hidden in the back/forward cache must not retain a running timer.
  listen(window, "pagehide", () => setPlaying(false));
  node("cinema").tabIndex = 0;
  for (const id of controls) node(id).disabled = false;
  render(true); setPlaying(false);
})();
