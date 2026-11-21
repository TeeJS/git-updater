# Next round of programs

Programs to add to Popular apps in a later round. Add a line under "To add" for anything new;
the tables below are what was left over from the Ninite round (checked 2026-11-21).

## To add

- 

## Left over from the Ninite round

| Program | Where it stands | What it would take |
|---|---|---|
| FileZilla | Undecided. The download page hides its links (encrypted in the page, each link expires in about an hour). SHA-512 checksums are published. | A new source that decodes the page. About an hour, plus a Windows test. Can break when the page changes. |
| WhatsApp (Windows) | Microsoft Store only (Store ID `9NKSQGP7F2NH`). The Mac version is already in the list. | A Microsoft Store source, which git-updater does not have. |
| MusicBee | The vendor only links to mega.nz, MajorGeeks and the Microsoft Store. Its own site publishes the current version number but no installer. | A Microsoft Store source, or accepting a third-party mirror. |
| CDBurnerXP | Vendor site answers 403 on every page; its download host has a broken certificate. Last release 2019. | Nothing to do unless the site comes back. Its old `/msi/` folder would work with the existing vendor-site source. |
| CCCP | Project site offline since 2021. Last release 2015. | Nothing first-party exists. Probably drop. |
| Avast Free Antivirus | Skipped on request. Not in WinGet. | Not investigated. |
| AVG AntiVirus Free | Skipped on request. Not in WinGet on Windows; the Mac version is in the list. | Not investigated. |
| Avira Free Antivirus | Skipped on request. Not in WinGet. | Not investigated. |
| Spybot Search & Destroy 2 | Skipped on request. Not in WinGet (only Spybot Anti-Beacon is). | Not investigated. |

## Already listed but not installable on one platform

These rows were in the list before the Ninite round and fail to resolve where noted.

| Program | Platform | What the resolver says |
|---|---|---|
| Discord | Windows | WinGet declares no silent switches for its installer |
| Rufus | Windows | WinGet lists it as a bare portable .exe, a form not handled yet |
| Vivaldi | Mac | Homebrew listing has no usable build |
| Steam | Mac | Homebrew listing has no usable build |
| 7-Zip | Mac | The GitHub release has no Mac build |
| qBittorrent | Mac | The GitHub release has no Mac build |
| HandBrake | Linux | The GitHub release has no Linux build |
| Ollama | Linux | The GitHub release has no Linux build the picker accepts |
