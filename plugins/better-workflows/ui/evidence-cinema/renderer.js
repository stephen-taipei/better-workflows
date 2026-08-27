(() => {
  "use strict";

  const sceneDurationMs = 8000;
  const demoScenes = [
    {
      no: "01", short: "Goal", accent: "#78a8ff", image: "assets/scene-01-goal.webp",
      alt: "Captain Root 在紙張與黃銅構成的檔案電影院舉起指揮棒，六位角色沿發光底片路徑準備出發",
      actor: "Captain Root", role: "GOAL KEEPER", avatar: "assets/character-root.webp",
      title: "先把「要完成什麼」拍成底片",
      dialogue: "沒有凍結的目標、範圍與驗收條件，就沒有可被重播的結局。",
      state: "run.created → pending", badge: "CONTRACT BOUND",
      fact: "TaskContract v2 凍結 goal、scope、acceptance、authority 與 stages；自由文字的「完成」不會改變狀態。",
      source: { label: "evidence-and-state.md · contract / state authority", href: "../../../plugins/better-workflows/skills/better-workflows/references/evidence-and-state.md" },
      records: [
        { kind: "task-contract", id: "demo-contract-01", status: "complete", summary: "目標、範圍與驗收條件已凍結", binding: "goal · scope · acceptance", digest: "sha256:demo-42bd…" },
        { kind: "ledger-event", id: "demo-event-001", status: "complete", summary: "run.created 成為第一筆 append-only event", binding: "root actor · contract digest", digest: "ledger:demo-0001" }
      ]
    },
    {
      no: "02", short: "Source", accent: "#f2c469", image: "assets/scene-02-binding.webp",
      alt: "Captain Root 與 Sentinel 把分支狀紙條藍圖罩在玻璃鐘內，旁邊的黃銅相機記錄當下狀態",
      actor: "Sentinel", role: "SOURCE SENTINEL", avatar: "assets/character-sentinel.webp",
      title: "把現在的 source 狀態鎖進同一格",
      dialogue: "HEAD、index、status、scope 或 symlink 漂移，下一幕就必須停機重拍。",
      state: "source captured → fresh", badge: "SOURCE FRESH",
      fact: "Source sentinel 讓後續 evidence、review 與 action 都指向同一棵 tree；presentation 無法消除 drift。",
      source: { label: "git.mjs · source binding / sentinel", href: "../../../plugins/better-workflows/scripts/lib/git.mjs" },
      records: [
        { kind: "source-binding", id: "demo-source-01", status: "complete", summary: "HEAD、index、status 與 scoped files 已綁定", binding: "revision · tree · scope", digest: "sha256:demo-a81c…" },
        { kind: "source-sentinel", id: "demo-sentinel-01", status: "complete", summary: "目前 tree capture 可供後續 freshness 重驗", binding: "files · submodules · symlinks", digest: "sentinel:demo-77ea" }
      ]
    },
    {
      no: "03", short: "Evidence", accent: "#ff8a72", image: "assets/scene-03-evidence.webp",
      alt: "Scout Pixel 從精確標記的檔案抽屜取出帶有指紋、時鐘、鏈結與封蠟的證據卡",
      actor: "Scout Pixel", role: "FINDER", avatar: "assets/character-pixel.webp",
      title: "證據要從來源拿，不是從語氣裡猜",
      dialogue: "每張卡都要有 kind、producer、payload、digest、dependency 與建立時間。",
      state: "evidence admitted → reusable while fresh", badge: "TYPED EVIDENCE",
      fact: "Evidence 先通過 kind contract、producer allowlist、payload semantics 與 digest 重算，才可能被 ledger 或 completion 消費。",
      source: { label: "evidence.mjs · typed evidence admission", href: "../../../plugins/better-workflows/scripts/lib/evidence.mjs" },
      records: [
        { kind: "baseline-checks", id: "demo-evidence-11", status: "complete", summary: "Baseline 驗證結果符合 typed payload", binding: "source · tool · schema", digest: "sha256:demo-b113…" },
        { kind: "test-results", id: "demo-evidence-12", status: "complete", summary: "測試 receipt 綁定目前 revision 與 command", binding: "revision · command · outcome", digest: "sha256:demo-6f20…" },
        { kind: "provenance-index", id: "demo-evidence-13", status: "complete", summary: "來源 locator 與產生者 metadata 齊備", binding: "producer · observedAt · source", digest: "sha256:demo-901e…" }
      ]
    },
    {
      no: "04", short: "Verify", accent: "#c3b8ff", image: "assets/scene-04-verifier.webp",
      alt: "Vera 在獨立投影室比較藍色與珊瑚色兩條底片，發現破裂影格與不一致的指紋",
      actor: "Vera", role: "INDEPENDENT VERIFIER", avatar: "assets/character-vera.webp",
      title: "Verifier 的工作，是找出不想看到的那格",
      dialogue: "確認證據與反證都要留下；finder 不能替自己的 finding 蓋章。",
      state: "claim checked → finding open", badge: "COUNTER-EVIDENCE",
      fact: "這一幕明確標示為 review-kernel-v2-pilot 的 observe-only 分支：Verifier 與 finder 分離；衝突結果變成 INCONCLUSIVE，missing 或 ambiguous anchor 仍然 blocking。它在 action 前結束，不替可執行 workflow 宣稱額外的 finder/verifier 權限。",
      source: { label: "review.mjs · finding / verification separation", href: "../../../plugins/better-workflows/scripts/lib/review.mjs" },
      records: [
        { kind: "claim-verification", id: "demo-verify-21", status: "complete", summary: "獨立 verifier 重驗 claim 與 exact anchor", binding: "reviewer · work unit · quote", digest: "sha256:demo-1c90…" },
        { kind: "finding", id: "demo-finding-P1", status: "open", summary: "反證顯示一筆 source fingerprint 不一致", binding: "stable finding id · exact blob", digest: "finding:demo-P1" }
      ]
    },
    {
      no: "05", short: "Ledger", accent: "#65d5cf", image: "assets/scene-05-ledger.webp",
      alt: "Ledger 水獺操作黃銅底片機，左側事件影格依序進入，右側推導出 ready、waiting 與 completed 的舞台地圖",
      actor: "Ledger", role: "STATE REDUCER", avatar: "assets/character-ledger.webp",
      title: "狀態不是被寫下來，而是從事件重播出來",
      dialogue: "Append-only events 經過固定 reducer，才得到 pending、ready、running、completed 或 blocked。",
      state: "ordered events → derived ready set", badge: "LEDGER REPLAY",
      fact: "expectedLedgerDigest 擋住 stale writer；unknown dependency、cycle、超 budget 或 missing evidence 都會拒絕 transition。",
      source: { label: "ledger.mjs · append-only deterministic reducer", href: "../../../plugins/better-workflows/scripts/lib/ledger.mjs" },
      records: [
        { kind: "ledger-event", id: "demo-event-014", status: "complete", summary: "evidence.attached 依序追加，舊 event 不改寫", binding: "expectedLedgerDigest · root actor", digest: "ledger:demo-0014" },
        { kind: "derived-state", id: "demo-state-05", status: "ready", summary: "Reducer 推導 verify complete、review ready", binding: "contract DAG · ordered events", digest: "state:demo-5d3a" }
      ]
    },
    {
      no: "06", short: "Review", accent: "#c3b8ff", image: "assets/scene-06-review.webp",
      alt: "Vera 用放大鏡檢查封裝底片，修復者只補一處裂縫，桌面上有五張有限修復票與最終廣角鏡",
      actor: "Vera", role: "REVIEW PACKAGE", avatar: "assets/character-vera.webp",
      title: "只修那條裂縫，然後再看整卷底片",
      dialogue: "局部 repair 有固定 budget；action token 前還要一次 final broad review。",
      state: "finding resolved → broad review complete", badge: "REVIEW FROZEN",
      fact: "Immutable review package 綁定 base、head、scope、diff、contract、template 與 sentinel。之後新增 finding 會使 broad completion 失效。",
      source: { label: "review.mjs · immutable package / bounded repair", href: "../../../plugins/better-workflows/scripts/lib/review.mjs" },
      records: [
        { kind: "review-package", id: "demo-package-31", status: "complete", summary: "Base、head、scope 與 diff manifest 已凍結", binding: "package digest · sentinel", digest: "sha256:demo-9bd2…" },
        { kind: "finding", id: "demo-finding-P1", status: "complete", summary: "同一 stable finding 已帶 evidence 解決", binding: "repair attempt · package digest", digest: "finding:demo-P1" },
        { kind: "final-broad-review", id: "demo-review-32", status: "complete", summary: "局部修復後重新檢查完整 changed surface", binding: "current head · current sentinel", digest: "sha256:demo-b204…" }
      ]
    },
    {
      no: "07", short: "Action", accent: "#f2c469", image: "assets/scene-07-gate.webp",
      alt: "Sentinel 陸龜在深谷吊橋前舉手擋下，Captain Root 出示唯一發光 token，Echo 與封閉底片罐在旁等待",
      actor: "Sentinel", role: "SIDE-EFFECT GATE", avatar: "assets/character-sentinel.webp",
      title: "橋先不放下：token 要把權限綁到這一次",
      dialogue: "Action token 綁 action、provider、resource、revision、review、evidence 與 idempotency key。",
      state: "authority checked → one attempt issued", badge: "TOKEN ISSUED",
      fact: "本頁是 sanitized teaching replay，不會真的發 token；可執行 workflow 仍須依自己的 review contract、source freshness、provider binding 與 protected authorization 申請 action。Wrapper 送出後若 outcome unknown，不能把非零退出直接當成安全失敗。",
      source: { label: "core.mjs · action issue / execute / consume", href: "../../../plugins/better-workflows/scripts/lib/core.mjs" },
      records: [
        { kind: "action-token", id: "demo-token-41", status: "issued", summary: "短效 token 綁定唯一 provider resource", binding: "action · provider · revision", digest: "token:demo-redacted" },
        { kind: "action-attempt", id: "demo-attempt-41", status: "ready", summary: "一次性 reservation 等待固定 wrapper 執行", binding: "idempotency key · execution identity", digest: "attempt:demo-0041" }
      ]
    },
    {
      no: "08", short: "Reconcile", accent: "#65d5cf", image: "assets/scene-08-reconcile.webp",
      alt: "Echo 機器人在日出檔案天文台對準遠方 provider 信標，收據捲與證據、ledger、review 一起點亮完成金庫",
      actor: "Echo", role: "RECONCILER", avatar: "assets/character-echo.webp",
      title: "對帳完成，才打開終場金庫",
      dialogue: "Provider receipt、attempt、source、evidence、ledger、review 與 terminal sentinel 全部相符，才能宣告完成。",
      state: "provider receipt matched → completed", badge: "COMPLETED",
      fact: "Completion 前後都重新 capture source，並重驗 acceptance evidence、P0/P1、side effects 與 live state。",
      source: { label: "core.mjs · reconciliation / completion decision", href: "../../../plugins/better-workflows/scripts/lib/core.mjs" },
      records: [
        { kind: "provider-reconciliation", id: "demo-receipt-51", status: "complete", summary: "Provider receipt 對回同一 action attempt", binding: "provider object · actor · revision", digest: "receipt:demo-51a0" },
        { kind: "completion-decision", id: "demo-completion-52", status: "complete", summary: "Evidence、ledger、review 與 sentinel digests 全部通過", binding: "terminal source · acceptance", digest: "decision:demo-52c8" }
      ]
    }
  ];

  const unknownEnding = {
    title: "Receipt 還沒對上，金庫保持關閉",
    dialogue: "送出不等於成功，也不等於失敗。先查 provider 真實狀態；unknown 不能盲目重送。",
    state: "provider outcome unknown → indeterminate",
    badge: "INDETERMINATE",
    fact: "Unknown attempt 必須先用 pinned provider query reconciliation。沒有 fresh absence proof 或成功 receipt，就沒有完成結局。",
    records: [
      { kind: "action-attempt", id: "demo-attempt-41", status: "indeterminate", summary: "Wrapper 已可能送出，但 terminal outcome 未知", binding: "same attempt · same execution", digest: "attempt:demo-0041" },
      { kind: "completion-decision", id: "demo-completion-52", status: "open", summary: "Completion 被 unknown side-effect outcome 阻擋", binding: "provider receipt missing", digest: "decision:not-issued" }
    ]
  };

  const root = document.documentElement;
  const replayMode = root.dataset.replayMode || "demo";
  const assetBase = root.dataset.assetBase || (replayMode === "runtime" ? "/assets/" : "assets/");
  const replaySessionHeader = "X-SBW-Replay-Session";
  const replaySessionFragment = "#sbw-replay-session=";
  const replaySessionStorageKey = "sbw:evidence-replay:session-v1";
  const replaySessionToken = (() => {
    if (replayMode !== "runtime") return null;
    let token = null;
    if (location.hash.startsWith(replaySessionFragment)) {
      token = location.hash.slice(replaySessionFragment.length);
      try {
        if (/^[A-Za-z0-9_-]{43}$/.test(token)) sessionStorage.setItem(replaySessionStorageKey, token);
        else sessionStorage.removeItem(replaySessionStorageKey);
      } catch {}
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      try {
        token = sessionStorage.getItem(replaySessionStorageKey);
      } catch {
        token = null;
      }
    }
    return /^[A-Za-z0-9_-]{43}$/.test(String(token ?? "")) ? token : null;
  })();
  const actorAvatars = {
    "Captain Root": "character-root.webp",
    "Scout Pixel": "character-pixel.webp",
    "Ledger": "character-ledger.webp",
    "Vera": "character-vera.webp",
    "Sentinel": "character-sentinel.webp",
    "Echo": "character-echo.webp"
  };
  let scenes = demoScenes;
  let liveReplay = false;
  let recordedOutcome = null;
  let elapsedMs = 0;
  let activeScene = -1;
  let playing = false;
  let lastFrame = null;
  let frameRequest = 0;
  let speed = 1;
  let ending = "verified";

  const byId = (id) => document.getElementById(id);
  const assetUrl = (value) => {
    const name = String(value || "").replace(/^assets\//, "");
    return assetBase + name;
  };
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const statusClass = (status) => [
    "open", "indeterminate", "inconclusive", "invalid", "blocked", "issued", "ready", "running", "unsealed",
    "recorded_completed", "hold", "cancelled", "legacy_recorded"
  ].includes(String(status).toLowerCase()) ? String(status).toLowerCase() : "";

  const fetchJson = async (url) => {
    const response = await fetch(url, {
      credentials: "omit",
      headers: {
        "Accept": "application/json",
        ...(replaySessionToken ? { [replaySessionHeader]: replaySessionToken } : {})
      }
    });
    const value = await response.json().catch(() => ({ ok: false, error: "REPLAY_RESPONSE_INVALID" }));
    if (!response.ok) throw new Error(value.error || "REPLAY_REQUEST_FAILED");
    return value;
  };

  const renderRuntimeError = (code) => {
    const target = byId("runtime-error");
    if (!target) return;
    const library = byId("run-library");
    const cinema = byId("cinema");
    if (library) library.hidden = true;
    if (cinema) cinema.hidden = true;
    const normalized = String(code || "REPLAY_REQUEST_FAILED");
    const message = normalized === "REPLAY_BOOTSTRAP_REJECTED"
      ? "這個單次啟動網址已過期、已使用，或不屬於目前的 replay server。"
      : normalized === "REPLAY_SESSION_REQUIRED"
        ? "此頁沒有有效的本機 replay session；收藏或直接輸入的 clean URL 不含啟動權限。"
        : "本機 replay session 無法讀取這份 sanitized 快照。";
    target.hidden = false;
    target.tabIndex = -1;
    target.replaceChildren(
      create("strong", null, "證據重播目前無法建立"),
      create("span", "runtime-error-code", "錯誤代碼 · " + normalized),
      create("p", "runtime-recovery", message),
      create("p", "runtime-recovery", "請回到啟動服務的 Terminal，按 Ctrl+C 停止，再重新執行下列指令取得新的單次啟動網址："),
      create("code", "runtime-recovery-command", "sbw evidence replay [<run-id>]")
    );
    target.focus();
  };

  const renderLibrary = (value) => {
    const library = byId("run-library");
    const list = byId("run-library-list");
    const cinema = byId("cinema");
    if (!library || !list) return;
    library.hidden = false;
    if (cinema) cinema.hidden = true;
    list.replaceChildren();
    if (!Array.isArray(value.runs) || value.runs.length === 0) {
      list.append(create(
        "p",
        "runtime-empty",
        value.stateRootPresent === false
          ? "尚未建立 Better Workflows state root；可先觀看教學劇場。"
          : "目前沒有可重播的 run。"
      ));
      return;
    }
    if (value.truncated === true) {
      list.append(create("p", "runtime-empty", "為維持讀取邊界，清單只顯示最新 200 筆；已知 run ID 仍可用固定路徑開啟。"));
    }
    for (const run of value.runs) {
      const card = create("a", "run-card");
      card.href = "/runs/" + encodeURIComponent(String(run.runId));
      const head = create("span", "run-card-head");
      head.append(
        create("strong", null, run.runId),
        create("span", "run-outcome " + statusClass(run.snapshotClass), run.snapshotClass)
      );
      const metadata = create("span", "run-card-meta");
      metadata.append(
        create("span", null, "Template · " + run.template),
        create("span", null, "Mode · " + run.mode),
        create("span", null, "Updated · " + (run.updatedAt || "unknown"))
      );
      const digest = create("code", null, run.manifestDigest ? run.manifestDigest.slice(0, 12) : (run.blockerCode || "no-manifest"));
      card.append(head, metadata, digest);
      list.append(card);
    }
  };

  const configureRuntime = async () => {
    if (replayMode !== "runtime") return true;
    if (location.pathname.startsWith("/bootstrap/")) throw new Error("REPLAY_BOOTSTRAP_REJECTED");
    if (location.pathname === "/") {
      renderLibrary(await fetchJson("/api/v1/runs"));
      return false;
    }
    if (location.pathname === "/demo") return true;
    const match = /^\/runs\/(sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/.exec(location.pathname);
    if (!match) throw new Error("REPLAY_ROUTE_NOT_FOUND");
    const value = await fetchJson("/api/v1/runs/" + encodeURIComponent(match[1]) + "/replay");
    if (!value.manifest || !Array.isArray(value.manifest.scenes) || value.manifest.scenes.length !== 8) {
      throw new Error("REPLAY_MANIFEST_INVALID");
    }
    scenes = value.manifest.scenes;
    liveReplay = true;
    recordedOutcome = value.manifest.assurance?.outcome || "INDETERMINATE";
    const library = byId("run-library");
    const cinema = byId("cinema");
    if (library) library.hidden = true;
    if (cinema) cinema.hidden = false;
    const branch = document.querySelector(".branch-control");
    if (branch) branch.hidden = true;
    document.querySelectorAll(".demo-ticket").forEach((ticket) => { ticket.textContent = "RECORDED"; });
    const context = byId("runtime-context");
    if (context) context.textContent = match[1] + " · " + recordedOutcome + " · " + value.manifestDigest.slice(0, 12);
    root.dataset.ending = recordedOutcome === "RECORDED_COMPLETED" ? "verified" : "unknown";
    return true;
  };

  const sceneAt = (index) => {
    const base = scenes[index];
    if (liveReplay || index !== scenes.length - 1 || ending !== "unknown") return base;
    return Object.assign({}, base, unknownEnding);
  };

  const recordBinding = (record) => {
    if (record.binding) return record.binding;
    return [record.producer, record.producedAt, record.stale ? "stale" : null].filter(Boolean).join(" · ") || "allowlisted metadata";
  };

  const renderRecords = (scene) => {
    const list = byId("record-list");
    list.replaceChildren();
    for (const record of scene.records || []) {
      const article = create("article", "record");
      const top = create("div", "record-top");
      top.append(
        create("span", "record-kind", record.kind),
        create("span", "record-status " + statusClass(record.status), record.status)
      );
      article.append(top, create("strong", null, record.summary || (record.kind + " · " + record.status)));
      const details = create("dl");
      for (const [label, value] of [
        ["ID", record.id],
        ["Binding", recordBinding(record)],
        ["Digest", record.digest || "not exposed"]
      ]) {
        details.append(create("dt", null, label), create("dd", null, value));
      }
      article.append(details);
      list.append(article);
    }
  };

  const renderTimeline = () => {
    const timeline = byId("timeline");
    timeline.replaceChildren();
    scenes.forEach((scene, index) => {
      const item = create("li");
      const button = create("button");
      button.type = "button";
      button.dataset.scene = String(index);
      button.setAttribute("aria-label", "跳到第 " + (index + 1) + " 幕：" + scene.short);
      button.append(create("span", "dot", scene.no), create("b", null, scene.short));
      button.addEventListener("click", () => goToScene(index, true));
      item.append(button);
      timeline.append(item);
    });
  };

  const updateTimeline = (index) => {
    byId("timeline").querySelectorAll("button").forEach((button, buttonIndex) => {
      button.classList.toggle("is-past", buttonIndex < index);
      button.classList.toggle("is-current", buttonIndex === index);
      if (buttonIndex === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  };

  const renderScene = (index, animate) => {
    const scene = sceneAt(index);
    activeScene = index;
    const stage = byId("film-stage");
    const image = byId("scene-image");
    stage.style.setProperty("--scene-accent", scene.accent);
    image.src = assetUrl(scene.image);
    image.alt = scene.alt;
    if (animate) {
      image.classList.remove("is-entering");
      void image.offsetWidth;
      image.classList.add("is-entering");
    }
    byId("scene-index").textContent = "SCENE " + scene.no + " / 08";
    byId("scene-state").textContent = scene.badge;
    byId("scene-state").dataset.terminal = String(index === scenes.length - 1);
    const avatar = byId("actor-avatar");
    avatar.src = assetUrl(scene.avatar || actorAvatars[scene.actor] || "character-root.webp");
    avatar.alt = scene.actor + " 角色肖像";
    byId("actor-name").textContent = scene.actor;
    byId("scene-role").textContent = scene.role;
    byId("scene-title").textContent = scene.title;
    byId("scene-dialogue").textContent = scene.dialogue;
    byId("scene-fact").textContent = scene.fact;
    byId("derived-state").textContent = scene.state;
    const source = byId("record-source");
    if (replayMode !== "runtime" && scene.source?.href && scene.source?.label) {
      source.hidden = false;
      source.href = scene.source.href;
      source.textContent = scene.source.label + " ↗";
    } else {
      source.hidden = true;
      source.removeAttribute("href");
      source.textContent = "";
    }
    renderRecords(scene);
    byId("raw-record").textContent = JSON.stringify({
      demo: !liveReplay,
      authoritative: false,
      presentationOnly: true,
      recordedOutcome,
      scene: scene.no,
      derivedState: scene.state,
      records: scene.records || []
    }, null, 2);
    updateTimeline(index);
  };

  const formatTime = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    return String(Math.floor(totalSeconds / 60)).padStart(2, "0") + ":" + String(totalSeconds % 60).padStart(2, "0");
  };

  const totalDuration = () => scenes.length * sceneDurationMs;
  const updateClock = () => {
    const duration = totalDuration();
    const safeElapsed = Math.min(elapsedMs, duration);
    byId("story-progress").value = String(safeElapsed / 1000);
    byId("current-time").textContent = formatTime(safeElapsed);
    byId("total-time").textContent = formatTime(duration);
    const index = Math.min(scenes.length - 1, Math.floor(Math.min(safeElapsed, duration - 1) / sceneDurationMs));
    if (index !== activeScene) renderScene(index, true);
  };

  const setPlayButton = () => {
    const button = byId("play-button");
    button.setAttribute("aria-pressed", String(playing));
    button.setAttribute("aria-label", playing ? "暫停電影" : "播放電影");
    const icon = create("span", null, playing ? "Ⅱ" : "▶");
    icon.setAttribute("aria-hidden", "true");
    button.replaceChildren(icon, document.createTextNode(playing ? " 暫停" : " 播放"));
  };

  const setPlaying = (nextPlaying) => {
    playing = nextPlaying;
    setPlayButton();
    if (playing) {
      if (elapsedMs >= totalDuration() - 10) elapsedMs = 0;
      lastFrame = null;
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frameRequest);
      lastFrame = null;
    }
  };

  const tick = (timestamp) => {
    if (!playing) return;
    if (lastFrame === null) lastFrame = timestamp;
    const delta = Math.min(100, timestamp - lastFrame);
    lastFrame = timestamp;
    elapsedMs += delta * speed;
    if (elapsedMs >= totalDuration()) {
      elapsedMs = totalDuration();
      updateClock();
      setPlaying(false);
      return;
    }
    updateClock();
    frameRequest = requestAnimationFrame(tick);
  };

  const goToScene = (index, shouldPause) => {
    if (shouldPause) setPlaying(false);
    const boundedIndex = Math.max(0, Math.min(scenes.length - 1, index));
    elapsedMs = boundedIndex * sceneDurationMs;
    renderScene(boundedIndex, true);
    updateClock();
  };

  const initializePlayer = () => {
    renderTimeline();
    byId("story-progress").max = String(totalDuration() / 1000);
    renderScene(0, false);
    updateClock();
    scenes.forEach((scene) => { const preload = new Image(); preload.src = assetUrl(scene.image); });
    byId("play-button").addEventListener("click", () => setPlaying(!playing));
    byId("previous-button").addEventListener("click", () => goToScene(activeScene - 1, true));
    byId("next-button").addEventListener("click", () => goToScene(activeScene + 1, true));
    byId("restart-button").addEventListener("click", () => { goToScene(0, true); setPlaying(true); });
    byId("story-progress").addEventListener("input", () => {
      setPlaying(false);
      elapsedMs = Number(byId("story-progress").value) * 1000;
      updateClock();
    });
    byId("speed-select").addEventListener("change", () => { speed = Number(byId("speed-select").value); });
    if (!liveReplay) {
      document.querySelectorAll(".branch-options [data-ending]").forEach((button) => {
        button.addEventListener("click", () => {
          ending = button.dataset.ending;
          root.dataset.ending = ending;
          document.querySelectorAll(".branch-options [data-ending]").forEach((peer) => {
            peer.setAttribute("aria-pressed", String(peer === button));
          });
          if (activeScene === scenes.length - 1) renderScene(activeScene, true);
        });
      });
    }
    document.querySelectorAll("[data-cast-scene]").forEach((button) => {
      button.addEventListener("click", () => {
        goToScene(Number(button.dataset.castScene), true);
        byId("cinema").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      });
    });
    document.addEventListener("keydown", (event) => {
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(document.activeElement.tagName)) return;
      if (event.code === "Space") { event.preventDefault(); setPlaying(!playing); }
      if (event.key === "ArrowLeft") goToScene(activeScene - 1, true);
      if (event.key === "ArrowRight") goToScene(activeScene + 1, true);
      if (event.key === "Home") goToScene(0, true);
      if (event.key === "End") goToScene(scenes.length - 1, true);
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden && playing) setPlaying(false); });
  };

  configureRuntime().then((showPlayer) => {
    if (showPlayer) initializePlayer();
  }).catch((error) => renderRuntimeError(error.message));
})();
