[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
if (-not $SourceDir) { $SourceDir = Join-Path $PSScriptRoot '..\src' }
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot '..\dist' }
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
function Get-Tags([string]$Tags) { ($Tags -split '\s*\|\s*' | Where-Object { $_ }) | ForEach-Object { "<li>$(HtmlEncode $_)</li>" } }

function Inline-Markdown([string]$Value) {
    $result = HtmlEncode $Value
    $result = [regex]::Replace($result, '`([^`]+)`', '<code>$1</code>')
    $result = [regex]::Replace($result, '\*\*([^*]+)\*\*', '<strong>$1</strong>')
    $result = [regex]::Replace($result, '\[([^\]]+)\]\(([^)]+)\)', '<a href="$2">$1</a>')
    return $result
}

function Render-Markdown([string]$Markdown) {
    $Markdown = [regex]::Replace($Markdown, '\[\[([^\]|]+)\|([^\]]+)\]\]', '$2')
    $Markdown = [regex]::Replace($Markdown, '\[\[([^\]]+)\]\]', '$1')
    $Markdown = (($Markdown -split "`r?`n" | Where-Object { $_ -notmatch 'LAT|Project_Experience|Assets/|E:\\|当前仓库' }) -join "`n")
    $sections = [regex]::Split($Markdown, '(?m)(?=^##\s+)')
    $Markdown = (($sections | Where-Object { $_ -notmatch '(?m)^##\s+(LAT|\u5173\u8054|\u9762\u8bd5\u8ffd\u95ee)' }) -join '')
    $Markdown = $Markdown -replace '(?m)^#\s+.+\r?\n?', ''
    $lines = $Markdown -split "`r?`n"
    $html = [System.Collections.Generic.List[string]]::new()
    $paragraph = [System.Collections.Generic.List[string]]::new()
    $inCode = $false
    $inList = $false
    $inOrderedList = $false
    $inTable = $false

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
            $html.Add("<h$level>$(Inline-Markdown $matches[2])</h$level>")
            continue
        }
        if ($line -match '^\s*[-*]\s+(.+)$') {
            Flush-Paragraph
            if ($inOrderedList) { $html.Add('</ol>'); $inOrderedList = $false }
            if (-not $inList) { $html.Add('<ul>'); $inList = $true }
            $html.Add("<li>$(Inline-Markdown $matches[1])</li>")
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
        $paragraph.Add($line.Trim())
    }
    Flush-Paragraph; Close-Lists; Close-Table
    if ($inCode) { $html.Add('</code></pre>') }
    return ($html -join "`n")
}

