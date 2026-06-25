// content.js — SachCheck v2
// Caption scraper + sidebar UI + Web Speech API for voice verdicts

// ── State ─────────────────────────────────────────────────────────────────────
let isRunning    = false;
let checkTimer   = null;
let lastClaim    = "";
let voiceEnabled = true;
let checkCount   = 0;

// Caption history and streaming buffer state
const CAPTION_HISTORY_SIZE = 5;
let captionHistory = [];
let accumulatedText = "";
let lastRequestTime = 0;
const POLL_INTERVAL = 1500; // Poll YouTube DOM every 1.5 seconds to capture all segments

// Helper to detect Devanagari (Hindi) characters
function containsDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

// ── Speech Synthesis (Web Speech API) ────────────────────────────────────────
function speak(text) {
  if (!voiceEnabled) return;
  if (!window.speechSynthesis) return;

  // Cancel any ongoing speech
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  const isHindi = containsDevanagari(text);
  
  utter.rate  = 0.95;
  utter.pitch = 1.0;
  utter.volume = 1.0;

  const voices = window.speechSynthesis.getVoices();

  if (isHindi) {
    utter.lang = "hi-IN";
    // Prefer an Indian Hindi voice if the browser has one
    const hindi = voices.find(v =>
      v.lang === "hi-IN" ||
      v.name.toLowerCase().includes("hindi") ||
      v.name.toLowerCase().includes("lekha") ||
      v.name.toLowerCase().includes("kalpana")
    );
    if (hindi) utter.voice = hindi;
  } else {
    utter.lang  = "en-IN";   // Indian English accent if available
    // Prefer an Indian English voice if the browser has one
    const indian = voices.find(v =>
      v.lang === "en-IN" ||
      v.name.toLowerCase().includes("india") ||
      v.name.toLowerCase().includes("ravi") ||
      v.name.toLowerCase().includes("veena")
    );
    if (indian) utter.voice = indian;
  }

  window.speechSynthesis.speak(utter);
}

// Load voices (Chrome loads them async)
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    window.speechSynthesis.getVoices(); // cache refresh
  });
}

