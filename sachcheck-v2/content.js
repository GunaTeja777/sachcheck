// content.js — SachCheck v2.1 (fixed)

// ── State ─────────────────────────────────────────────────────────────────────
let isRunning      = false;
let checkTimer     = null;
let lastClaim      = "";
let voiceEnabled   = true;
let checkCount     = 0;
let currentVideoId = "";

const CAPTION_HISTORY_SIZE = 5;
let captionHistory  = [];
let accumulatedText = "";
let lastRequestTime = 0;
const POLL_INTERVAL = 1500;

// ── YouTube SPA Navigation Detection ─────────────────────────────────────────
// YouTube is a Single Page App — detect video changes and reset state
function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v") || "";
}

function checkForVideoChange() {
  const vid = getVideoId();
  if (vid && vid !== currentVideoId) {
    currentVideoId = vid;
    console.log("[SachCheck] New video detected, resetting buffer:", vid);
    accumulatedText = "";
    lastClaim       = "";
    captionHistory  = [];
    lastRequestTime = 0;
  }
}

// ── Devanagari Detection ──────────────────────────────────────────────────────
function containsDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

// ── Speech Synthesis ──────────────────────────────────────────────────────────
function speak(text) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const trySpeak = () => {
    const utter   = new SpeechSynthesisUtterance(text);
    const voices  = window.speechSynthesis.getVoices();
    const isHindi = containsDevanagari(text);

    utter.rate   = 0.95;
    utter.pitch  = 1.0;
    utter.volume = 1.0;

    if (isHindi) {
      utter.lang = "hi-IN";
      const hindi = voices.find(v =>
        v.lang === "hi-IN" ||
        v.name.toLowerCase().includes("hindi") ||
        v.name.toLowerCase().includes("lekha") ||
        v.name.toLowerCase().includes("kalpana")
      );
      if (hindi) utter.voice = hindi;
    } else {
      utter.lang = "en-IN";
      const indian = voices.find(v =>
        v.lang === "en-IN" ||
        v.name.toLowerCase().includes("india") ||
        v.name.toLowerCase().includes("ravi") ||
        v.name.toLowerCase().includes("veena")
      );
      if (indian) utter.voice = indian;
    }
    window.speechSynthesis.speak(utter);
  };

  // FIX: wait for voices to load if not ready yet
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener("voiceschanged", trySpeak, { once: true });
  } else {
    trySpeak();
  }
}

// Pre-load voices
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}

// ── YouTube Caption Scraper (updated selectors for 2024/2025 YouTube DOM) ─────
function scrapeYouTubeCaptions() {
  // FIX: Updated selectors — YouTube changed their DOM structure.
  // Removed the broken '.html5-video-player' prefix which no longer wraps captions.
  const selectors = [
    ".ytp-caption-segment",                                      // primary (works 2024+)
    ".caption-visual-line span",                                 // fallback
    ".ytp-caption-window-container .ytp-caption-segment",        // explicit container path
    "[class*='caption-segment']",                                // wildcard fallback
  ];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      const text = Array.from(els)
        .map(el => el.textContent.trim())
        .filter(Boolean)
        .join(" ");
      if (text.length > 10) return text;
    }
  }
  return "";
}

// ── Caption Deduplication ─────────────────────────────────────────────────────
function isCaptionNew(text) {
  if (!text || text.length < 20) return false;
  const normalized = text.toLowerCase().trim();
  if (captionHistory.includes(normalized)) return false;
  captionHistory.push(normalized);
  if (captionHistory.length > CAPTION_HISTORY_SIZE) captionHistory.shift();
  return true;
}

