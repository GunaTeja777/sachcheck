// popup.js — SachCheck v2.2

chrome.runtime.connect({ name: "sidepanel" });

const mainBtn     = document.getElementById("main-btn");
const apiKeyInput = document.getElementById("api-key");
const saveBtn     = document.getElementById("save-btn");
const savedMsg    = document.getElementById("saved-msg");
const voiceToggle = document.getElementById("voice-toggle");
const channelRow  = document.getElementById("channel-row");
const dotEl       = document.getElementById("dot");
const channelText = document.getElementById("channel-text");

let isRunning   = false;
let voiceOn     = true;
let activeTabId = null;

const INDIAN_CHANNELS = [
  { name: "Republic TV",     keys: ["republic"] },
  { name: "Zee News",        keys: ["zee news","zeenews"] },
  { name: "NDTV",            keys: ["ndtv"] },
  { name: "Times Now",       keys: ["times now","timesnow"] },
  { name: "Aaj Tak",         keys: ["aaj tak"] },
  { name: "India Today",     keys: ["india today"] },
  { name: "News18",          keys: ["news18"] },
  { name: "WION",            keys: ["wion"] },
  { name: "ABP News",        keys: ["abp news","abplive"] },
  { name: "DD News",         keys: ["dd news","doordarshan"] },
  { name: "TV9 Bharatvarsh", keys: ["tv9 bharat"] },
  { name: "Mirror Now",      keys: ["mirror now"] },
];

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.sync.get("groqKey",     d => { if (d.groqKey) apiKeyInput.value = d.groqKey; });
chrome.storage.sync.get("voiceEnabled", d => {
  voiceOn = d.voiceEnabled !== false;
  voiceToggle.className = "toggle" + (voiceOn ? " on" : "");
});

// ── FIX: Get the YouTube tab properly from a side panel ───────────────────────
// Side panels are NOT bound to a tab, so chrome.tabs.query({active,currentWindow})
// can return the wrong tab. We query ALL tabs and find the YouTube one.
function getYouTubeTab(cb) {
  chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
    // Prefer the tab that was most recently active
    if (tabs.length === 0) { cb(null); return; }
    // Sort by lastAccessed if available, otherwise take first
    const sorted = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    cb(sorted[0]);
  });
}

function updateUI() {
  getYouTubeTab((tab) => {
    if (!tab) {
      channelRow.classList.remove("detected");
      dotEl.classList.remove("active");
      channelText.textContent = "Open a YouTube Live stream to begin";
      setStartUI();
      isRunning = false;
      activeTabId = null;
      return;
    }

    activeTabId = tab.id;
    const title = (tab.title || "").toLowerCase();
    const found = INDIAN_CHANNELS.find(ch => ch.keys.some(k => title.includes(k)));

    if (found) {
      channelRow.classList.add("detected");
      dotEl.classList.add("active");
      channelText.textContent = found.name + " detected ✓";
    } else {
      channelRow.classList.remove("detected");
      dotEl.classList.remove("active");
      channelText.textContent = "YouTube open — find an Indian news Live stream";
    }

    chrome.tabs.sendMessage(tab.id, { type: "STATUS" }, (res) => {
      if (chrome.runtime.lastError) {
        isRunning = false;
        setStartUI();
        return;
      }
      isRunning = res?.running === true;
      isRunning ? setStopUI() : setStartUI();
    });
  });
}

updateUI();

// FIX: Only poll when panel is open — poll less aggressively (3s)
// and skip entirely when no YouTube tab
let pollTimer = setInterval(updateUI, 3000);

// ── Events ────────────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.storage.sync.set({ groqKey: key }, () => {
    savedMsg.textContent = "✓ Key saved";
    setTimeout(() => (savedMsg.textContent = ""), 2000);
  });
});

voiceToggle.addEventListener("click", () => {
  voiceOn = !voiceOn;
  voiceToggle.className = "toggle" + (voiceOn ? " on" : "");
  chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceOn });
});

mainBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    apiKeyInput.style.borderColor = "#ef4444";
    apiKeyInput.placeholder = "Groq API key required!";
    setTimeout(() => { apiKeyInput.style.borderColor = ""; apiKeyInput.placeholder = "gsk_..."; }, 2500);
    return;
  }

  getYouTubeTab(async (tab) => {
    if (!tab) {
      channelText.textContent = "⚠️ Open YouTube first!";
      return;
    }

    activeTabId = tab.id;

    // Save prefs
    chrome.storage.sync.set({ groqKey: key });
    chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceOn });

    if (!isRunning) {
      // FIX: Inject content script first if not already present (handles SPA navigation)
      channelText.textContent = "Initializing...";
      chrome.runtime.sendMessage({ type: "INJECT_IF_NEEDED", tabId: tab.id }, () => {
        // Small delay to let the script initialize
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { type: "START" }, (res) => {
            if (chrome.runtime.lastError) {
              channelText.textContent = "⚠️ Failed — refresh YouTube and try again";
              return;
            }
            if (res?.success) {
              isRunning = true;
              setStopUI();
              updateUI();
            }
          });
        }, 300);
      });
    } else {
      chrome.tabs.sendMessage(tab.id, { type: "STOP" }, (res) => {
        if (chrome.runtime.lastError) { return; }
        if (res?.success) {
          isRunning = false;
          setStartUI();
        }
      });
    }
  });
});

function setStopUI() {
  mainBtn.textContent = "⏹ Stop Fact-Checking";
  mainBtn.className   = "main-btn btn-stop";
}
function setStartUI() {
  mainBtn.textContent = "▶ Start Fact-Checking";
  mainBtn.className   = "main-btn btn-start";
}
