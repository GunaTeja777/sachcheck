# PowerShell script to launch Chrome with the SachCheck extension loaded.

$extensionPath = Resolve-Path "$PSScriptRoot\sachcheck-v2"
if (-not (Test-Path $extensionPath)) {
    Write-Error "Extension folder not found at: $extensionPath"
    Exit
}

$paths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$chromePath = $null
foreach ($path in $paths) {
    if (Test-Path $path) {
        $chromePath = $path
        break
    }
}

if (-not $chromePath) {
    # Try registry lookup
    $regPath = Get-ItemProperty -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue
    if ($regPath -and $regPath.Path) {
        $chromePath = Join-Path $regPath.Path "chrome.exe"
    }
}

if ($chromePath -and (Test-Path $chromePath)) {
    Write-Host "Found Chrome at: $chromePath"
    Write-Host "Launching Chrome with SachCheck extension..."
    
    # Launch Chrome with the extension loaded
    Start-Process $chromePath -ArgumentList "--load-extension=""$extensionPath""", "https://www.youtube.com/results?search_query=republic+tv+live"
} else {
    Write-Error "Google Chrome could not be located in standard locations or registry."
    Write-Host "Please open Google Chrome manually, navigate to chrome://extensions, enable Developer Mode, and click 'Load unpacked', selecting: $extensionPath"
}
