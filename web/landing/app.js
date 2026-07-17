// ---------- reveal-on-scroll ----------
(function () {
  const els = document.querySelectorAll("[data-reveal]");
  els.forEach((el) => {
    el.style.transitionDelay = (el.dataset.delay || 0) + "ms";
  });
  const show = (el) => el.classList.add("is-visible");
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }),
    { threshold: 0.12 },
  );
  els.forEach((el) => io.observe(el));
  // Fallback so content isn't stuck invisible if IO never fires (hidden tab, older browser).
  const revealAll = () => els.forEach(show);
  if (document.hidden) revealAll();
  document.addEventListener("visibilitychange", () => { if (document.hidden) revealAll(); });
  setTimeout(() => els.forEach((el) => { if (!el.classList.contains("is-visible") && el.getBoundingClientRect().top < innerHeight) show(el); }), 1200);
})();

// ---------- hero SFX parallax ----------
(function () {
  const pEls = document.querySelectorAll("[data-parallax]");
  if (!pEls.length) return;
  document.addEventListener("mousemove", (e) => {
    const nx = e.clientX / innerWidth - 0.5;
    const ny = e.clientY / innerHeight - 0.5;
    pEls.forEach((el) => {
      const d = +el.dataset.parallax || 20;
      el.style.transform = `translate(${-nx * d}px, ${-ny * d}px)`;
    });
  });
})();

// ---------- agent picker (cosmetic) ----------
(function () {
  const buttons = document.querySelectorAll(".chip-agent");
  const promptLine = document.getElementById("agentPrompt");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const agent = btn.dataset.agent;
      promptLine.innerHTML = `${agent} &#9656; lifecomic.make_comic --pages 1 --style manga<span class="caret"></span>`;
    });
  });
})();

// ---------- example chips fill the textarea ----------
(function () {
  const storyInput = document.getElementById("storyInput");
  document.querySelectorAll(".chip-example").forEach((chip) => {
    chip.addEventListener("click", () => {
      storyInput.value = chip.textContent;
      storyInput.focus();
    });
  });
})();

// ---------- demo: real call to the live free-preview API ----------
(function () {
  const storyInput = document.getElementById("storyInput");
  const generateBtn = document.getElementById("generateBtn");
  const makingBox = document.getElementById("makingBox");
  const logLinesEl = document.getElementById("logLines");
  const makingWordEl = document.getElementById("makingWord");
  const resultBox = document.getElementById("resultBox");
  const errorBox = document.getElementById("errorBox");

  const WORDS = ["INKING!!!", "PENCILING!!!", "LETTERING!!!", "KA-CHOW!!!"];
  const LOG_LINES = [
    "→ parsing your chaos into a script…",
    "→ laying out panels…",
    "→ lettering captions…",
  ];

  let logTimer = null;

  function startLogAnimation() {
    logLinesEl.innerHTML = "";
    let i = 0;
    const addLine = (text) => {
      const div = document.createElement("div");
      div.className = "log-line";
      div.textContent = text;
      logLinesEl.appendChild(div);
    };
    addLine(`$ ${document.querySelector(".chip-agent.active")?.dataset.agent || "claude-code"} ▸ call lifecomic.make_comic`);
    logTimer = setInterval(() => {
      makingWordEl.textContent = WORDS[i % WORDS.length];
      if (i < LOG_LINES.length) addLine(LOG_LINES[i]);
      i += 1;
    }, 480);
  }

  function stopLogAnimation() {
    if (logTimer) clearInterval(logTimer);
    logTimer = null;
  }

  function showResult(data) {
    const pageUrl = data.files?.pages?.[0];
    resultBox.innerHTML = `
      <div class="result-head">
        <div class="result-title">FREE PREVIEW &middot; ${escapeHtml(data.title || "Your Comic")}</div>
        <div class="result-note">real layout &middot; art renders on paid tier</div>
      </div>
      ${pageUrl ? `<div class="result-img-wrap"><img src="${pageUrl}" alt="Free preview page" style="width:100%;display:block"></div>` : ""}
      <div class="result-cta">
        <a href="https://okx.ai/agents/6103" target="_blank" rel="noopener" class="btn-render">RENDER THE FULL COMIC &middot; $0.15 &rarr;</a>
      </div>
    `;
    resultBox.hidden = false;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function generate() {
    if (generateBtn.disabled) return;
    const story = storyInput.value.trim() || "I missed my train, spilled coffee on my shirt, and still got the job.";

    resultBox.hidden = true;
    errorBox.hidden = true;
    makingBox.hidden = false;
    generateBtn.disabled = true;
    generateBtn.textContent = "DRAWING…";
    startLogAnimation();

    try {
      const res = await fetch("/mcp/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ story }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
      stopLogAnimation();
      makingBox.hidden = true;
      showResult(data);
    } catch (err) {
      stopLogAnimation();
      makingBox.hidden = true;
      showError(err instanceof Error ? err.message : "Something broke mid-panel. Try again in a moment.");
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "MAKE IT A COMIC!";
    }
  }

  generateBtn.addEventListener("click", generate);
})();
