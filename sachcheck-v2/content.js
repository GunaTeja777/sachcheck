// content.js — SachCheck v2.2

// ── State ─────────────────────────────────────────────────────────────────────
let isRunning      = false;
let checkTimer     = null;
let lastClaim      = "";
let voiceEnabled   = true;
let checkCount     = 0;
let currentVideoId = "";
let noCaptionTicks = 0; // track how long captions have been missing

const CAPTION_HISTORY_SIZE = 5;
let captionHistory  = [];
let accumulatedText = "";
let lastRequestTime = 0;
const POLL_INTERVAL = 1500;

// ── YouTube SPA navigation ────────────────────────────────────────────────────
function getVideoId() {
  return new URLSearchParams(window.location.search).get("v") || "";
}

function checkForVideoChange() {
  const vid = getVideoId();
  if (vid && vid !== currentVideoId) {
    currentVideoId = vid;
    accumulatedText = "";
    lastClaim       = "";
    captionHistory  = [];
    lastRequestTime = 0;
    noCaptionTicks  = 0;
    console.log("[SachCheck] New video, buffer reset:", vid);
  }
}

// ── Speech synthesis (waits for voices to load) ───────────────────────────────
function containsDevanagari(text) { return /[\u0900-\u097F]/.test(text); }

function speak(text) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const trySpeak = () => {
    const utter  = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    utter.rate = 0.95; utter.pitch = 1.0; utter.volume = 1.0;

    if (containsDevanagari(text)) {
      utter.lang = "hi-IN";
      const v = voices.find(v => v.lang === "hi-IN" || v.name.toLowerCase().includes("hindi"));
      if (v) utter.voice = v;
    } else {
      utter.lang = "en-IN";
      const v = voices.find(v => v.lang === "en-IN" || v.name.toLowerCase().includes("india"));
      if (v) utter.voice = v;
    }
    window.speechSynthesis.speak(utter);
  };

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener("voiceschanged", trySpeak, { once: true });
  } else {
    trySpeak();
  }
}

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
}

// ── YouTube caption scraper (updated for 2024/2025 DOM) ──────────────────────
function scrapeYouTubeCaptions() {
  const selectors = [
    ".ytp-caption-segment",
    ".caption-visual-line span",
    ".ytp-caption-window-container .ytp-caption-segment",
    "[class*='caption-segment']",
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      const text = Array.from(els).map(el => el.textContent.trim()).filter(Boolean).join(" ");
      if (text.length > 10) return text;
    }
  }
  return "";
}

// FIX: Detect if captions are enabled at all
function areCaptionsEnabled() {
  // If the caption window container exists in DOM, captions are on
  return !!(
    document.querySelector(".ytp-caption-window-container") ||
    document.querySelector(".ytp-caption-segment") ||
    document.querySelector("[class*='caption-window']")
  );
}

// ── Caption deduplication ─────────────────────────────────────────────────────
function isCaptionNew(text) {
  if (!text || text.length < 20) return false;
  const norm = text.toLowerCase().trim();
  if (captionHistory.includes(norm)) return false;
  captionHistory.push(norm);
  if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();
  return true;
}

// ── Claim detection ───────────────────────────────────────────────────────────
const CLAIM_PATTERNS = [
  /\d[\d,]*\s*(crore|lakh|thousand|million|billion|trillion|करोड़|करोड|लाख|हजार)/i,
  /\d+(\.\d+)?\s*(%|percent|per cent|प्रतिशत|फीसदी)/i,
  /(gdp|inflation|unemployment|crime|poverty|growth|जीडीपी|महंगाई|बेरोजगारी|विकास)/i,
  /(india|government|modi|rahul|bjp|congress|rbi|supreme court|भारत|सरकार|मोदी|राहुल|भाजपा)/i,
  /(pakistan|china|america|russia|bangladesh|पाकिस्तान|चीन|अमेरिका|रूस)/i,
  /(according to|data shows|report says|survey|officially|confirmed|sources say|रिपोर्ट|सर्वे|पुष्टि|दावा)/i,
  /\b(highest|lowest|first time|record|historic|fastest|largest|biggest)\b/i,
  /(सबसे ज्यादा|सबसे कम|पहली बार|रिकॉर्ड|ऐतिहासिक|सबसे बड़ा)/i,
  /\b(killed|died|arrested|convicted|sentenced|banned|approved|rejected|passed)\b/i,
  /(मौत|निधन|गिरफ्तार|सजा|प्रतिबंध|मंजूरी|खारिज|पास|पारित)/i,
];

