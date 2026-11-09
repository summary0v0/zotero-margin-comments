$ErrorActionPreference = 'Stop'

$package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
$expectedName = "margin-comments-$($package.version).xpi"
$xpi = Get-ChildItem -Path 'build' -Filter $expectedName -Recurse -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $xpi) {
  throw "No versioned XPI named $expectedName found under build"
}

$entries = tar -tf $xpi.FullName
$normalized = $entries | ForEach-Object { $_ -replace '^\./', '' }
$manifestEntry = $entries |
  Where-Object { ($_ -replace '^\./', '') -eq 'manifest.json' } |
  Select-Object -First 1

if (-not $manifestEntry) { throw 'manifest.json is not at XPI root' }
if ($normalized -match '^addon/') { throw 'XPI contains an extra addon/ directory' }
if (-not ($normalized -contains 'content/scripts/margincomments.js')) {
  throw 'Bundled runtime script is missing'
}
if (-not ($normalized -contains 'content/icons/margin-comments.svg')) {
  throw 'Plugin icon is missing'
}
if (-not ($normalized -contains 'content/preferences.xhtml')) {
  throw 'Preference pane markup is missing'
}
if (-not ($normalized -contains 'content/preferences.css')) {
  throw 'Preference pane stylesheet is missing'
}
if (-not ($normalized -contains 'prefs.js')) {
  throw 'Default preferences are missing'
}
if (-not ($normalized -contains 'content/licenses/KaTeX.txt')) {
  throw 'Bundled math renderer license is missing'
}

$manifestText = tar -xOf $xpi.FullName $manifestEntry
$manifest = $manifestText | ConvertFrom-Json
if ($manifest.version -ne $package.version) {
  throw "Unexpected manifest version $($manifest.version)"
}
$zoteroCompatibility = $manifest.applications.zotero
if ($zoteroCompatibility.id -ne $package.config.addonID) {
  throw 'Packaged Zotero addon ID does not match package.json'
}
if ($zoteroCompatibility.strict_min_version -ne '9.0' -or
    $zoteroCompatibility.strict_max_version -ne '10.0.*') {
  throw 'Packaged compatibility must include Zotero 9.0 through 10.0.*'
}

$archivedXpi = Join-Path 'releases' $expectedName
if (-not (Test-Path -LiteralPath $archivedXpi -PathType Leaf)) {
  throw "Versioned archive is missing: $archivedXpi"
}
$buildHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $xpi.FullName).Hash
$archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivedXpi).Hash
if ($buildHash -ne $archiveHash) {
  throw "Archived XPI does not match the build artifact: $archivedXpi"
}

[pscustomobject]@{
  XPI = $xpi.FullName
  Archive = (Resolve-Path -LiteralPath $archivedXpi).Path
  Version = $manifest.version
  Zotero = "$($zoteroCompatibility.strict_min_version) - $($zoteroCompatibility.strict_max_version)"
  SHA256 = $buildHash
  Entries = $entries.Count
}
