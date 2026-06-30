/* =========================================================================
 * 数学グラフバトル！  --  シングルプレイ プロトタイプ
 *
 * ゲームの仕組み
 *  - プレイヤー（砲台）はワールド平面の原点(0,0)に固定で置かれる。
 *  - プレイヤーの位置が関数の原点(0,0)、ローカルx軸はワールドx軸と一致（回転なし）。
 *  - 入力した y=f(x) のグラフを、原点から左右両方向へ伸ばす。
 *  - 平面上の的（ターゲット）を曲線が貫けばヒット。全部貫けばクリア。
 *
 * NOTE: ランダムな配置・向きの回転は将来の拡張余地。現状は原点固定・回転なし。
 *
 * 後でマルチプレイ（WebSocket）に拡張できるよう、ゲーム状態は state に集約。
 * ======================================================================= */

(() => {
  'use strict';

  // ----- 定数 -----
  const VIEW_RADIUS = 28;     // 画面中心から見えるワールド半径（おおよそ）
  const PLAY_RANGE = 24;      // 的を置く範囲 [-PLAY_RANGE, PLAY_RANGE]
  const CURVE_LEN = 40;       // 曲線をローカルxの 0..CURVE_LEN まで前方に伸ばす
  const CURVE_SAMPLES = 1400; // 曲線のサンプリング数
  const MIN_DIST = 3.5;       // プレイヤーと的の最低距離
  const FIRE_DURATION = 700;  // 発射アニメの長さ(ms)

  // ----- DOM -----
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const exprInput = document.getElementById('expr');
  const fireBtn = document.getElementById('fire');
  const nextBtn = document.getElementById('next');
  const errBox = document.getElementById('err');
  const messageEl = document.getElementById('message');
  const hud = {
    stage: document.getElementById('hud-stage'),
    hit: document.getElementById('hud-hit'),
    total: document.getElementById('hud-total'),
    shots: document.getElementById('hud-shots'),
    score: document.getElementById('hud-score'),
  };

  // ----- ゲーム状態 -----
  const state = {
    stage: 1,
    score: 0,
    shots: 0,
    player: { x: 0, y: 0 },
    targets: [],            // { x, y, r, hit }
    compiled: null,         // mathjs compile 結果
    exprValid: false,
    firing: false,          // 発射アニメ中か
    fireStart: 0,           // 発射開始時刻
    cleared: false,         // ステージクリア済みか
  };

  // 描画用ビュー（resize で更新）
  // halfW / halfH : 画面に見えているワールド半幅・半高（単位）
  const view = { cx: 0, cy: 0, scale: 1, halfW: VIEW_RADIUS, halfH: VIEW_RADIUS };

  // ===== 座標変換 ===========================================================
  function worldToScreen(wx, wy) {
    return {
      x: view.cx + wx * view.scale,
      y: view.cy - wy * view.scale,
    };
  }

  // ローカル座標(x, f(x)) → ワールド座標
  // 座標軸は固定（上=y正, 右=x正）。プレイヤー位置を原点として平行移動するだけ。
  function localToWorld(lx, ly) {
    return {
      x: state.player.x + lx,
      y: state.player.y + ly,
    };
  }

  // ===== キャンバスのサイズ調整 =============================================
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    view.cx = w / 2;
    view.cy = h / 2;
    // 短辺を基準にスケールを決め、長辺は広く使う（横長なら横に広い平面）
    view.scale = Math.min(w, h) / (2 * VIEW_RADIUS);
    view.halfW = (w / 2) / view.scale;
    view.halfH = (h / 2) / view.scale;
  }

  // ===== ステージ生成 =======================================================
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function newStage() {
    state.cleared = false;
    state.firing = false;

    // プレイヤーは原点(0,0)に固定（関数の原点と一致）
    state.player.x = 0;
    state.player.y = 0;

    // 的の数：ステージが進むほど増える（最大4個）
    const count = Math.min(1 + Math.floor((state.stage - 1) / 2), 4);
    state.targets = [];
    let guard = 0;
    while (state.targets.length < count && guard < 500) {
      guard++;
      const t = {
        x: rand(-PLAY_RANGE, PLAY_RANGE),
        y: rand(-PLAY_RANGE, PLAY_RANGE),
        r: rand(0.45, 0.7),
        hit: false,
      };
      // プレイヤーから一定距離離す
      if (Math.hypot(t.x - state.player.x, t.y - state.player.y) < MIN_DIST) continue;
      // 他の的と近すぎない
      const tooClose = state.targets.some(
        (o) => Math.hypot(t.x - o.x, t.y - o.y) < 2.0
      );
      if (tooClose) continue;
      state.targets.push(t);
    }

    nextBtn.classList.add('hidden');
    fireBtn.classList.remove('hidden');
    fireBtn.disabled = !state.exprValid;
    hideMessage();
    updateHud();
  }

  // ===== 数式の解釈 =========================================================
  function parseExpr(raw) {
    let s = (raw || '').trim();
    if (!s) return { ok: false, error: '' };
    // 先頭の "y=" を許容して取り除く
    s = s.replace(/^\s*y\s*=\s*/i, '');
    if (!s) return { ok: false, error: '' };
    try {
      const node = math.parse(s);
      const code = node.compile();
      // 試し評価（x に値を入れて数値が返るか確認）
      const test = code.evaluate({ x: 1 });
      if (typeof test !== 'number') {
        return { ok: false, error: 'xの関数を入力してね（例: x^2）' };
      }
      return { ok: true, code };
    } catch (e) {
      return { ok: false, error: '式が読めないよ…' };
    }
  }

  // 全角英数記号・全角スペースを半角へ変換（IMEや履歴サジェストで全角が入っても矯正）
  function toHalfWidth(s) {
    return s
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/　/g, ' ');
  }

  // 入力値を半角に矯正（長さは1:1で変わらないのでカーソル位置はそのまま維持）
  function enforceHalfWidth() {
    const half = toHalfWidth(exprInput.value);
    if (half !== exprInput.value) {
      const pos = exprInput.selectionStart;
      exprInput.value = half;
      try { exprInput.setSelectionRange(pos, pos); } catch (e) {}
    }
  }

  function onInput() {
    enforceHalfWidth();
    const res = parseExpr(exprInput.value);
    state.exprValid = res.ok;
    state.compiled = res.ok ? res.code : null;
    curveCache = null; // 式が変わったので曲線キャッシュを破棄
    if (res.ok || !exprInput.value.trim()) {
      hideError();
    } else {
      showError(res.error);
    }
    if (!state.firing && !state.cleared) {
      fireBtn.disabled = !state.exprValid;
    }
  }

  // f(x) を安全に評価。失敗時は NaN
  function evalF(x) {
    if (!state.compiled) return NaN;
    try {
      const y = state.compiled.evaluate({ x });
      return typeof y === 'number' ? y : NaN;
    } catch {
      return NaN;
    }
  }

  // ===== 曲線サンプリング ===================================================
  // 式が変わったときだけ全長 -CURVE_LEN..CURVE_LEN を評価してキャッシュする。
  // 左右合計でおよそ CURVE_SAMPLES 点（刻みは全長 2*CURVE_LEN を CURVE_SAMPLES 等分）。
  // 重い mathjs 評価をフレーム毎に走らせないための最適化。
  // キャッシュ要素: { lx, ly }（ly が非有限なら ly=null で不連続点を表す）。
  let curveCache = null;
  function buildCurveCache() {
    const cache = [];
    const step = (2 * CURVE_LEN) / CURVE_SAMPLES;
    for (let lx = -CURVE_LEN; lx <= CURVE_LEN + 1e-9; lx += step) {
      const ly = evalF(lx);
      cache.push({ lx, ly: isFinite(ly) ? ly : null });
    }
    return cache;
  }

  // キャッシュから |lx| <= maxLen の範囲をワールド座標の配列にする。
  // localToWorld は加算のみで軽いので描画時に毎回変換してよい。
  function sampleCurve(maxLen) {
    if (!state.exprValid) return [];
    if (!curveCache) curveCache = buildCurveCache();
    const pts = [];
    for (const c of curveCache) {
      if (Math.abs(c.lx) > maxLen + 1e-9) continue;
      pts.push(c.ly === null ? null : localToWorld(c.lx, c.ly)); // 不連続点で線を切る
    }
    return pts;
  }

  // ===== 当たり判定 =========================================================
  // 線分 (a→b) と 円(center, r) が交差するか
  function segmentHitsCircle(a, b, cx, cy, r) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((cx - a.x) * dx + (cy - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    return Math.hypot(px - cx, py - cy) <= r;
  }

  // 曲線（点配列）が各ターゲットに当たっているか判定し hit を更新
  function checkHits(pts) {
    for (const t of state.targets) {
      if (t.hit) continue;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (!a || !b) continue;
        if (segmentHitsCircle(a, b, t.x, t.y, t.r)) {
          t.hit = true;
          break;
        }
      }
    }
  }

  // ===== 発射 ===============================================================
  function fire() {
    if (!state.exprValid || state.firing || state.cleared) return;
    state.firing = true;
    state.fireStart = performance.now();
    state.shots++;
    fireBtn.disabled = true;
    updateHud();
  }

  function finishFire() {
    state.firing = false;
    const allHit = state.targets.length > 0 && state.targets.every((t) => t.hit);
    if (allHit) {
      stageClear();
    } else {
      // まだ撃てる
      fireBtn.disabled = !state.exprValid;
      const someHit = state.targets.some((t) => t.hit);
      if (someHit) {
        flashMessage('ナイス！残りを狙え', 900, 'var(--player)');
      }
    }
  }

  function stageClear() {
    state.cleared = true;
    // スコア：的の数 × 100、少ない発射数ほどボーナス
    const base = state.targets.length * 100;
    const bonus = Math.max(0, 100 - (state.shots - 1) * 20);
    state.score += base + bonus;
    updateHud();
    fireBtn.disabled = true;
    fireBtn.classList.add('hidden');
    nextBtn.classList.remove('hidden');
    showMessage('STAGE CLEAR', `+${base + bonus} pts`);
  }

  function goNextStage() {
    state.stage++;
    state.shots = 0;
    // 入力した関数をリセット
    exprInput.value = '';
    newStage();
    onInput();
    exprInput.focus();
  }

  // ===== HUD / メッセージ ===================================================
  function updateHud() {
    hud.stage.textContent = state.stage;
    hud.hit.textContent = state.targets.filter((t) => t.hit).length;
    hud.total.textContent = state.targets.length;
    hud.shots.textContent = state.shots;
    hud.score.textContent = state.score;
  }

  let msgTimer = null;
  function showMessage(main, sub) {
    messageEl.innerHTML = sub ? `${main}<span class="sub">${sub}</span>` : main;
    messageEl.style.color = 'var(--accent)';
    messageEl.classList.remove('hidden');
  }
  function flashMessage(text, ms, color) {
    clearTimeout(msgTimer);
    messageEl.innerHTML = text;
    messageEl.style.color = color || 'var(--accent)';
    messageEl.classList.remove('hidden');
    msgTimer = setTimeout(() => {
      if (!state.cleared) messageEl.classList.add('hidden');
    }, ms);
  }
  function hideMessage() {
    clearTimeout(msgTimer);
    messageEl.classList.add('hidden');
  }
  function showError(msg) {
    if (!msg) return hideError();
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
  function hideError() {
    errBox.classList.add('hidden');
  }

  // ===== 描画 ===============================================================
  function drawGrid() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getCSS('--bg');
    ctx.fillRect(0, 0, w, h);

    // 方眼（画面に見えている範囲いっぱいに描く）
    const loX = Math.floor(-view.halfW) - 1;
    const hiX = Math.ceil(view.halfW) + 1;
    const loY = Math.floor(-view.halfH) - 1;
    const hiY = Math.ceil(view.halfH) + 1;
    ctx.lineWidth = 1;
    // 縦線
    for (let i = loX; i <= hiX; i++) {
      const isAxis = i === 0;
      const major = i % 5 === 0;
      ctx.strokeStyle = isAxis
        ? getCSS('--axis')
        : major
        ? getCSS('--grid-strong')
        : getCSS('--grid');
      const v1 = worldToScreen(i, loY);
      const v2 = worldToScreen(i, hiY);
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.lineTo(v2.x, v2.y);
      ctx.stroke();
    }
    // 横線
    for (let i = loY; i <= hiY; i++) {
      const isAxis = i === 0;
      const major = i % 5 === 0;
      ctx.strokeStyle = isAxis
        ? getCSS('--axis')
        : major
        ? getCSS('--grid-strong')
        : getCSS('--grid');
      const h1 = worldToScreen(loX, i);
      const h2 = worldToScreen(hiX, i);
      ctx.beginPath();
      ctx.moveTo(h1.x, h1.y);
      ctx.lineTo(h2.x, h2.y);
      ctx.stroke();
    }
  }

  function drawTargets() {
    for (const t of state.targets) {
      const p = worldToScreen(t.x, t.y);
      const r = t.r * view.scale;
      const color = t.hit ? getCSS('--target-hit') : getCSS('--target');

      // 外周グロー
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, t.hit ? 0.28 : 0.18);
      ctx.fill();

      // リング
      ctx.lineWidth = t.hit ? 3 : 2.5;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();

      // 中心
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, r * 0.18), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (t.hit) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x - r * 0.4, p.y);
        ctx.lineTo(p.x - r * 0.1, p.y + r * 0.35);
        ctx.lineTo(p.x + r * 0.45, p.y - r * 0.35);
        ctx.stroke();
      }
    }
  }

  function drawPlayer() {
    const p = worldToScreen(state.player.x, state.player.y);

    // プレイヤー位置が関数の原点であることを示すローカル軸（短い十字）
    const axisLen = 1.2 * view.scale;
    ctx.strokeStyle = hexA(getCSS('--player'), 0.45);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(p.x - axisLen, p.y);
    ctx.lineTo(p.x + axisLen, p.y);
    ctx.moveTo(p.x, p.y - axisLen);
    ctx.lineTo(p.x, p.y + axisLen);
    ctx.stroke();
    ctx.setLineDash([]);

    // 本体
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.4 * view.scale, 0, Math.PI * 2);
    ctx.fillStyle = getCSS('--player');
    ctx.fill();
    ctx.strokeStyle = getCSS('--bg');
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawCurve() {
    if (!state.exprValid) return;

    // 発射中は先端を伸ばす、それ以外は全長を薄くプレビュー
    let maxLen = CURVE_LEN;
    let firing = state.firing;
    if (firing) {
      const elapsed = performance.now() - state.fireStart;
      const prog = Math.min(1, elapsed / FIRE_DURATION);
      maxLen = CURVE_LEN * prog;
    }

    const pts = sampleCurve(maxLen);

    // 発射が進んだぶんの当たり判定
    if (firing) checkHits(pts);

    // ライン描画（不連続で切る）
    ctx.lineWidth = firing || state.cleared ? 4 : 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = firing || state.cleared ? getCSS('--accent') : hexA(getCSS('--accent'), 0.35);
    if (firing || state.cleared) {
      ctx.shadowColor = getCSS('--accent');
      ctx.shadowBlur = 12;
    }

    ctx.beginPath();
    let pen = false;
    for (const pt of pts) {
      if (!pt) { pen = false; continue; }
      const s = worldToScreen(pt.x, pt.y);
      if (!pen) { ctx.moveTo(s.x, s.y); pen = true; }
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 発射中の先端（左右両方向に伸びるので両端に表示）
    if (firing) {
      const drawHead = (pt) => {
        if (!pt) return;
        const s = worldToScreen(pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      };
      for (let i = pts.length - 1; i >= 0; i--) { if (pts[i]) { drawHead(pts[i]); break; } }
      for (let i = 0; i < pts.length; i++) { if (pts[i]) { drawHead(pts[i]); break; } }
    }

    // 発射完了
    if (firing && performance.now() - state.fireStart >= FIRE_DURATION) {
      finishFire();
    }
  }

  function frame() {
    drawGrid();
    drawCurve();
    drawTargets();
    drawPlayer();
    if (state.firing) updateHud();
    requestAnimationFrame(frame);
  }

  // ===== 補助：CSS変数取得 / 色アルファ =====================================
  const cssCache = {};
  function getCSS(name) {
    if (cssCache[name]) return cssCache[name];
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cssCache[name] = v;
    return v;
  }
  // #rrggbb + alpha → rgba()
  function hexA(hex, a) {
    const m = hex.replace('#', '');
    const r = parseInt(m.substring(0, 2), 16);
    const g = parseInt(m.substring(2, 4), 16);
    const b = parseInt(m.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // ===== イベント ===========================================================
  exprInput.addEventListener('input', onInput);

  // IME確定後にも半角矯正（ひらがな・全角で確定された場合の保険）
  exprInput.addEventListener('compositionend', onInput);

  // カーソル位置に文字列を挿入し、相対オフセットへカーソルを移動
  function insertAtCursor(text, cursorOffset) {
    const start = exprInput.selectionStart;
    const end = exprInput.selectionEnd;
    const v = exprInput.value;
    exprInput.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + cursorOffset;
    exprInput.setSelectionRange(pos, pos);
    onInput();
  }

  // 括弧の自動補完。開き括弧を打つと閉じ括弧も入り、カーソルは括弧の中へ移動。
  exprInput.addEventListener('keydown', (e) => {
    // 開き括弧（半角・全角どちらを打っても半角ペアを挿入）
    if (e.key === '(' || e.key === '（') {
      e.preventDefault();
      insertAtCursor('()', 1); // カーソルを () の中へ
      return;
    }
    // 閉じ括弧：直後がすでに ) なら重ねずカーソルを進めるだけ
    if (e.key === ')' || e.key === '）') {
      const start = exprInput.selectionStart;
      const end = exprInput.selectionEnd;
      if (start === end && exprInput.value[start] === ')') {
        e.preventDefault();
        exprInput.setSelectionRange(start + 1, start + 1);
      }
    }
  });

  document.getElementById('input-bar').addEventListener('submit', (e) => {
    e.preventDefault();
    fire();
  });

  nextBtn.addEventListener('click', goNextStage);

  window.addEventListener('resize', resize);

  // ===== 起動 ===============================================================
  resize();
  newStage();
  onInput();
  requestAnimationFrame(frame);
})();