// ── YouTube Caption Scraper ───────────────────────────────────────────────────
// YouTube captions appear inside the video player container
function scrapeYouTubeCaptions() {
  const selectors = [
    ".html5-video-player .ytp-caption-segment",
    ".html5-video-player .caption-visual-line span",
    ".html5-video-player .ytp-caption-window-container .ytp-caption-segment"
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

// Check if caption text is genuinely new
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
  // Numbers/Quantities
  /\d[\d,]*\s*(crore|lakh|thousand|million|billion|trillion|करोड़|करोड|लाख|हजार|मिलियन|बिलियन)/i,
  /\d+(\.\d+)?\s*(%|percent|per cent|प्रतिशत|फीसदी)/i,
  
  // Economy / Growth / Inflation
  /(gdp|inflation|unemployment|crime|poverty|literacy|growth|जीडीपी|महंगाई|बेरोजगारी|अपराध|गरीबी|विकास|साक्षरता)/i,
  
  // Politics & Government
  /(india|government|modi|rahul|bjp|congress|rbi|sebi|supreme court|भारत|सरकार|मोदी|राहुल|भाजपा|कांग्रेस|आरबीआई|सुप्रीम कोर्ट)/i,
  
  // Countries
  /(pakistan|china|america|us|russia|bangladesh|पाकिस्तान|चीन|अमेरिका|रूस|बांग्लादेश)/i,
  
  // Sources/Claims
  /(according to|data shows|report says|statistics|survey|officially|confirmed|sources say|रिपोर्ट|आंकड़े|सर्वे|पुष्टि|दावा|सूत्र)/i,
  
  // Superlatives
  /\b(highest|lowest|first time|record|historic|never before|fastest|largest|biggest)\b/i,
  /(सबसे ज्यादा|सबसे कम|पहली बार|रिकॉर्ड|ऐतिहासिक|सबसे बड़ा|सबसे तेज़|सबसे तेज)/i,
  
  // Verbs of significance
  /\b(killed|died|arrested|convicted|sentenced|banned|approved|rejected|passed)\b/i,
  /(मौत|निधन|गिरफ्तार|सजा|प्रतिबंध|मंजूरी|खारिज|पास|पारित)/i
];

function looksFactual(text) {
  if (text.length < 25) return false;
  return CLAIM_PATTERNS.some(p => p.test(text));
}

function extractBestClaim(text) {
  // Split on Hindi/English sentence boundaries
  const sentences = text.split(/[।.!?]+/).map(s => s.trim()).filter(s => s.length > 20);
  // Find the last sentence that looks like a factual claim
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
      <div class="sc-empty-state">
        Factual claims from the broadcast will appear here in real time
      </div>
    </div>

    <div class="sc-footer">
      <span>Powered by Groq AI + DDG Search</span>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Close
  document.getElementById("sc-close-btn").addEventListener("click", () => {
    stopFactChecking();
    sidebar.remove();
  });

  // Voice toggle
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
    TRUE:       { emoji: "&#9989;",  cls: "v-true",        label: "TRUE" },
    MISLEADING: { emoji: "&#9888;",  cls: "v-misleading",  label: "MISLEADING" },
    FALSE:      { emoji: "&#10060;", cls: "v-false",        label: "FALSE" },
    UNVERIFIED: { emoji: "&#128269;",cls: "v-unverified",  label: "UNVERIFIED" }
  };

  const cfg = VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.UNVERIFIED;

  const card = document.createElement("div");
  card.className = `sc-card ${cfg.cls}`;
  card.innerHTML = `
    <div class="sc-card-top">
      <span class="sc-emoji">${cfg.emoji}</span>
      <span class="sc-verdict-label">${cfg.label}</span>
      <span class="sc-conf">${result.confidence ?? 0}%</span>
      <span class="sc-time">${new Date().toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit"})}</span>
    </div>
    <div class="sc-claim-quote">"${claim.slice(0, 90)}${claim.length > 90 ? "…" : ""}"</div>
    <div class="sc-summary">${result.summary || ""}</div>
    <div class="sc-evidence">&#128240; ${result.evidence || ""}</div>
    ${result.source ? `<div class="sc-source">&#128279; ${result.source}</div>` : ""}
  `;

  feed.insertBefore(card, feed.firstChild);

  // Keep max 10 cards
  const cards = feed.querySelectorAll(".sc-card");
  if (cards.length > 10) cards[cards.length - 1].remove();

  // ── SPEAK the verdict ────────────────────────────────────────────────────
  const toSpeak = result.speak || `${cfg.label}. ${result.summary}`;
  speak(toSpeak);
}

// ── Main Polling Loop ─────────────────────────────────────────────────────────
async function pollLoop() {
  if (!isRunning) return;

  try {
    const caption = scrapeYouTubeCaptions();

    if (caption && caption.length > 5) {
      // Append the new caption text to our accumulated running buffer
      accumulatedText = appendToBuffer(accumulatedText, caption);
      
      // Update the live preview with the last 130 characters of our text buffer
      setCaptionPreview(accumulatedText);

      // Look for the best factual claim in the accumulated text
      const claim = extractBestClaim(accumulatedText);

      // Check if a new claim has been found, it's different from the last checked claim,
      // and at least 12 seconds have passed since our last Groq API request (to prevent spamming/rate limits)
      if (claim && claim !== lastClaim && (Date.now() - lastRequestTime > 12000)) {
        lastClaim = claim;
        lastRequestTime = Date.now();
        
        setStatus("🔍 Checking with Groq...");

        const apiKey = await getKey();
        if (!apiKey) {
          setStatus("⚠️ No API key set");
          return;
        }

        // Send fact-check request
        const response = await chrome.runtime.sendMessage({
          type: "FACT_CHECK",
          claim,
          apiKey
        });

        if (response && response.success) {
          addResultCard(claim, response.result);
          setStatus("🟢 Live — last checked " + new Date().toLocaleTimeString("en-IN"));
          // Trim the buffer after a successful check to keep it fresh and prevent duplicates
          if (accumulatedText.length > 150) {
            accumulatedText = accumulatedText.slice(-100);
          }
        } else {
          const errMsg = response?.error || "unknown error";
          setStatus("⚠️ Error: " + errMsg);
          console.log("[SachCheck] Fact-check API error:", errMsg);
        }
      }
    }

    // If the buffer grows too large, trim it so it stays fresh
    if (accumulatedText.length > 350) {
      accumulatedText = accumulatedText.slice(-250);
    }
  } catch (err) {
    console.log("[SachCheck] Error in pollLoop:", err.message);
  } finally {
    scheduleNext();
  }
}

function scheduleNext() {
  if (!isRunning) return;
  checkTimer = setTimeout(pollLoop, POLL_INTERVAL);
}

// Seamlessly appends new caption segments to the buffer by checking for overlapping words
function appendToBuffer(currentBuffer, newText) {
  const words1 = currentBuffer.trim().split(/\s+/);
  const words2 = newText.trim().split(/\s+/);
  
  if (words1.length === 0 || currentBuffer.trim() === "") return newText;
  
  // Find the longest overlap at the end of words1 and the start of words2
  let maxOverlap = 0;
  const checkLimit = Math.min(words1.length, words2.length, 12);
  
  for (let i = 1; i <= checkLimit; i++) {
    const tail = words1.slice(-i).join(" ").toLowerCase();
    const head = words2.slice(0, i).join(" ").toLowerCase();
    if (tail === head) {
      maxOverlap = i;
    }
  }
  
  const newSegment = words2.slice(maxOverlap).join(" ");
  if (newSegment.length > 0) {
    return (currentBuffer + " " + newSegment).trim();
  }
  return currentBuffer;
}

function getKey() {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_API_KEY" }, r => resolve(r?.apiKey || ""))
  );
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
function startFactChecking() {
  if (isRunning) return;
  isRunning = true;
  accumulatedText = "";
  lastRequestTime = 0;

  // Load voice pref
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

// ── Popup ↔ Content Bridge ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START")  { startFactChecking(); sendResponse({ success: true }); }
  if (msg.type === "STOP")   { stopFactChecking();  sendResponse({ success: true }); }
  if (msg.type === "STATUS") { sendResponse({ running: isRunning }); }
});
