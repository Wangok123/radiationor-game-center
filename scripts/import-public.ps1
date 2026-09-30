[CmdletBinding()]
param(
    [string]$ObsidianRoot = 'E:\NoteAsProgrammer',
    [string]$SiteRoot,
    [string]$PublicationDate = '2026-09-30'
)

$ErrorActionPreference = 'Stop'
if (-not $SiteRoot) { $SiteRoot = Join-Path $PSScriptRoot '..' }
[datetime]::ParseExact($PublicationDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'public-notes.json') -Raw -Encoding utf8 | ConvertFrom-Json
$notesRoot = Join-Path $SiteRoot 'src/content/notes'
$vaultRoot = [IO.Path]::GetFullPath($ObsidianRoot)
$vaultPublicRoot = Join-Path $vaultRoot '50_公开文章/网站文章'
$linkMap = @{}
foreach ($entry in $manifest.articles) { $linkMap[[IO.Path]::GetFileNameWithoutExtension($entry.source)] = @{ slug = $entry.slug; title = $entry.title } }
foreach ($entry in $manifest.existing) { $linkMap[$entry.sourceName] = @{ slug = $entry.slug; title = $entry.title } }

function Convert-ArticleBody([string]$Body) {
    $lines = [System.Collections.Generic.List[string]]::new(); $excluded = $false; $inCode = $false
    foreach ($line in ($Body -split '\r?\n')) {
        if (-not $inCode -and $line -match '^##\s+(.+)$') {
            $excluded = $matches[1] -match '面试|追问|闪卡|^关联$|实验|练习|最小验证'
            $line = $line -replace '^##\s+30\s*秒回答$', '## 核心结论'
        }
        if (-not $excluded) { $lines.Add($line) }
        if ($line -match '^\s*```') { $inCode = -not $inCode }
    }
    if ($inCode) { throw 'Unclosed code fence in source' }
    $body = $lines -join "`n"
    $body = (($body -split '\n\s*\n' | Where-Object { $_ -notmatch '\bLAT\b|Project_Experience|[A-Z]:\\|当前仓库|本页保持|本页应保持|本页状态|升级为\s*`verified`' }) -join "`n`n")
    $body = $body.Replace('Unity引擎.Object', 'UnityEngine.Object').Replace('Unity引擎 对象', 'Unity 引擎对象').Replace('Unity引擎', 'Unity')
    $body = $body.Replace('面试序列', '典型操作序列').Replace('面试结论', '简化结论')
    $body = [regex]::Replace($body, '\[\[([^\]|]+)(?:\|([^\]]+))?\]\]', {
        param($match)
        $target = ($match.Groups[1].Value -split '#', 2)[0]; $name = [IO.Path]::GetFileNameWithoutExtension($target)
        if ($linkMap.ContainsKey($name)) { $link = $linkMap[$name]; return "[$($link.title)]($($link.slug).html)" }
        return ''
    })
    $body = $body -replace '(?:详见|参见|见)\s*。', '相关资源与写入权限仍需由明确的生命周期协议管理。'
    $body = [regex]::Replace($body, '(?m)^##[^\n]+\n\s*(?=## |\z)', '')
    $body.Trim()
}

New-Item -ItemType Directory -Path $notesRoot -Force | Out-Null
foreach ($entry in $manifest.articles) {
    if ($entry.slug -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw "Invalid slug: $($entry.slug)" }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $vaultRoot $entry.source))
    if (-not $sourcePath.StartsWith($vaultRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Source outside vault' }
    $raw = Get-Content -LiteralPath $sourcePath -Raw -Encoding utf8
    $match = [regex]::Match($raw, '(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)$')
    if (-not $match.Success) { throw "Missing front matter: $($entry.source)" }
    $body = Convert-ArticleBody $match.Groups[2].Value
    foreach ($edit in $entry.edits) {
        if (-not $body.Contains($edit.from)) { throw "Editorial replacement missing: $($entry.slug)" }
        $body = $body.Replace($edit.from, $edit.to)
    }
    $body = [regex]::Replace($body, '(?m)^(\|[^\n]+\|)\n\|[ :|\-]+\|$', {
        param($table)
        $header = $table.Groups[1].Value
        $columns = $header.Trim('|').Split('|').Count
        $header + "`n| " + ((1..$columns | ForEach-Object { '---' }) -join ' | ') + ' |'
    })
    $body = [regex]::Replace($body, '(?m)^#\s+.+$', "# $($entry.title)")
    $references = @([regex]::Matches($match.Groups[1].Value, '(?m)^\s+-\s+(https?://\S+)') | ForEach-Object { $_.Groups[1].Value })
    if ($references.Count -eq 0) { throw "Missing references: $($entry.slug)" }
    $body += "`n`n## 参考资料`n`n" + (($references | ForEach-Object { $referenceUri = [uri]$_; $label = ($referenceUri.Host + $referenceUri.AbsolutePath).TrimEnd('/'); "- [$label]($_)" }) -join "`n")
    $body = [regex]::Replace($body, '(?m)^(# .+)\n', { param($m) $m.Groups[1].Value + "`n`n> 本文为学习笔记整理。示例用于说明概念，性能、版本兼容与平台行为需结合实际环境验证。`n" })
    if ($body -match '\[\[|\bLAT\b|[A-Z]:\\|面试|本页保持|Unity引擎|^##.*实验') { throw "Unreviewed content: $($entry.slug)" }
    $words = [regex]::Matches($body, '[\p{IsCJKUnifiedIdeographs}]|[a-zA-Z0-9_]+').Count; $reading = [math]::Max(3, [math]::Ceiling($words / 450))
    $destination = Join-Path $notesRoot "$($entry.slug).md"; $date = $PublicationDate
    if (Test-Path -LiteralPath $destination) { $originalDate = [regex]::Match((Get-Content -LiteralPath $destination -Raw -Encoding utf8), '(?m)^date: (\d{4}-\d{2}-\d{2})$'); if ($originalDate.Success) { $date = $originalDate.Groups[1].Value } }
    $output = @"
---
slug: $($entry.slug)
title: $($entry.title)
date: $date
updated: $PublicationDate
category: $($entry.category)
reading_time: $reading 分钟
tags: $($entry.tags -join ' | ')
summary: $($entry.summary)
---

$body
"@
    [IO.File]::WriteAllText($destination, $output.TrimEnd() + "`n", [Text.UTF8Encoding]::new($false))
    $publicCategory = Join-Path $vaultPublicRoot $entry.category
    New-Item -ItemType Directory -Path $publicCategory -Force | Out-Null
    $vaultOutput = [regex]::Replace($output, '\]\(([a-z0-9-]+)\.html\)', '](' + $manifest.siteUrl + '/notes/$1.html)')
    [IO.File]::WriteAllText((Join-Path $publicCategory "$($entry.slug).md"), $vaultOutput.TrimEnd() + "`n", [Text.UTF8Encoding]::new($false))
}
Write-Host "Imported $($manifest.articles.Count) curated articles; source vault and existing articles preserved."