// ── Claim Detection ───────────────────────────────────────────────────────────
const CLAIM_PATTERNS = [
  /\d[\d,]*\s*(crore|lakh|thousand|million|billion|trillion|करोड़|करोड|लाख|हजार|मिलियन|बिलियन)/i,
  /\d+(\.\d+)?\s*(%|percent|per cent|प्रतिशत|फीसदी)/i,
  /(gdp|inflation|unemployment|crime|poverty|literacy|growth|जीडीपी|महंगाई|बेरोजगारी|अपराध|गरीबी|विकास|साक्षरता)/i,
  /(india|government|modi|rahul|bjp|congress|rbi|sebi|supreme court|भारत|सरकार|मोदी|राहुल|भाजपा|कांग्रेस|आरबीआई|सुप्रीम कोर्ट)/i,
  /(pakistan|china|america|us|russia|bangladesh|पाकिस्तान|चीन|अमेरिका|रूस|बांग्लादेश)/i,
  /(according to|data shows|report says|statistics|survey|officially|confirmed|sources say|रिपोर्ट|आंकड़े|सर्वे|पुष्टि|दावा|सूत्र)/i,
  /\b(highest|lowest|first time|record|historic|never before|fastest|largest|biggest)\b/i,
  /(सबसे ज्यादा|सबसे कम|पहली बार|रिकॉर्ड|ऐतिहासिक|सबसे बड़ा|सबसे तेज़|सबसे तेज)/i,
  /\b(killed|died|arrested|convicted|sentenced|banned|approved|rejected|passed)\b/i,
  /(मौत|निधन|गिरफ्तार|सजा|प्रतिबंध|मंजूरी|खारिज|पास|पारित)/i
];

function looksFactual(text) {
  if (text.length < 25) return false;
  return CLAIM_PATTERNS.some(p => p.test(text));
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
      <button class="sc-voice-btn" id="sc-voice-btn" title="Toggle voice">&#128266;</button>
      <button class="sc-close-btn" id="sc-close-btn" title="Close">&#10005;</button>
    </div>
    <div class="sc-caption-strip" id="sc-caption">Listening for captions... (press C on YouTube)</div>
    <div class="sc-status-bar" id="sc-status-bar">
      <span id="sc-status-text">Waiting for factual claim...</span>
      <span id="sc-count" class="sc-count">0 checked</span>
    </div>
    <div class="sc-feed" id="sc-feed">
      <div class="sc-empty-state">Factual claims from the broadcast will appear here in real time</div>
    </div>
    <div class="sc-footer"><span>Powered by Groq AI + DDG Search</span></div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById("sc-close-btn").addEventListener("click", () => {
    stopFactChecking();
    sidebar.remove();
  });

  const voiceBtn = document.getElementById("sc-voice-btn");
  voiceBtn.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    voiceBtn.style.opacity = voiceEnabled ? "1" : "0.35";
    voiceBtn.title = voiceEnabled ? "Voice ON — click to mute" : "Voice OFF — click to enable";
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
  if (el) el.textContent = text.slice(-130) || "Listening... (press C to enable captions on YouTube)";
}

function addResultCard(claim, result) {
  const feed = document.getElementById("sc-feed");
  if (!feed) return;

  feed.querySelector(".sc-empty-state")?.remove();
  checkCount++;
  const countEl = document.getElementById("sc-count");
  if (countEl) countEl.textContent = `${checkCount} checked`;

  const VERDICT_CONFIG = {
    TRUE:       { emoji: "&#9989;",   cls: "v-true",       label: "TRUE" },
    MISLEADING: { emoji: "&#9888;",   cls: "v-misleading", label: "MISLEADING" },
    FALSE:      { emoji: "&#10060;",  cls: "v-false",      label: "FALSE" },
    UNVERIFIED: { emoji: "&#128269;", cls: "v-unverified", label: "UNVERIFIED" }
  };

  const cfg = VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.UNVERIFIED;

  const card = document.createElement("div");
  card.className = `sc-card ${cfg.cls}`;

  // FIX: use textContent for AI-returned strings to prevent XSS
  const topDiv = document.createElement("div");
  topDiv.className = "sc-card-top";
  topDiv.innerHTML = `
    <span class="sc-emoji">${cfg.emoji}</span>
    <span class="sc-verdict-label">${cfg.label}</span>
    <span class="sc-conf">${result.confidence ?? 0}%</span>
    <span class="sc-time">${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
  `;

  const quoteDiv = document.createElement("div");
  quoteDiv.className = "sc-claim-quote";
  quoteDiv.textContent = `"${claim.slice(0, 90)}${claim.length > 90 ? "…" : ""}"`;

  const summaryDiv = document.createElement("div");
  summaryDiv.className = "sc-summary";
  summaryDiv.textContent = result.summary || "";

  const evidenceDiv = document.createElement("div");
  evidenceDiv.className = "sc-evidence";
  evidenceDiv.textContent = `📰 ${result.evidence || ""}`;

  card.appendChild(topDiv);
  card.appendChild(quoteDiv);
  card.appendChild(summaryDiv);
  card.appendChild(evidenceDiv);

  if (result.source) {
    const sourceDiv = document.createElement("div");
    sourceDiv.className = "sc-source";
    sourceDiv.textContent = `🔗 ${result.source}`;
    card.appendChild(sourceDiv);
  }

  feed.insertBefore(card, feed.firstChild);

  const cards = feed.querySelectorAll(".sc-card");
  if (cards.length > 10) cards[cards.length - 1].remove();

  const toSpeak = result.speak || `${cfg.label}. ${result.summary}`;
  speak(toSpeak);
}

