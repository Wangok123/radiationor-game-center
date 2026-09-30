[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$OutputDir,
    [string]$SiteUrl = $env:SITE_URL
)

$ErrorActionPreference = 'Stop'
if (-not $SourceDir) { $SourceDir = Join-Path $PSScriptRoot '..\src' }
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot '..\dist' }
if (-not $SiteUrl) { $SiteUrl = 'https://wangok123.github.io/lin-unity-workbench' }
$siteUri = $null
if (-not [uri]::TryCreate($SiteUrl, [UriKind]::Absolute, [ref]$siteUri) -or $siteUri.Scheme -notin @('https', 'http') -or $siteUri.Query -or $siteUri.Fragment) { throw 'SiteUrl must be an absolute HTTP(S) URL without query or fragment.' }
$SiteUrl = $SiteUrl.TrimEnd('/')
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

function Get-ContentItems {
    param([string]$Directory)
    Get-ChildItem -Path $Directory -Filter '*.md' -File | ForEach-Object {
            $raw = Get-Content -Path $_.FullName -Raw -Encoding utf8
        $match = [regex]::Match($raw, '(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)$')
        if (-not $match.Success) { throw "Missing front matter in $($_.FullName)" }
        $item = [ordered]@{ Body = $match.Groups[2].Value.Trim(); Slug = $_.BaseName }
        foreach ($line in ($match.Groups[1].Value -split "`r?`n")) {
            if ($line -match '^([^:]+):\s*(.*)$') { $item[$matches[1].Trim()] = $matches[2].Trim() }
        }
            if (-not $item.Contains('title') -and $item.Body -match '(?m)^#\s+(.+)$') { $item['title'] = $matches[1].Trim() }
            if (-not $item.Contains('date')) { $item['date'] = if ($item.Contains('last_reviewed')) { $item.last_reviewed } else { '2026-09-29' } }
            if (-not $item.Contains('category')) {
                $tagText = if ($item.Contains('tags')) { $item.tags } else { '' }
                if ($tagText -match 'Performance|Profiler|Optimization') { $item['category'] = 'Unity 性能' }
                elseif ($tagText -match 'UGUI|Canvas') { $item['category'] = 'Unity 界面' }
                elseif ($tagText -match 'ObjectPool|Lifecycle') { $item['category'] = 'Unity 架构' }
                else { $item['category'] = 'Unity 开发' }
            }
            if (-not $item.Contains('reading_time')) { $item['reading_time'] = '8 分钟' }
            if (-not $item.Contains('excerpt')) {
                $candidate = [regex]::Match($item.Body, '(?ms)^##\s+30.*?\r?\n\r?\n([^\r\n]+)')
                if (-not $candidate.Success) { $candidate = [regex]::Match($item.Body, '(?m)^(?!#|>|\||```|\s*$)(.+)$') }
                $item['excerpt'] = $candidate.Groups[1].Value.Trim()
            }
        [pscustomobject]$item
    }
}

function HtmlEncode([string]$Value) { [System.Net.WebUtility]::HtmlEncode($Value) }

function Normalize-Markdown([string]$Markdown) {
    return $Markdown.Trim()
}

function Inline-Markdown([string]$Value) {
    $result = HtmlEncode $Value
    $result = [regex]::Replace($result, '`([^`]+)`', '<code>$1</code>')
    $result = [regex]::Replace($result, '\*\*([^*]+)\*\*', '<strong>$1</strong>')
    $result = [regex]::Replace($result, '\[([^\]]+)\]\(([^)]+)\)', '<a href="$2">$1</a>')
    return $result
}