function looksFactual(text) {
  return text.length >= 25 && CLAIM_PATTERNS.some(p => p.test(text));
}

function extractBestClaim(text) {
  const sentences = text.split(/[।.!?]+/).map(s => s.trim()).filter(s => s.length > 20);
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (looksFactual(sentences[i])) return sentences[i];
  }
  return null;
}

// ── Sidebar UI ────────────────────────────────────────────────────────────────
function injectSidebar() {
  if (document.getElementById("sc-sidebar")) return;
  const sidebar = document.createElement("div");
  sidebar.id = "sc-sidebar";
  sidebar.innerHTML = `
    <div class="sc-hdr">
      <span class="sc-logo">&#x26A1; SachCheck</span>
      <span class="sc-badge" id="sc-badge">LIVE</span>
      <button class="sc-voice-btn" id="sc-voice-btn" title="Voice ON">&#128266;</button>
      <button class="sc-close-btn" id="sc-close-btn">&#10005;</button>
    </div>
    <div class="sc-caption-strip" id="sc-caption">Listening... press <b>C</b> on YouTube to enable captions</div>
    <div class="sc-status-bar">
      <span id="sc-status-text">Waiting for factual claim...</span>
      <span id="sc-count" class="sc-count">0 checked</span>
    </div>
    <div class="sc-feed" id="sc-feed">
      <div class="sc-empty-state">Factual claims from the broadcast will appear here in real time</div>
    </div>
    <div class="sc-footer"><span>Powered by Groq AI</span></div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById("sc-close-btn").addEventListener("click", () => {
    stopFactChecking();
  });

  const voiceBtn = document.getElementById("sc-voice-btn");
  voiceBtn.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    voiceBtn.style.opacity = voiceEnabled ? "1" : "0.35";
    chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceEnabled });
    if (!voiceEnabled) window.speechSynthesis?.cancel();
  });
}

function setStatus(text) {
  const el = document.getElementById("sc-status-text");
  if (el) el.textContent = text;
}

function setCaptionPreview(text) {
  const el = document.getElementById("sc-caption");
  if (el) el.textContent = text || "Listening... press C on YouTube to enable captions";
}

function addResultCard(claim, result) {
  const feed = document.getElementById("sc-feed");
  if (!feed) return;
  feed.querySelector(".sc-empty-state")?.remove();

  checkCount++;
  const countEl = document.getElementById("sc-count");
  if (countEl) countEl.textContent = `${checkCount} checked`;

  const VERDICT_CONFIG = {
    TRUE:       { emoji: "✅", cls: "v-true",       label: "TRUE" },
    MISLEADING: { emoji: "⚠️", cls: "v-misleading", label: "MISLEADING" },
    FALSE:      { emoji: "❌", cls: "v-false",       label: "FALSE" },
    UNVERIFIED: { emoji: "🔍", cls: "v-unverified",  label: "UNVERIFIED" },
  };
  const cfg = VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.UNVERIFIED;

  const card = document.createElement("div");
  card.className = `sc-card ${cfg.cls}`;

  const top = document.createElement("div");
  top.className = "sc-card-top";
  top.innerHTML = `<span class="sc-emoji">${cfg.emoji}</span>
    <span class="sc-verdict-label">${cfg.label}</span>
    <span class="sc-conf">${result.confidence ?? 0}%</span>
    <span class="sc-time">${new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</span>`;

  const quote = document.createElement("div");
  quote.className = "sc-claim-quote";
  quote.textContent = `"${claim.slice(0,90)}${claim.length>90?"…":""}"`;

  const summary = document.createElement("div");
  summary.className = "sc-summary";
  summary.textContent = result.summary || "";

  const evidence = document.createElement("div");
  evidence.className = "sc-evidence";
  evidence.textContent = `📰 ${result.evidence || ""}`;

  card.appendChild(top);
  card.appendChild(quote);
  card.appendChild(summary);
  card.appendChild(evidence);

  if (result.source) {
    const src = document.createElement("div");
    src.className = "sc-source";
    src.textContent = `🔗 ${result.source}`;
    card.appendChild(src);
  }

  feed.insertBefore(card, feed.firstChild);
  const cards = feed.querySelectorAll(".sc-card");
  if (cards.length > 10) cards[cards.length - 1].remove();

  speak(result.speak || `${cfg.label}. ${result.summary}`);
}

// ── Main polling loop ─────────────────────────────────────────────────────────
async function pollLoop() {
  if (!isRunning) return;

  try {
    checkForVideoChange();

    const caption = scrapeYouTubeCaptions();

    if (!caption) {
      noCaptionTicks++;
      // FIX: After 10s of no captions, warn user to enable CC
      if (noCaptionTicks === 7) {
        setStatus("⚠️ No captions detected — press C on YouTube to enable CC");
        setCaptionPreview("");
      }
    } else {
      noCaptionTicks = 0;

      if (isCaptionNew(caption)) {
        accumulatedText = appendToBuffer(accumulatedText, caption);
        setCaptionPreview(accumulatedText.slice(-130));

        const claim = extractBestClaim(accumulatedText);

        if (claim && claim !== lastClaim && Date.now() - lastRequestTime > 12000) {
          lastClaim       = claim;
          lastRequestTime = Date.now();
          setStatus("🔍 Checking...");

          const apiKey = await getKey();
          if (!apiKey) { setStatus("⚠️ No API key — enter it in the panel"); return; }

          const resp = await chrome.runtime.sendMessage({ type: "FACT_CHECK", claim, apiKey });

          if (resp?.success) {
            addResultCard(claim, resp.result);
            setStatus("🟢 Live — " + new Date().toLocaleTimeString("en-IN"));
            if (accumulatedText.length > 150) accumulatedText = accumulatedText.slice(-100);
          } else {
            setStatus("⚠️ " + (resp?.error || "error"));
          }
        } else if (caption) {
          setStatus("🟢 Listening...");
        }
      }
    }

    if (accumulatedText.length > 350) accumulatedText = accumulatedText.slice(-250);

  } catch (e) {
    console.log("[SachCheck] pollLoop error:", e.message);
  } finally {
    if (isRunning) checkTimer = setTimeout(pollLoop, POLL_INTERVAL);
  }
}

function appendToBuffer(buf, newText) {
  if (!buf.trim()) return newText;
  const w1 = buf.trim().split(/\s+/);
  const w2 = newText.trim().split(/\s+/);
  let overlap = 0;
  const limit = Math.min(w1.length, w2.length, 12);
  for (let i = 1; i <= limit; i++) {
    if (w1.slice(-i).join(" ").toLowerCase() === w2.slice(0,i).join(" ").toLowerCase()) overlap = i;
  }
  const seg = w2.slice(overlap).join(" ");
  return seg ? (buf + " " + seg).trim() : buf;
}

function getKey() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_API_KEY" }, r => resolve(r?.apiKey || ""))
  );
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
function startFactChecking() {
  if (isRunning) return;
  isRunning       = true;
  accumulatedText = "";
  lastClaim       = "";
  lastRequestTime = 0;
  captionHistory  = [];
  noCaptionTicks  = 0;
  currentVideoId  = getVideoId();

  chrome.runtime.sendMessage({ type: "GET_VOICE_PREF" }, r => {
    voiceEnabled = r?.enabled !== false;
    const btn = document.getElementById("sc-voice-btn");
    if (btn) btn.style.opacity = voiceEnabled ? "1" : "0.35";
  });

  injectSidebar();
  pollLoop();
}

function stopFactChecking() {
  isRunning = false;
  clearTimeout(checkTimer);
  window.speechSynthesis?.cancel();
  document.getElementById("sc-sidebar")?.remove();
}

// ── Message bridge ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START")  { startFactChecking(); sendResponse({ success: true }); }
  if (msg.type === "STOP")   { stopFactChecking();  sendResponse({ success: true }); }
  if (msg.type === "STATUS") { sendResponse({ running: isRunning }); }
});
