[CmdletBinding()]
param(
    [string]$ObsidianRoot = 'E:\NoteAsProgrammer',
    [string]$SiteRoot,
    [string]$PublicRoot = 'E:\NoteAsProgrammer\50_Public'
)

$ErrorActionPreference = 'Stop'
if (-not $SiteRoot) { $SiteRoot = Join-Path $PSScriptRoot '..' }
$unityRoot = Join-Path $ObsidianRoot '15_Interview_DeepDive\Unity'
$siteNotes = Join-Path $SiteRoot 'src\content\notes'
$publicUnity = Join-Path $PublicRoot 'Unity'
New-Item -ItemType Directory -Force -Path $siteNotes,$publicUnity | Out-Null

$files = @(Get-ChildItem -LiteralPath $unityRoot -File | Sort-Object Name)
$sources = @(
    @{ Source = ($files | Where-Object Name -like 'Profiler*').FullName; Slug = 'profiler-diagnosis-loop'; Category = 'Unity 性能'; Reading = '9 分钟' },
    @{ Source = ($files | Where-Object Name -like 'UGUI*').FullName; Slug = 'ugui-canvas-performance'; Category = 'Unity 界面'; Reading = '8 分钟' },
    @{ Source = $files[4].FullName; Slug = 'object-pool-ownership'; Category = 'Unity 架构'; Reading = '9 分钟' }
)

foreach ($entry in $sources) {
    $raw = Get-Content -LiteralPath $entry.Source -Raw -Encoding utf8
    $match = [regex]::Match($raw, '(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)$')
    if (-not $match.Success) { throw "Missing front matter: $($entry.Source)" }
    $body = $match.Groups[2].Value
    $body = [regex]::Replace($body, '\[\[([^\]|]+)\|([^\]]+)\]\]', '$2')
    $body = [regex]::Replace($body, '\[\[([^\]]+)\]\]', '$1')
    $body = (($body -split "`r?`n" | Where-Object { $_ -notmatch 'LAT|Project_Experience|Assets/|E:\\|当前仓库' }) -join "`n")
    $sections = [regex]::Split($body, '(?m)(?=^##\s+)')
    $body = (($sections | Where-Object { $_ -notmatch '(?m)^##\s+(LAT|\u5173\u8054|\u9762\u8bd5\u8ffd\u95ee)' }) -join '')
    $titleMatch = [regex]::Match($body, '(?m)^#\s+(.+)$')
    if (-not $titleMatch.Success) { throw "Missing title: $($entry.Source)" }
    $title = $titleMatch.Groups[1].Value.Trim()
    $dateMatch = [regex]::Match($match.Groups[1].Value, '(?m)^last_reviewed:\s*(.+)$')
    $date = if ($dateMatch.Success) { $dateMatch.Groups[1].Value.Trim() } else { '2026-09-29' }
    $excerptMatch = [regex]::Match($body, '(?ms)^##\s+30.*?\r?\n\r?\n([^\r\n]+)')
    $excerpt = if ($excerptMatch.Success) { $excerptMatch.Groups[1].Value.Trim() } else { 'A practical Unity engineering note with explicit evidence and boundaries.' }
    $front = @"
---
slug: $($entry.Slug)
title: $title
date: $date
category: $($entry.Category)
reading_time: $($entry.Reading)
excerpt: $excerpt
---

"@
    $output = $front + $body.Trim() + "`n"
    Set-Content -LiteralPath (Join-Path $siteNotes "$($entry.Slug).md") -Value $output -Encoding utf8
    Set-Content -LiteralPath (Join-Path $publicUnity "$($entry.Slug).md") -Value $output -Encoding utf8
}

Write-Host "Imported $($sources.Count) public Unity notes."