function Get-Header([string]$Active, [string]$Prefix = '') {
    $links = @(
        @{ Href = 'index.html'; Label = '&#39318;&#39029;'; Key = 'home' },
        @{ Href = 'portfolio.html'; Label = '&#20316;&#21697;&#38598;'; Key = 'portfolio' },
        @{ Href = 'notes.html'; Label = '&#23398;&#20064;&#31508;&#35760;'; Key = 'notes' },
        @{ Href = 'about.html'; Label = '&#20851;&#20110;&#25105;'; Key = 'about' }
    ) | ForEach-Object {
        $current = if ($_.Key -eq $Active) { ' aria-current="page"' } else { '' }
        "<a href=`"$Prefix$($_.Href)`"$current>$($_.Label)</a>"
    }
    @"
<header class="site-header"><div class="wrap header-inner"><a class="brand" href="${Prefix}index.html" aria-label="首页"><span class="brand-mark">/U</span><span>LIN<br>UNITY 程序员</span><small>玩法 / 工具 / 系统</small></a><nav class="nav" aria-label="主导航">$($links -join '')</nav></div></header>
"@
}

function New-Page([string]$Title, [string]$Active, [string]$Body, [string]$Prefix = '') {
@"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="LIN 的 Unity 程序员作品集，包含游戏玩法、工具开发和技术笔记。">
  <title>$Title | LIN / Unity 程序员</title>
  <link rel="stylesheet" href="${Prefix}styles.css">
</head>
<body>
$(Get-Header $Active $Prefix)
<main>$Body</main>
<footer class="site-footer"><div class="wrap footer-inner"><span>LIN / UNITY 程序员</span><span>专注游戏玩法、开发工具与清晰反馈。</span></div></footer>
</body>
</html>
"@
}

function Get-WorkCard($Work) {
@"
<article class="work-card"><img src="$(HtmlEncode $Work.image)" alt="$(HtmlEncode $Work.title) 项目图片" loading="lazy"><div class="work-card-body"><div class="meta"><span class="badge">$(HtmlEncode $Work.type)</span><span>$(HtmlEncode $Work.date)</span></div><h3>$(HtmlEncode $Work.title)</h3><p>$(HtmlEncode $Work.summary)</p><ul class="tag-list">$(Get-Tags $Work.tech)</ul></div></article>
"@
}

function Get-NoteRow($Note) {
@"
<article class="note-row"><div class="note-date">$(HtmlEncode $Note.date)</div><div><div class="note-meta">$(HtmlEncode $Note.category) / $(HtmlEncode $Note.reading_time)</div><h3><a href="notes/$($Note.slug).html">$(HtmlEncode $Note.title)</a></h3><p>$(HtmlEncode $Note.excerpt)</p></div><a class="text-link" href="notes/$($Note.slug).html">阅读文章 -&gt;</a></article>
"@
}

$works = @(Get-ContentItems (Join-Path $SourceDir 'content/works') | Sort-Object date -Descending)
$notes = @(Get-ContentItems (Join-Path $SourceDir 'content/notes') | Sort-Object date -Descending)
if (Test-Path $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '../public/*') -Destination $OutputDir -Recurse -Force

$featuredWorks = $works | Select-Object -First 3 | ForEach-Object { Get-WorkCard $_ }
$latestNotes = $notes | Select-Object -First 3 | ForEach-Object { Get-NoteRow $_ }
$homePage = @"
<section class="hero"><div class="hero-media"></div><div class="hero-grid"></div><div class="wrap hero-content"><div class="eyebrow">Unity 程序开发 / 构建交互系统</div><h1>&#35753;&#29609;&#27861;&#36923;&#36753;&#12289;&#24037;&#20855;&#19982;&#21453;&#39304;&#21327;&#21516;&#24037;&#20316;&#12290;</h1><p class="lede">&#19987;&#27880; Unity &#19982; C# &#24320;&#21457;&#65292;&#26500;&#24314;&#21487;&#38752;&#30340;&#28216;&#25103;&#26426;&#21046;&#12289;&#21046;&#20316;&#24037;&#20855;&#21644;&#21487;&#32500;&#25252;&#30340;&#39033;&#30446;&#26550;&#26500;&#12290;</p><div class="cta-row"><a class="button" href="portfolio.html">&#26597;&#30475;&#31934;&#36873;&#20316;&#21697;</a><a class="button secondary" href="notes.html">&#38405;&#35835;&#23398;&#20064;&#31508;&#35760;</a></div></div></section>
<section class="status-strip"><div class="wrap"><ul class="status-list"><li><span class="status-dot"></span><span>&#24403;&#21069;&#26041;&#21521;&#65306;Unity 6 / C# / URP</span></li><li><span class="status-dot"></span><span>&#20851;&#27880;&#39046;&#22495;&#65306;&#29609;&#27861;&#12289;&#24037;&#20855;&#19982;&#24615;&#33021;</span></li><li><span class="status-dot"></span><span>&#24037;&#20316;&#26041;&#24335;&#65306;&#23567;&#27493;&#39564;&#35777;&#65292;&#25345;&#32493;&#36845;&#20195;</span></li></ul></div></section>
<section class="section"><div class="wrap"><div class="section-head"><div><div class="eyebrow">精选项目</div><h2>&#31934;&#36873;&#20316;&#21697;</h2></div><a class="text-link" href="portfolio.html">&#20840;&#37096;&#20316;&#21697; -&gt;</a></div><div class="work-grid">$($featuredWorks -join '')</div></div></section>
<section class="section section-alt"><div class="wrap"><div class="section-head"><div><div class="eyebrow">技术笔记</div><h2>&#26368;&#26032;&#31508;&#35760;</h2></div><a class="text-link" href="notes.html">&#20840;&#37096;&#31508;&#35760; -&gt;</a></div><div class="notes-list">$($latestNotes -join '')</div></div></section>
"@

$portfolioItems = $works | ForEach-Object {
@"
<article class="portfolio-item"><img src="$(HtmlEncode $_.image)" alt="$(HtmlEncode $_.title) 项目图片" loading="lazy"><div class="portfolio-copy"><div class="meta"><span class="badge">$(HtmlEncode $_.type)</span><span>$(HtmlEncode $_.date)</span><span>$(HtmlEncode $_.status)</span></div><h2>$(HtmlEncode $_.title)</h2><p>$(HtmlEncode $_.summary)</p><p>$(HtmlEncode $_.Body)</p><div class="facts"><div class="fact"><strong>平台</strong><span>$(HtmlEncode $_.platform)</span></div><div class="fact"><strong>职责</strong><span>$(HtmlEncode $_.role)</span></div><div class="fact"><strong>重点</strong><span>$(HtmlEncode $_.highlight)</span></div></div></div></article>
"@
}

$portfolio = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">精选项目 / 2025-2026</div><h1>&#20316;&#21697;&#38598;</h1><p>&#22260;&#32469;&#29609;&#27861;&#25163;&#24863;&#12289;&#31995;&#32479;&#36793;&#30028;&#21644;&#24320;&#21457;&#25928;&#29575;&#26500;&#24314;&#30340; Unity &#39033;&#30446;&#19982;&#32534;&#36753;&#22120;&#24037;&#20855;&#12290;</p></div></section><section class="section"><div class="wrap"><div class="portfolio-list">$($portfolioItems -join '')</div></div></section>
"@

$allNotes = $notes | ForEach-Object { Get-NoteRow $_ }
$notesPage = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">技术笔记 / Unity 与 C#</div><h1>&#23398;&#20064;&#31508;&#35760;</h1><p>&#35760;&#24405;&#39033;&#30446;&#20013;&#39564;&#35777;&#36807;&#30340;&#20570;&#27861;&#12289;&#26550;&#26500;&#21462;&#33293;&#19982;&#35843;&#35797;&#36807;&#31243;&#12290;&#20869;&#23481;&#30001; Markdown &#25991;&#20214;&#29983;&#25104;&#65292;&#20415;&#20110;&#25345;&#32493;&#31215;&#32047;&#12290;</p></div></section><section class="section"><div class="wrap"><div class="notes-list">$($allNotes -join '')</div></div></section>
"@

$about = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">关于我 / 开发工作台</div><h1>&#20851;&#20110;&#25105;</h1><p>&#19968;&#21517;&#20851;&#27880;&#20132;&#20114;&#32454;&#33410;&#21644;&#24037;&#31243;&#21487;&#35835;&#24615;&#30340; Unity &#31243;&#24207;&#21592;&#12290;</p></div></section>
<section class="section"><div class="wrap about-layout"><div class="about-copy"><h2>&#25226;&#22797;&#26434;&#30340;&#31995;&#32479;&#20570;&#24471;&#28165;&#26224;&#12289;&#21487;&#36845;&#20195;&#12290;</h2><p>&#25105;&#20027;&#35201;&#20351;&#29992; Unity &#21644; C# &#36827;&#34892;&#29609;&#27861;&#12289;&#24037;&#20855;&#21644;&#39033;&#30446;&#26550;&#26500;&#24320;&#21457;&#12290;&#26085;&#24120;&#24037;&#20316;&#20250;&#20174;&#29609;&#23478;&#20307;&#39564;&#20986;&#21457;&#65292;&#36861;&#36394;&#27599;&#20010;&#36755;&#20837;&#12289;&#29366;&#24577;&#21644;&#21453;&#39304;&#22914;&#20309;&#36830;&#25509;&#21040;&#19968;&#36215;&#12290;</p><p>&#25105;&#21916;&#27426;&#22312;&#26089;&#26399;&#26126;&#30830;&#31995;&#32479;&#36793;&#30028;&#65292;&#29992;&#23567;&#22411;&#21487;&#27979;&#35797;&#30340;&#27169;&#22359;&#25215;&#36733;&#26680;&#24515;&#35268;&#21017;&#65292;&#20877;&#36890;&#36807;&#24037;&#20855;&#25226;&#37325;&#22797;&#24037;&#20316;&#20174;&#21046;&#20316;&#27969;&#31243;&#20013;&#31227;&#36208;&#12290;</p><h3>&#25216;&#26415;&#26632;</h3><div class="skill-board"><div><strong>玩法开发</strong><span>输入、状态、战斗与 AI 行为</span></div><div><strong>系统架构</strong><span>C#、事件与数据驱动系统</span></div><div><strong>开发工具</strong><span>UI Toolkit、自定义检查器与流程工具</span></div><div><strong>运行时</strong><span>URP、性能分析、加载与构建</span></div></div></div><aside class="terminal" aria-label="开发者资料"><div class="terminal-head">// 开发者资料</div><div><span class="key">方向</span>: <span class="value">Unity 玩法开发</span></div><div><span class="key">语言</span>: <span class="value">C#</span></div><div><span class="key">关注</span>: 工具、系统与性能</div><div><span class="key">状态</span>: 开放合作</div><div><span class="key">地点</span>: 中国 / 远程</div></aside></div></section>
"@

$notePages = [ordered]@{}
foreach ($note in $notes) {
    $articleBody = "<section class=`"page-intro note-intro`"><div class=`"wrap`"><div class=`"eyebrow`">$(HtmlEncode $note.category) / $(HtmlEncode $note.date)</div><h1>$(HtmlEncode $note.title)</h1><p>$(HtmlEncode $note.excerpt)</p></div></section><section class=`"section`"><div class=`"wrap article-layout`"><article class=`"article-body`">$(Render-Markdown $note.Body)</article><aside class=`"article-aside`"><div class=`"eyebrow`">文章信息</div><div><strong>阅读时长</strong><span>$(HtmlEncode $note.reading_time)</span></div><div><strong>分类</strong><span>$(HtmlEncode $note.category)</span></div><a class=`"text-link`" href=`"../notes.html`">&lt;- &#36820;&#22238;&#31508;&#35760;</a></aside></div></section>"
    $notePages["notes/$($note.slug).html"] = New-Page $note.title 'notes' $articleBody '../'
}

$pages = [ordered]@{
    'index.html' = (New-Page '首页' 'home' $homePage)
    'portfolio.html' = (New-Page '作品集' 'portfolio' $portfolio)
    'notes.html' = (New-Page '学习笔记' 'notes' $notesPage)
    'about.html' = (New-Page '关于我' 'about' $about)
}
foreach ($page in $pages.GetEnumerator()) {
    Set-Content -Path (Join-Path $OutputDir $page.Key) -Value $page.Value -Encoding utf8
}
foreach ($notePage in $notePages.GetEnumerator()) {
    $notePath = Join-Path $OutputDir $notePage.Key
    New-Item -ItemType Directory -Path (Split-Path $notePath) -Force | Out-Null
    Set-Content -Path $notePath -Value $notePage.Value -Encoding utf8
}

Write-Host "Built $($works.Count) works and $($notes.Count) notes to $OutputDir"

