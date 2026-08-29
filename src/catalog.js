'use strict';

// Known apps: Windows uninstall-registry DisplayName pattern -> GitHub repo.
// Used by "Scan this PC" to suggest installed apps that git-updater can manage.
// Patterns follow ninite-helper's Update-NiniteApps.ps1 catalog style.
// ponytail: flat list, grep-and-extend; a schema/registry is overkill.

const CATALOG = [
  // Web browsers
  { name: 'Brave', repo: 'brave/brave-browser', match: /Brave/i },
  // Media
  { name: 'Audacity', repo: 'audacity/audacity', match: /^Audacity/i },
  { name: 'HandBrake', repo: 'HandBrake/HandBrake', match: /^HandBrake/i },
  // Imaging
  { name: 'Paint.NET', repo: 'paintdotnet/release', match: /paint\.net/i },
  { name: 'Greenshot', repo: 'greenshot/greenshot', match: /Greenshot/i },
  { name: 'ShareX', repo: 'ShareX/ShareX', match: /ShareX/i },
  // File sharing
  { name: 'qBittorrent', repo: 'qbittorrent/qBittorrent', match: /qBittorrent/i },
  // Accessibility
  { name: 'NVDA', repo: 'nvaccess/nvda', match: /^NVDA\b|NonVisual Desktop/i },
  // Developer tools
  { name: 'Git', repo: 'git-for-windows/git', match: /^Git version|^Git\b.*\(64-bit\)/i },
  { name: 'Notepad++', repo: 'notepad-plus-plus/notepad-plus-plus', match: /Notepad\+\+/i },
  { name: 'WinMerge', repo: 'WinMerge/winmerge', match: /WinMerge/i },
  // Java (Eclipse Temurin / AdoptOpenJDK) — one repo per major version, JRE and JDK alike
  // \D* anchors to the FIRST number after the product name, so "21.0.5+11" can't
  // false-match the 11 entry via its build suffix.
  { name: 'Temurin 8', repo: 'adoptium/temurin8-binaries', match: /(Temurin|AdoptOpenJDK)\D*8(?!\d)/i },
  { name: 'Temurin 11', repo: 'adoptium/temurin11-binaries', match: /(Temurin|AdoptOpenJDK)\D*11(?!\d)/i },
  { name: 'Temurin 17', repo: 'adoptium/temurin17-binaries', match: /(Temurin|AdoptOpenJDK)\D*17(?!\d)/i },
  { name: 'Temurin 21', repo: 'adoptium/temurin21-binaries', match: /(Temurin|AdoptOpenJDK)\D*21(?!\d)/i },
  { name: 'Temurin 25', repo: 'adoptium/temurin25-binaries', match: /(Temurin|AdoptOpenJDK)\D*25(?!\d)/i },
  // Utilities
  { name: 'WinDirStat', repo: 'windirstat/windirstat', match: /WinDirStat/i },
  { name: 'Open-Shell', repo: 'Open-Shell/Open-Shell-Menu', match: /Open-Shell|Classic Shell/i },
  // Compression
  { name: '7-Zip', repo: 'ip7z/7zip', match: /^7-Zip/i },
  { name: 'PeaZip', repo: 'peazip/PeaZip', match: /PeaZip/i },
  // AI tools
  { name: 'OpenCode', repo: 'anomalyco/opencode', match: /^OpenCode\b/i },
  { name: 'Claude Code', repo: 'anthropics/claude-code', match: /^Claude Code\b/i },
  { name: 'Ollama', repo: 'ollama/ollama', match: /^Ollama\b/i },
  { name: 'ComfyUI', repo: 'Comfy-Org/ComfyUI', match: /ComfyUI/i },
  { name: 'CC Switch', repo: 'farion1231/cc-switch', match: /CC.?Switch/i },
  { name: 'OpenAI Codex', repo: 'openai/codex', match: /^Codex\b|OpenAI Codex/i },
  { name: 'MoneyPrinterTurbo', repo: 'harry0703/MoneyPrinterTurbo', match: /MoneyPrinterTurbo/i },
  { name: 'Pi', repo: 'earendil-works/pi', match: /^pi$/i },
  { name: 'Open Design', repo: 'nexu-io/open-design', match: /^Open Design\b/i },
  { name: 'OpenHands', repo: 'OpenHands/OpenHands', match: /OpenHands/i },
  { name: 'LobeHub', repo: 'lobehub/lobehub', match: /LobeHub/i },
  { name: 'GPT4All', repo: 'nomic-ai/gpt4all', match: /GPT4All/i },
  { name: 'Unsloth', repo: 'unslothai/unsloth', match: /Unsloth/i },
  { name: 'GPT Academic', repo: 'binary-husky/gpt_academic', match: /GPT.?Academic/i },
  // Media & downloaders
  { name: 'yt-dlp', repo: 'yt-dlp/yt-dlp', match: /^yt-dlp/i },
  { name: 'youtube-dl', repo: 'ytdl-org/youtube-dl', match: /^youtube-dl/i },
  { name: 'OBS Studio', repo: 'obsproject/obs-studio', match: /OBS Studio/i },
  // Networking & remote
  { name: 'Clash Verge Rev', repo: 'clash-verge-rev/clash-verge-rev', match: /Clash Verge/i },
  { name: 'RustDesk', repo: 'rustdesk/rustdesk', match: /RustDesk/i },
  { name: 'v2rayN', repo: '2dust/v2rayN', match: /v2rayN/i },
  { name: 'frp', repo: 'fatedier/frp', match: /^frp\b/i },
  { name: 'RTK', repo: 'rtk-ai/rtk', match: /^RTK\b/i },
  { name: 'Syncthing', repo: 'syncthing/syncthing', match: /^Syncthing\b/i },
  { name: 'LocalSend', repo: 'localsend/localsend', match: /LocalSend/i },
  { name: 'Caddy', repo: 'caddyserver/caddy', match: /^Caddy\b/i },
  { name: 'Netdata', repo: 'netdata/netdata', match: /Netdata/i },
  // Desktop apps & utilities
  { name: 'PowerToys', repo: 'microsoft/PowerToys', match: /PowerToys/i },
  { name: 'Windows Terminal', repo: 'microsoft/terminal', match: /Windows Terminal/i },
  { name: 'scrcpy', repo: 'Genymobile/scrcpy', match: /scrcpy/i },
  { name: 'Stirling PDF', repo: 'Stirling-Tools/Stirling-PDF', match: /Stirling.?PDF/i },
  { name: 'Ventoy', repo: 'ventoy/Ventoy', match: /Ventoy/i },
  { name: 'AppFlowy', repo: 'AppFlowy-IO/AppFlowy', match: /AppFlowy/i },
  { name: 'AFFiNE', repo: 'toeverything/AFFiNE', match: /AFFiNE/i },
  { name: 'Tabby', repo: 'Eugeny/tabby', match: /^Tabby\b/i },
  { name: 'OpenBB', repo: 'OpenBB-finance/OpenBB', match: /OpenBB/i },
  { name: 'World Monitor', repo: 'koala73/worldmonitor', match: /World.?Monitor/i },
  // Developer tools & runtimes
  { name: 'Godot', repo: 'godotengine/godot', match: /^Godot/i },
  { name: 'Neovim', repo: 'neovim/neovim', match: /^Neovim\b/i },
  { name: 'Zed', repo: 'zed-industries/zed', match: /^Zed\b/i },
  { name: 'Deno', repo: 'denoland/deno', match: /^Deno\b/i },
  { name: 'Bun', repo: 'oven-sh/bun', match: /^Bun$/i },
  { name: 'uv', repo: 'astral-sh/uv', match: /^uv$/i },
  { name: 'Hugo', repo: 'gohugoio/hugo', match: /^Hugo\b/i },
  { name: 'fzf', repo: 'junegunn/fzf', match: /^fzf\b/i },
  { name: 'lazygit', repo: 'jesseduffield/lazygit', match: /lazygit/i },
  { name: 'act', repo: 'nektos/act', match: /^act$/i },
  { name: 'Daytona', repo: 'daytonaio/daytona', match: /^Daytona\b/i },
  { name: 'Tailwind CSS CLI', repo: 'tailwindlabs/tailwindcss', match: /Tailwind/i },
  { name: 'Tesseract OCR', repo: 'tesseract-ocr/tesseract', match: /Tesseract/i },
  { name: 'CodeGraph', repo: 'colbymchenry/codegraph', match: /^CodeGraph\b/i },
  // AI tools (batch 51-100)
  { name: 'Open Interpreter', repo: 'openinterpreter/openinterpreter', match: /Open Interpreter/i },
  { name: 'Cline', repo: 'cline/cline', match: /^Cline\b/i },
  { name: 'gpt4free', repo: 'xtekky/gpt4free', match: /gpt4free/i },
  { name: 'AnythingLLM', repo: 'Mintplex-Labs/anything-llm', match: /AnythingLLM/i },
  { name: 'Daily Stock Analysis', repo: 'ZhuLinsen/daily_stock_analysis', match: /Daily Stock Analysis/i },
  { name: 'Strix', repo: 'usestrix/strix', match: /^Strix\b/i },
  { name: 'Orca', repo: 'stablyai/orca', match: /^Orca\b/i },
  { name: 'Faceswap', repo: 'deepfakes/faceswap', match: /Faceswap/i },
  { name: 'ChatGPT Desktop', repo: 'lencx/ChatGPT', match: /^ChatGPT$/i },
  { name: 'Goose', repo: 'aaif-goose/goose', match: /^Goose\b/i },
  { name: 'Voicebox', repo: 'jamiepine/voicebox', match: /^Voicebox\b/i },
  { name: 'Cherry Studio', repo: 'CherryHQ/cherry-studio', match: /Cherry Studio/i },
  { name: 'CLIProxyAPI', repo: 'router-for-me/CLIProxyAPI', match: /CLIProxyAPI/i },
  { name: 'Upscayl', repo: 'upscayl/upscayl', match: /Upscayl/i },
  { name: 'AIRI', repo: 'moeru-ai/airi', match: /^AIRI$/i },
  { name: 'Multica', repo: 'multica-ai/multica', match: /^Multica\b/i },
  { name: 'Text Generation WebUI', repo: 'oobabooga/textgen', match: /Text Generation WebUI/i },
  { name: 'whisper.cpp', repo: 'ggml-org/whisper.cpp', match: /whisper\.cpp/i },
  // Editors & docs
  { name: 'Atom', repo: 'atom/atom', match: /^Atom$/i },
  { name: 'MarkText', repo: 'marktext/marktext', match: /MarkText/i },
  { name: 'Joplin', repo: 'laurent22/joplin', match: /^Joplin\b/i },
  { name: 'draw.io Desktop', repo: 'jgraph/drawio-desktop', match: /draw\.io/i },
  { name: 'Typst', repo: 'typst/typst', match: /^Typst\b/i },
  { name: 'DBeaver', repo: 'dbeaver/dbeaver', match: /DBeaver/i },
  { name: 'ImHex', repo: 'WerWolv/ImHex', match: /ImHex/i },
  { name: 'Memos', repo: 'usememos/memos', match: /^Memos\b/i },
  // Terminals, shells & CLIs
  { name: 'Alacritty', repo: 'alacritty/alacritty', match: /Alacritty/i },
  { name: 'PowerShell', repo: 'PowerShell/PowerShell', match: /^PowerShell 7/i },
  { name: 'Starship', repo: 'starship/starship', match: /^Starship\b/i },
  { name: 'ripgrep', repo: 'BurntSushi/ripgrep', match: /ripgrep/i },
  { name: 'bat', repo: 'sharkdp/bat', match: /^bat$/i },
  { name: 'mkcert', repo: 'FiloSottile/mkcert', match: /^mkcert\b/i },
  { name: 'lazydocker', repo: 'jesseduffield/lazydocker', match: /lazydocker/i },
  { name: 'Dive', repo: 'wagoodman/dive', match: /^dive$/i },
  { name: 'Ruff', repo: 'astral-sh/ruff', match: /^Ruff\b/i },
  { name: 'NVM for Windows', repo: 'coreybutler/nvm-windows', match: /NVM for Windows/i },
  { name: 'Kotlin', repo: 'JetBrains/kotlin', match: /^Kotlin\b/i },
  // Servers & infrastructure
  { name: 'Prometheus', repo: 'prometheus/prometheus', match: /^Prometheus\b/i },
  { name: 'Traefik', repo: 'traefik/traefik', match: /Traefik/i },
  { name: 'PocketBase', repo: 'pocketbase/pocketbase', match: /PocketBase/i },
  { name: 'Meilisearch', repo: 'meilisearch/meilisearch', match: /Meilisearch/i },
  { name: 'Gitea', repo: 'go-gitea/gitea', match: /^Gitea\b/i },
  { name: 'Gogs', repo: 'gogs/gogs', match: /^Gogs\b/i },
  { name: 'etcd', repo: 'etcd-io/etcd', match: /^etcd\b/i },
  { name: 'rclone', repo: 'rclone/rclone', match: /^rclone\b/i },
  { name: 'AList', repo: 'AlistGo/alist', match: /^AList\b/i },
  // Desktop apps
  { name: 'Motrix', repo: 'agalwood/Motrix', match: /Motrix/i },
  { name: 'LX Music Desktop', repo: 'lyswhut/lx-music-desktop', match: /LX Music/i },
  { name: 'Spotube', repo: 'KRTirtho/spotube', match: /Spotube/i },
  { name: 'FlClash', repo: 'chen08209/FlClash', match: /FlClash/i },
];

// installed: [{DisplayName, DisplayVersion}]; trackedRepos: Set of "owner/repo" (lowercase).
// Returns [{name, repo, displayName, version, tracked}] — one row per catalog hit.
function matchInstalled(installed, trackedRepos) {
  const out = [];
  for (const entry of CATALOG) {
    const hit = (installed || []).find((e) => entry.match.test(e.DisplayName));
    if (!hit) continue;
    out.push({
      name: entry.name,
      repo: entry.repo,
      displayName: hit.DisplayName,
      version: hit.DisplayVersion || '',
      tracked: !!(trackedRepos && trackedRepos.has(entry.repo.toLowerCase())),
    });
  }
  return out;
}

module.exports = { CATALOG, matchInstalled };