function Render-Markdown([string]$Markdown) {
    $Markdown = Normalize-Markdown $Markdown
    $Markdown = $Markdown -replace '(?m)^#\s+.+\r?\n?', ''
    $lines = $Markdown -split "`r?`n"
    $html = [System.Collections.Generic.List[string]]::new()
    $paragraph = [System.Collections.Generic.List[string]]::new()
    $inCode = $false
    $inList = $false
    $inOrderedList = $false
    $inTable = $false
    $headingIndex = 0

    function Flush-Paragraph {
        if ($paragraph.Count -gt 0) {
            $text = (($paragraph | ForEach-Object { (Inline-Markdown $_) }) -join ' ')
            $html.Add("<p>$text</p>")
            $paragraph.Clear()
        }
    }
    function Close-Lists {
        if ($inList) { $html.Add('</ul>'); Set-Variable -Name inList -Value $false -Scope 1 }
        if ($inOrderedList) { $html.Add('</ol>'); Set-Variable -Name inOrderedList -Value $false -Scope 1 }
    }
    function Close-Table {
        if ($inTable) { $html.Add('</tbody></table>'); Set-Variable -Name inTable -Value $false -Scope 1 }
    }

    foreach ($line in $lines) {
        if ($line -match '^\s*```') {
            Flush-Paragraph
            Close-Lists
            Close-Table
            if (-not $inCode) { $html.Add('<pre><code>'); $inCode = $true } else { $html.Add('</code></pre>'); $inCode = $false }
            continue
        }
        if ($inCode) { $html.Add((HtmlEncode $line)); continue }
        if ($line -match '^\s*\|(.+)\|\s*$') {
            Flush-Paragraph; Close-Lists
            $cells = $line.Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() }
            if (($cells -join '') -match '^[-: ]+$') { continue }
            if (-not $inTable) {
                $html.Add('<table><thead><tr>')
                foreach ($cell in $cells) { $html.Add("<th>$(Inline-Markdown $cell)</th>") }
                $html.Add('</tr></thead><tbody>')
                $inTable = $true
            } else {
                $html.Add('<tr>')
                foreach ($cell in $cells) { $html.Add("<td>$(Inline-Markdown $cell)</td>") }
                $html.Add('</tr>')
            }
            continue
        }
        Close-Table
        if ([string]::IsNullOrWhiteSpace($line)) { Flush-Paragraph; Close-Lists; continue }
        if ($line -match '^(#{1,3})\s+(.+)$') {
            Flush-Paragraph; Close-Lists
            $level = $matches[1].Length
            $id = ''
            if ($level -gt 1) {
                $headingIndex++
                $id = " id=`"section-$headingIndex`""
            }
            $html.Add("<h$level$id>$(Inline-Markdown $matches[2])</h$level>")
            continue
        }
        if ($line -match '^\s*[-*]\s+(.+)$') {
            Flush-Paragraph
            if ($inOrderedList) { $html.Add('</ol>'); $inOrderedList = $false }
            if (-not $inList) { $html.Add('<ul>'); $inList = $true }
            $listText = $matches[1]
            if ($listText -match '^\[([ xX])\]\s+(.+)$') {
                $status = if ($matches[1] -eq ' ') { '未完成' } else { '已完成' }
                $html.Add("<li class='task-item'><span class='task-status'>$status</span>$(Inline-Markdown $matches[2])</li>")
            } else {
                $html.Add("<li>$(Inline-Markdown $listText)</li>")
            }
            continue
        }
        if ($line -match '^\s*\d+\.\s+(.+)$') {
            Flush-Paragraph
            if ($inList) { $html.Add('</ul>'); $inList = $false }
            if (-not $inOrderedList) { $html.Add('<ol>'); $inOrderedList = $true }
            $html.Add("<li>$(Inline-Markdown $matches[1])</li>")
            continue
        }
        if ($line -match '^\s*>\s*(.*)$') {
            Flush-Paragraph; Close-Lists
            $html.Add("<blockquote>$(Inline-Markdown $matches[1])</blockquote>")
            continue
        }
        if ($line -match '^!\[([^\]]*)\]\(([^)]+)\)$') {
            Flush-Paragraph; Close-Lists
            $html.Add("<figure><img src='$(HtmlEncode $matches[2])' alt='$(HtmlEncode $matches[1])' loading='lazy' decoding='async'></figure>")
            continue
        }
        $paragraph.Add($line.Trim())
    }
    Flush-Paragraph; Close-Lists; Close-Table
    if ($inCode) { $html.Add('</code></pre>') }
    return ($html -join "`n")
}

function Get-ArticleToc([string]$Markdown) {
    $items = [System.Collections.Generic.List[string]]::new()
    $headingIndex = 0
    $inCode = $false
    foreach ($line in ((Normalize-Markdown $Markdown) -split "`r?`n")) {
        if ($line -match '^\s*```') { $inCode = -not $inCode; continue }
        if ($inCode) { continue }
        if ($line -match '^(#{2,3})\s+(.+)$') {
            $headingIndex++
            $level = $matches[1].Length
            $items.Add("<li class=`"toc-level-$level`"><a href=`"#section-$headingIndex`">$(Inline-Markdown $matches[2])</a></li>")
        }
    }
    if ($items.Count -eq 0) { return '' }
    return "<nav class=`"article-toc`" aria-label=`"文章目录`"><details class=`"toc-details`" open><summary>目录</summary><ol>$($items -join '')</ol></details></nav>"
}

function Get-Header([string]$Active, [string]$Prefix = '') {
    $links = @(
        @{ Href = 'index.html'; Label = '首页'; Key = 'home' },
        @{ Href = 'notes.html'; Label = '学习笔记'; Key = 'notes' },
        @{ Href = 'about.html'; Label = '关于我'; Key = 'about' }
    ) | ForEach-Object {
        $current = if ($_.Key -eq $Active) { " aria-current='page'" } else { '' }
        "<a href='$Prefix$($_.Href)'$current>$($_.Label)</a>"
    }
@"
<a class="skip-link" href="#main-content">跳到主要内容</a>
<header class="site-header"><div class="wrap header-inner"><a class="brand" href="$($Prefix)index.html" aria-label="LIN 首页"><span class="brand-mark" aria-hidden="true">/U</span><span>LIN<br>开发学习笔记</span></a><nav class="nav" aria-label="主导航">$($links -join '')</nav></div></header>
"@
}

function New-Page {
    param([string]$Title, [string]$Description, [string]$Path, [string]$Active, [string]$Body, [string]$Prefix = '', $Note)
    $canonical = "$SiteUrl/$Path"
    if ($Path -eq 'index.html') { $canonical = "$SiteUrl/" }
    $schema = [ordered]@{
        '@context' = 'https://schema.org'; '@type' = 'WebPage'
        name = $Title; description = $Description; url = $canonical; inLanguage = 'zh-CN'
        isPartOf = @{ '@type' = 'WebSite'; name = 'LIN / 开发学习笔记'; url = "$SiteUrl/" }
    }
    $extra = ''
    $person = @{ '@type' = 'Person'; name = 'LIN'; url = "$SiteUrl/about.html"; sameAs = @('https://github.com/Wangok123') }
    if ($Note) {
        $schema['@type'] = 'Article'; $schema['headline'] = $Title
        $schema['datePublished'] = "$($Note.date)T00:00:00+08:00"
        $schema['dateModified'] = "$($Note.updated)T00:00:00+08:00"
        $schema['author'] = $person; $schema['keywords'] = $Note.tags
        $extra = "<meta property='article:published_time' content='$($schema.datePublished)'><meta property='article:modified_time' content='$($schema.dateModified)'>"
    }
    if ($Path -eq 'about.html') { $schema['@type'] = 'ProfilePage'; $schema['mainEntity'] = $person }
    $json = ($schema | ConvertTo-Json -Compress -Depth 6).Replace('<', '\u003c')
    $robots = if ($Path -eq '404.html') { '<meta name="robots" content="noindex">' } else { '' }
    $preload = if ($Active -eq 'home') { '<link rel="preload" as="image" href="assets/workbench.webp" media="(min-width: 821px)"><link rel="preload" as="image" href="assets/workbench-small.webp" media="(max-width: 820px)">' } else { '' }
@"
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$(HtmlEncode $Title) | LIN / 开发学习笔记</title>
<meta name="description" content="$(HtmlEncode $Description)">
<link rel="canonical" href="$(HtmlEncode $canonical)">
<meta property="og:type" content="$(if ($Note) { 'article' } else { 'website' })">
<meta property="og:locale" content="zh_CN">
<meta property="og:site_name" content="LIN / 开发学习笔记">
<meta property="og:title" content="$(HtmlEncode $Title)">
<meta property="og:description" content="$(HtmlEncode $Description)">
<meta property="og:url" content="$(HtmlEncode $canonical)">
<meta property="og:image" content="$(HtmlEncode "$SiteUrl/assets/workbench.webp")">
<meta property="og:image:alt" content="游戏主题照片">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="$(HtmlEncode $Title)">
<meta name="twitter:description" content="$(HtmlEncode $Description)">
$extra$robots$preload
<link rel="alternate" type="application/rss+xml" title="LIN 的开发笔记" href="$($Prefix)feed.xml">
<link rel="icon" href="$($Prefix)favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="$($Prefix)styles.css">
<script type="application/ld+json">$json</script>
<script src="$($Prefix)site.js" defer></script>
</head>
<body>
$(Get-Header $Active $Prefix)
<main id="main-content" tabindex="-1">$Body</main>
<footer class="site-footer"><div class="wrap footer-inner"><span>LIN / 开发与计算机基础学习记录</span><nav aria-label="页脚"><a href="$($Prefix)feed.xml">RSS 订阅</a><a href="https://github.com/Wangok123">GitHub</a><a href="mailto:henryok123@163.com">联系我</a></nav></div></footer>
</body>
</html>
"@
}

function Get-NoteRow($Note) {
    $tags = ($Note.tags -split '\s*\|\s*' | ForEach-Object { "<li>$(HtmlEncode $_)</li>" }) -join ''
@"
<article class="note-row" data-category="$(HtmlEncode $Note.category)" data-tags="$(HtmlEncode $Note.tags)"><time class="note-date" datetime="$($Note.date)">$($Note.date)</time><div><div class="note-meta">$(HtmlEncode $Note.category) / $(HtmlEncode $Note.reading_time)</div><h3><a href="notes/$($Note.slug).html">$(HtmlEncode $Note.title)</a></h3><p>$(HtmlEncode $Note.summary)</p><ul class="tags">$tags</ul></div><a class="text-link" href="notes/$($Note.slug).html" aria-label="阅读：$(HtmlEncode $Note.title)">阅读文章 &rarr;</a></article>
"@
}

& (Join-Path $PSScriptRoot 'validate-content.ps1') -Directory (Join-Path $SourceDir 'content/notes')
$notes = @(Get-ContentItems (Join-Path $SourceDir 'content/notes') | Sort-Object @{ Expression = 'date'; Descending = $true }, Slug)
$slugs = @{}
foreach ($note in $notes) {
    if ($note.slug -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $slugs.ContainsKey($note.slug)) { throw "Invalid or duplicate slug: $($note.slug)" }
    $slugs[$note.slug] = $true
    foreach ($key in @('summary', 'tags', 'updated')) {
        if (-not $note.PSObject.Properties[$key]) {
            $value = switch ($key) { 'summary' { $note.excerpt } 'tags' { $note.category } 'updated' { $note.date } }
            $note | Add-Member -NotePropertyName $key -NotePropertyValue $value
        }
    }
    if ([string]::IsNullOrWhiteSpace($note.title) -or [string]::IsNullOrWhiteSpace($note.summary)) { throw "Missing title or summary: $($note.slug)" }
    foreach ($date in @($note.date, $note.updated)) {
        [datetime]::ParseExact($date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) | Out-Null
    }
}
# Cleanup is limited to the dedicated generated directory.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($OutputDir -ne (Join-Path $repoRoot 'dist')) { throw 'OutputDir must be the repository dist directory.' }
if (Test-Path $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '../public/*') -Destination $OutputDir -Recurse -Force

$latestNotes = $notes | Select-Object -First 3 | ForEach-Object { Get-NoteRow $_ }
$homePage = @"
<section class="hero"><div class="hero-media" aria-hidden="true"></div><div class="wrap hero-content"><div class="eyebrow">Unity / C# / 计算机基础</div><h1>LIN 的开发笔记</h1><p class="lede">记录玩法、工具、性能和计算机基础的学习过程。从一个具体问题出发，写下判断依据、思考过程和适用边界。</p><div class="cta-row"><a class="button" href="notes.html">阅读学习笔记</a><a class="button secondary" href="about.html">关于我</a></div></div></section>
<section class="status-strip"><div class="wrap"><ul class="status-list"><li><span class="status-dot" aria-hidden="true"></span>学习方向：Unity / C# / 计算机基础</li><li><span class="status-dot" aria-hidden="true"></span>关注：架构、性能与可靠性</li><li><span class="status-dot" aria-hidden="true"></span>已整理：$($notes.Count) 篇技术笔记</li></ul></div></section>
<section class="section"><div class="wrap"><div class="section-head"><div><div class="eyebrow">最近更新</div><h2>从问题开始</h2></div><a class="text-link" href="notes.html">全部笔记 &rarr;</a></div><div class="notes-list">$($latestNotes -join '')</div></div></section>
<section class="section section-alt"><div class="wrap"><div class="section-head"><h2>目前关注</h2></div><div class="principles"><div><h3>性能诊断</h3><p>区分工作与等待，理解采样环境和验证方法。</p></div><div><h3>系统边界</h3><p>梳理并发、网络、数据库和服务可靠性之间的约束。</p></div><div><h3>生命周期</h3><p>明确对象、资源与异步回调的所有权。</p></div></div></div></section>
"@
$options = @($notes.category | Sort-Object -Unique) | ForEach-Object { "<option>$(HtmlEncode $_)</option>" }
$notesBody = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">游戏开发与计算机基础</div><h1>学习笔记</h1><p>Unity、C#、算法、操作系统、网络、数据库与系统设计的学习整理。</p></div></section><section class="section"><div class="wrap"><form class="note-tools" role="search" hidden><label>搜索笔记<input id="note-search" type="search" placeholder="标题、摘要或标签" autocomplete="off"></label><label>分类<select id="note-category"><option value="">全部分类</option>$($options -join '')</select></label><p id="note-count" role="status" aria-live="polite"></p></form><div class="notes-list">$(( $notes | ForEach-Object { Get-NoteRow $_ }) -join '')</div><p id="no-results" hidden>没有找到匹配的笔记。</p></div></section>
"@
$about = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">关于我</div><h1>你好，我是 LIN</h1><p>学习 Unity、C# 和计算机基础，关注工程边界、性能诊断与可靠性。</p></div></section><section class="section"><div class="wrap about-layout"><div class="about-copy"><h2>把思考过程写下来</h2><p>这个网站是我的学习记录。我希望把技术概念整理成以后能查阅的笔记：遇到什么问题、有哪些选择，以及如何判断一个方案是否有效。</p><p>涉及性能、并发和平台行为的结论需要结合实际环境验证；有新的认识时，我会更新原文。</p><h3>学习方向</h3><div class="skill-board"><div><strong>Unity 与交互</strong><span>输入、状态和反馈</span></div><div><strong>C# 与架构</strong><span>所有权、事件与生命周期</span></div><div><strong>系统设计</strong><span>网络、数据库与可靠性</span></div><div><strong>性能诊断</strong><span>Profiler、内存与资源管理</span></div></div></div><aside class="terminal" aria-label="联系信息"><div class="terminal-head">// 保持联系</div><p><span class="key">GitHub</span><br><a href="https://github.com/Wangok123">Wangok123 &rarr;</a></p><p><span class="key">邮箱</span><br><a href="mailto:henryok123@163.com">henryok123@163.com</a></p><a href="feed.xml">RSS 订阅 &rarr;</a></aside></div></section>
"@
$notFound = '<section class="page-intro"><div class="wrap"><div class="eyebrow">404</div><h1>页面未找到</h1><p>这个地址不存在或已经移除。</p></div></section><section class="section"><div class="wrap"><a class="button" href="notes.html">浏览学习笔记</a></div></section>'
$basePath = ([uri]$SiteUrl).AbsolutePath.TrimEnd('/') + '/'
$pages = [ordered]@{
    'index.html' = (New-Page -Title 'LIN 的开发笔记' -Description 'LIN 的 Unity、C# 与计算机基础学习记录，整理性能、算法、网络、数据库和系统设计。' -Path 'index.html' -Active 'home' -Body $homePage)
    'notes.html' = (New-Page -Title '学习笔记' -Description '浏览 Unity、C#、算法、操作系统、网络、数据库与系统设计笔记，包含技术边界和参考资料。' -Path 'notes.html' -Active 'notes' -Body $notesBody)
    'about.html' = (New-Page -Title '关于 LIN' -Description 'LIN 的学习方向与联系方式：Unity、C#、游戏交互、编辑器工具和性能诊断。' -Path 'about.html' -Active 'about' -Body $about)
    '404.html' = (New-Page -Title '页面未找到' -Description '这个地址不存在，请浏览 LIN 的开发学习笔记。' -Path '404.html' -Body $notFound.Replace('href="notes.html"', "href='$($basePath)notes.html'") -Prefix $basePath)
}
for ($i = 0; $i -lt $notes.Count; $i++) {
    $note = $notes[$i]
    $adjacent = [System.Collections.Generic.List[string]]::new()
    if ($i -gt 0) { $n = $notes[$i - 1]; $adjacent.Add("<a rel='prev' href='$($n.slug).html'><span>上一篇</span>$(HtmlEncode $n.title)</a>") }
    if ($i -lt $notes.Count - 1) { $n = $notes[$i + 1]; $adjacent.Add("<a rel='next' href='$($n.slug).html'><span>下一篇</span>$(HtmlEncode $n.title)</a>") }
    $noteTags = @($note.tags -split '\s*\|\s*')
    $related = @($notes | Where-Object { $_.slug -ne $note.slug } | Sort-Object @{ Expression = {
        $score = if ($_.category -eq $note.category) { 3 } else { 0 }
        foreach ($tag in ($_.tags -split '\s*\|\s*')) { if ($tag -in $noteTags) { $score += 2 } }
        $score
    }; Descending = $true }, slug | Select-Object -First 3)
    $relatedHtml = ($related | ForEach-Object { "<li><a href='$($_.slug).html'>$(HtmlEncode $_.title)</a></li>" }) -join ''
    $body = @"
<section class="page-intro note-intro"><div class="wrap"><div class="eyebrow">$(HtmlEncode $note.category) / <time datetime="$($note.date)">$($note.date)</time></div><h1>$(HtmlEncode $note.title)</h1><p>$(HtmlEncode $note.summary)</p></div></section>
<section class="section"><div class="wrap article-layout"><aside class="article-aside">$(Get-ArticleToc $note.Body)<dl><div><dt>阅读时长</dt><dd>$(HtmlEncode $note.reading_time)</dd></div><div><dt>最后更新</dt><dd><time datetime="$($note.updated)">$($note.updated)</time></dd></div><div><dt>标签</dt><dd>$(HtmlEncode (($note.tags -split '\s*\|\s*') -join ' / '))</dd></div></dl><a class="text-link" href="../notes.html">&larr; 返回笔记</a></aside><article class="article-body">$(Render-Markdown $note.Body)<nav class="article-pagination" aria-label="相邻文章">$($adjacent -join '')</nav><div class="related-notes"><h2>继续阅读</h2><ul>$relatedHtml</ul></div><a class="text-link" href="#main-content">回到文章开头 &uarr;</a></article></div></section>
"@
    $pages["notes/$($note.slug).html"] = New-Page -Title $note.title -Description $note.summary -Path "notes/$($note.slug).html" -Active 'notes' -Body $body -Prefix '../' -Note $note
}
foreach ($page in $pages.GetEnumerator()) {
    $path = Join-Path $OutputDir $page.Key
    New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
    Set-Content -LiteralPath $path -Value $page.Value -Encoding utf8
}
function XmlEncode([string]$Text) { [System.Security.SecurityElement]::Escape($Text) }
$urls = @("<url><loc>$(XmlEncode "$SiteUrl/")</loc></url>", "<url><loc>$(XmlEncode "$SiteUrl/notes.html")</loc></url>", "<url><loc>$(XmlEncode "$SiteUrl/about.html")</loc></url>")
foreach ($note in $notes) { $urls += "<url><loc>$(XmlEncode "$SiteUrl/notes/$($note.slug).html")</loc><lastmod>$($note.updated)</lastmod></url>" }
Set-Content -LiteralPath (Join-Path $OutputDir 'sitemap.xml') -Value "<?xml version='1.0' encoding='UTF-8'?><urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>$($urls -join '')</urlset>" -Encoding utf8
Set-Content -LiteralPath (Join-Path $OutputDir 'robots.txt') -Value "User-agent: *$([Environment]::NewLine)Allow: /$([Environment]::NewLine)Sitemap: $SiteUrl/sitemap.xml" -Encoding utf8
$items = foreach ($note in $notes) {
    $url = XmlEncode "$SiteUrl/notes/$($note.slug).html"
    $pubDate = ([datetimeoffset]::ParseExact("$($note.date) +08:00", 'yyyy-MM-dd zzz', [Globalization.CultureInfo]::InvariantCulture)).UtcDateTime.ToString('r', [Globalization.CultureInfo]::InvariantCulture)
    "<item><title>$(XmlEncode $note.title)</title><link>$url</link><guid isPermaLink='true'>$url</guid><pubDate>$pubDate</pubDate><description>$(XmlEncode $note.summary)</description></item>"
}
$feed = "<?xml version='1.0' encoding='UTF-8'?><rss version='2.0' xmlns:atom='http://www.w3.org/2005/Atom'><channel><title>LIN / 开发学习笔记</title><link>$(XmlEncode "$SiteUrl/")</link><description>游戏开发与计算机基础学习记录</description><language>zh-CN</language><atom:link href='$(XmlEncode "$SiteUrl/feed.xml")' rel='self' type='application/rss+xml'/>$($items -join '')</channel></rss>"
Set-Content -LiteralPath (Join-Path $OutputDir 'feed.xml') -Value $feed -Encoding utf8
& (Join-Path $PSScriptRoot 'validate.ps1') -Directory $OutputDir -SiteUrl $SiteUrl
Write-Host "Built and validated $($notes.Count) notes to $OutputDir"
