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