// ── Main Polling Loop ─────────────────────────────────────────────────────────
async function pollLoop() {
  if (!isRunning) return;

  try {
    // FIX: Detect YouTube SPA video navigation
    checkForVideoChange();

    const caption = scrapeYouTubeCaptions();

    // FIX: use isCaptionNew() return value to avoid duplicate buffer appends
    if (caption && caption.length > 5 && isCaptionNew(caption)) {
      accumulatedText = appendToBuffer(accumulatedText, caption);
      setCaptionPreview(accumulatedText);

      const claim = extractBestClaim(accumulatedText);

      if (claim && claim !== lastClaim && (Date.now() - lastRequestTime > 12000)) {
        lastClaim       = claim;
        lastRequestTime = Date.now();

        setStatus("🔍 Checking with Groq...");

        const apiKey = await getKey();
        if (!apiKey) {
          setStatus("⚠️ No API key — enter it in the SachCheck panel");
          return;
        }

        const response = await chrome.runtime.sendMessage({
          type: "FACT_CHECK",
          claim,
          apiKey
        });

        if (response && response.success) {
          addResultCard(claim, response.result);
          setStatus("🟢 Live — last checked " + new Date().toLocaleTimeString("en-IN"));
          if (accumulatedText.length > 150) {
            accumulatedText = accumulatedText.slice(-100);
          }
        } else {
          const errMsg = response?.error || "unknown error";
          setStatus("⚠️ Error: " + errMsg);
          console.log("[SachCheck] Fact-check error:", errMsg);
        }
      }
    } else if (caption && caption.length > 5) {
      // Caption exists but not new — still update the preview
      setCaptionPreview(accumulatedText || caption);
    }

    if (accumulatedText.length > 350) {
      accumulatedText = accumulatedText.slice(-250);
    }
  } catch (err) {
    console.log("[SachCheck] pollLoop error:", err.message);
  } finally {
    scheduleNext();
  }
}

function scheduleNext() {
  if (!isRunning) return;
  checkTimer = setTimeout(pollLoop, POLL_INTERVAL);
}

function appendToBuffer(currentBuffer, newText) {
  const words1 = currentBuffer.trim().split(/\s+/);
  const words2 = newText.trim().split(/\s+/);
  if (!currentBuffer.trim()) return newText;

  let maxOverlap = 0;
  const checkLimit = Math.min(words1.length, words2.length, 12);
  for (let i = 1; i <= checkLimit; i++) {
    const tail = words1.slice(-i).join(" ").toLowerCase();
    const head = words2.slice(0, i).join(" ").toLowerCase();
    if (tail === head) maxOverlap = i;
  }
  const newSegment = words2.slice(maxOverlap).join(" ");
  return newSegment.length > 0 ? (currentBuffer + " " + newSegment).trim() : currentBuffer;
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
  const sidebar = document.getElementById("sc-sidebar");
  if (sidebar) sidebar.remove();
}

// ── Message Bridge ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START")  { startFactChecking(); sendResponse({ success: true }); }
  if (msg.type === "STOP")   { stopFactChecking();  sendResponse({ success: true }); }
  if (msg.type === "STATUS") { sendResponse({ running: isRunning }); }
});
